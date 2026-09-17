# BOO integration — operator runbook (2026-09-16)

Everything below was prepared on branch `claude/booo-integration-accounting-risk-s1fivp`.
**Nothing in this runbook has been executed against live trading.** The final
LIVE activation and every order-placing step are deliberately left to the
account owner or a designated operator.

Observation time for every "current state" figure here:
**2026-09-16 13:01–13:35 UTC (22:01–22:35 KST)**, read from the Supabase
project `etaajwpernzrcdrifdnw` and from the GitHub repository at commit
`9fe42b350a2916a5473b038ba2cda23aff8fcc4c`.

---

## 0. The one thing to read first

The live bot is **not idle**. At the observation time:

| field | value | meaning |
|---|---|---|
| `trading_settings.mode` | `LIVE_LIMITED` | live trading mode |
| `trading_settings.pause_new_entries` | `false` | entries are not paused |
| `v11_long_regime_runtime.live_enabled` | `true` | runtime is live |
| `v11_long_regime_runtime.circuit_open` | `false` | no circuit break |
| `v11_long_regime_runtime.entry_block_reason` | `ENTRY_MARGIN_INSUFFICIENT:38.3699:40.0297` | **the only thing stopping entries is the balance** |
| `trading_settings.risk_per_trade_pct` | `100` | per-trade risk reads as 100% of equity |
| `trading_settings.max_consecutive_losses` | `1000000` | effectively no streak limit |
| `binance_futures_allocation_usdt` / `leverage` | `40` / `3` | fixed 40 USDT margin, 120 USDT notional |

Read together: the executor is live, and it stopped opening positions only
because equity (38.37 USDT) fell below the fixed 40.03 USDT margin one entry
costs. **A deposit of a few USDT resumes automated entry at the old sizing,
with no validated edge behind it.** That is the single highest-risk fact found
in this work.

---

## 1. What changed, and where

Branch: `claude/booo-integration-accounting-risk-s1fivp`

| Area | Path |
|---|---|
| Exact decimal arithmetic | `supabase/functions/_shared/boo/decimal.mjs` |
| Risk limits / settings normalisation | `supabase/functions/_shared/boo/risk-policy.mjs` |
| Position sizing under a loss budget | `supabase/functions/_shared/boo/risk-budget.mjs` |
| Single common entry gate | `supabase/functions/_shared/boo/entry-gate.mjs` |
| R1 strategy (pure) | `supabase/functions/_shared/boo/r1-strategy.mjs` |
| Order dispatch safety, risk reservation | `supabase/functions/_shared/boo/order-safety.mjs` |
| Protection decisions | `supabase/functions/_shared/boo/protection.mjs` |
| Ledger reconstruction / reconciliation | `supabase/functions/_shared/boo/reconcile.mjs` |
| Regression tests (section 9, items 1–30) | `supabase/functions/_shared/boo/boo-safety.test.ts` |
| Executor binding (the actual integration) | `supabase/functions/v10-lane-executor/boo-entry-adapter.mjs` |
| Executor call sites | `supabase/functions/v10-lane-executor/index.ts` |
| SHADOW function | `supabase/functions/boo-r1-shadow/index.ts` |
| SHADOW deploy bundle + builder | `dist/boo-r1-shadow.bundle.ts`, `scripts/boo/bundle-shadow.mjs` |
| Reconciliation script | `scripts/boo/accounting-recon.mjs` |
| Futures sweep prioritisation (sync fix) | `supabase/functions/exchange-trade-sync/futures-sync.ts`, `index.ts` |
| Sweep regression tests | `supabase/functions/exchange-trade-sync/futures-priority.test.ts` |
| LIVE_READY preflight rule (pure) | `supabase/functions/_shared/boo/preflight.mjs` |
| Preflight property tests | `supabase/functions/_shared/boo/preflight.test.ts` |
| Activation tool | `scripts/boo/activate.mjs` |
| Evaluation / promotion rule | `supabase/functions/_shared/boo/evaluation.mjs` |
| Evaluation tests | `supabase/functions/_shared/boo/evaluation.test.ts` |
| SHADOW evaluator CLI | `scripts/boo/evaluate-shadow.mjs` |
| Migration | `supabase/migrations/20260916_boo_entry_gate_risk_shadow.sql` |

Run the tests:

```bash
deno task test        # the repo suite now includes the BOO and sweep tests
deno test --allow-read \
  supabase/functions/_shared/*.test.ts \
  supabase/functions/_shared/boo/*.test.ts \
  supabase/functions/exchange-trade-sync/*.test.ts
# 186 passed | 0 failed
```

Breakdown: 67 safety/regression (section 9 items 1-30), 7 preflight property
(including a 2^8 enumeration proving no failure subset yields live_ready),
13 evaluation/promotion, 11 futures-sweep prioritisation, plus the pre-existing
shared-module suite.

---

## 2. Deployment boundary (verified)

- `.github/workflows/main.deploy-supabase.yml` deploys **only on push to `main`**.
- `deploy-binance-gateway.yml` / `deploy-order-gateway.yml` deploy the order
  gateway **only on push to `main`** under `gateway/**`.
- Executor releases (`deploy-executor-*.yml`, `deploy-v24-entry-gate-*.yml`) are
  `workflow_dispatch` only and pin `expected_version_before`.

So pushing this branch cannot deploy anything. The executor change is **not
deployed**: production still runs `v10-lane-executor` **version 47**,
`ezbr_sha256 7575268e27e9b77c9ff463d8608c831d480203bc7bc05f3c3de97b7e5d17b6be`.

What **has** been applied to the live project (additive only, no live table
altered, no order placed):

| Object | Status |
|---|---|
| `boo_*` tables (migration PART A) | applied |
| `boo_shadow_setups.last_bar_close_time` | applied |
| `boo_ledger_exceptions` rows for the 3 unreconciled positions | inserted |
| Edge Function `boo-r1-shadow` | deployed, version 3, `verify_jwt=true` |
| Edge Function `boo-market-probe` (read-only diagnostic) | deployed, version 1 |
| cron `boo-r1-shadow-20260916` (jobid 80, every minute) | scheduled |

Migration **PART B** (nullable columns on `trading_settings` and
`v11_long_regime_runtime`) is written but **deliberately not applied** — it
touches tables the live executor reads every minute, so it belongs to the
operator's cutover, not to this work.

---

## 3. Accounting — what the numbers actually say

Window: `entry_at >= 2026-09-12T15:00:00Z`, `closed_at < 2026-09-16T11:00:00Z`,
`state = CLOSED`. Tolerance **declared before looking**: `1e-8` USDT per
position, absolute (not relative).

Reproduced from primary tables, matching the earlier audit exactly:

| metric | value |
|---|---|
| closed positions | 122 (43 win / 79 loss) |
| position settled P&L | −67.64941327 USDT |
| linked fills | 602 |
| fill realised P&L | −45.59628473 USDT |
| fill fees | 14.04865834 USDT |
| fill net | −59.64494307 USDT |
| **position − fill net** | **−8.00447020 USDT** |

### Where the −8.00447020 lives

| group | amount | finding |
|---|---|---|
| 哈基米USDT | −4.49312564 | 3 BUY fills (3240), **0 SELL fills** |
| ARKUSDT | −1.85078715 | 1 BUY fill (779), **0 SELL fills** |
| CVCUSDT | −1.66055724 | **0 fills at all** |
| subtotal (3 positions) | **−8.00447003** | exit fills never ingested |
| remaining 119 positions | **−0.000000169999934** | float64 noise, max single 2.99999876e-8 |

The 119-position residual is **not** money. `realized_pnl_usdt` was written from
JavaScript doubles, so each stored value is the float64 neighbour of the true
decimal; summing 119 of them leaves ~1.7e-7. It is reported, not absorbed — and
its largest single element (3e-8) is **above** the declared 1e-8 tolerance, so
it is flagged rather than waved through.

### Why the 3 positions cannot be fixed from the database

There are **no orphan fills** to re-link: the rows do not exist. This is a
collection failure, not an attribution failure. The earlier report that stored
receipts "explain most of the difference" is true only in the sense that a
summary number exists; the individual fills do not, so the positions stay
`UNRESOLVED`.

### The root cause (this is the defect worth fixing)

`exchange-trade-sync` runs every minute and `cron.job_run_details` shows
**120/120 succeeded in the last 2 hours**. Yet:

- 162 markets have sync state; only **141 were synced in the last 10 minutes**;
  **12 have not synced in over 6 hours** (oldest: `POWRUSDT`, 2026-09-13 15:38Z).
- `哈基米USDT` last synced **2026-09-15 05:01:13Z**; its position closed at
  **05:06:46Z** — after the last sync, and it has not synced since.
- `ARKUSDT` last synced **2026-09-16 02:01:07Z**; its position closed at
  **02:06:14Z**.
- `CVCUSDT` has **no `exchange_trade_sync_state` row at all**.

`syncFuturesTrades` iterates the whole market universe sequentially inside one
invocation, with no prioritisation. As the universe grew to 162 markets the tail
starves, and per-market failures are collected into an `errors[]` array while the
function still returns success — so the cron reports green over a ledger that is
silently losing exit fills. Sync state timestamps cluster in single seconds
(11:50:25, :26, :26), which is the signature of a loop being cut off rather than
of individual failures.

**Fix implemented (in the repository, NOT deployed).** `prioritizeFuturesMarkets()`
in `futures-sync.ts` orders the sweep by need and marks the mandatory tiers:

| tier | contents | required? |
|---|---|---|
| 0 EXPOSURE | the exchange says we hold it right now | yes |
| 1 SETTLEMENT | position closed at/after this market's last sync, position not closed in our books, unsettled order, or **never synced at all** | yes |
| 2 TAIL | everything else, oldest-sync-first, bounded to the invocation budget | no |

Required tiers are never truncated to fit the budget — dropping a required
market to make room for a routine refresh is the exact trade that produced the
missing fills. A failure on a required market now **throws**
(`FUTURES_REQUIRED_MARKETS_UNSYNCED:<markets>`) instead of being collected into
`errors[]` under a successful return, so a ledger gap is visible the minute it
opens rather than days later in an audit.

**Validated against the real database.** Applying the rule to the full live
history marks exactly three markets as required — `ARKUSDT` and `哈基米USDT`
(`CLOSED_AFTER_LAST_SYNC`) and `CVCUSDT` (`NEVER_SYNCED`) — which are precisely
the three positions holding the −8.00447003 USDT. Zero false positives.

The spot path in the same function already had this shape (urgent → unsynced →
oldest-first, bounded); the futures path never received it. This closes that gap.

Deploying it is an operator step: `exchange-trade-sync` is a live function, and
the change makes it fail loudly where it previously failed silently, so expect
red runs until the three stale markets are collected.

Re-run the reconciliation yourself:

```bash
SUPABASE_URL=https://etaajwpernzrcdrifdnw.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<key> \
node scripts/boo/accounting-recon.mjs \
  --from 2026-09-12T15:00:00Z --to 2026-09-16T11:00:00Z --json /tmp/recon.json
# exits non-zero while the ledger is unreconciled
```

Outstanding items are durable in `public.boo_ledger_exceptions`. A row is
resolved **only** by re-fetching `GET /fapi/v1/userTrades` for the affected
symbol/time range through the authenticated gateway — which needs credentials
this work did not use.

---

## 4. Risk limits now enforced

`resolveRiskPolicy` converts `*_pct` columns to fractions by dividing by 100,
**unconditionally** — never guessing the unit from magnitude — then checks
plausibility on the converted value. Against the live row:

```
risk_per_trade_pct = 100  ->  1.0 of equity per trade  ->  RISK_PER_TRADE_IMPLAUSIBLE (refused)
max_daily_loss_pct = 30   ->  0.30 of equity per day   ->  DAILY_LOSS_LIMIT_IMPLAUSIBLE (refused)
```

Both are treated as configuration errors. The policy refuses to produce a
usable config, and the gate refuses entry. The protective defaults
(`risk_per_trade_frac 0.0025`, `max_total_open_risk_frac 0.005`,
`max_gross_notional_to_equity 1.0`, `max_concurrent_positions 1`,
`daily_loss_limit_frac 0.01`, `weekly_loss_limit_frac 0.03`,
`recovery_high_water_drawdown_frac 0.05`, `max_consecutive_losses 3`) are
**ceilings**: a DB value may make any of them stricter, never looser.

The fixed 40/120 path is replaced for the new entry route by `solveQuantity`,
which derives quantity from the loss budget using depth-walked VWAPs at each
candidate size, searches the step lattice, and re-verifies the winner at its own
size. When the exchange minimum already breaks the budget it returns
`decision=SKIP, reason=MIN_NOTIONAL_EXCEEDS_RISK_BUDGET` — never a rounded-up
quantity, a tightened stop, or a raised limit.

### Risk reservation is atomic, and verified

`boo_reserve_risk()` / `boo_release_risk()` perform the whole compare-and-set
inside one statement under a row lock. Doing it in application code is the bug it
prevents: read-then-write from two executor invocations interleaves and both see
the same "available" figure.

Verified against the live database on 2026-09-16:

| scenario | result |
|---|---|
| budget 100, two workers request 80 | exactly one `RESERVED`, other `INSUFFICIENT_RISK_BUDGET` |
| winner retries the same intent | `ALREADY_RESERVED` — idempotent, not a second charge |
| stale fencing token (0 vs held 1) | `FENCED_OUT` at the shared resource |
| unproven outcome released | `OUTCOME_UNPROVEN`, row → `UNKNOWN`, **budget still held** |
| proven outcome released | `RELEASED`, budget freed |

`UNKNOWN` reservations count toward outstanding risk, so a lost response cannot
silently free budget that may be live on the exchange. The test rows were deleted
afterwards; the table holds no synthetic reservations.

> The legacy `sizeEntry()` constant (`MARGIN=40,LEV=3`) is still present in
> `index.ts` and still used by the legacy code path. It is *gated*, not deleted:
> removing it would rewrite the exit/management path for positions already open
> under it, which section 7 forbids. It becomes unreachable for new entries once
> the gate is enforced.

---

## 5. The common entry gate

Every new entry must satisfy all seven, evaluated **twice** — at admission and
again immediately before dispatch (`booGate(...)` at both call sites in
`openBull`):

```
strategy_eligible AND validation_approved AND data_healthy AND
cost_acceptable AND risk_budget_available AND execution_ready AND
trading_authorized
```

Fail-closed properties, each covered by a test:

- a missing/unreadable input **blocks**; `undefined` never means "fine";
- a disabled filter reports `UNPROVEN`, which blocks;
- `validation_approved` cannot be satisfied by a boolean. The live executor's
  `OPERATOR_OVERRIDE` object (`parametersValidatedByBacktest: false`,
  `basis: "OPERATOR_OVERRIDE_UNVALIDATED"`) is refused with
  `VALIDATION_BOOLEAN_ONLY`;
- a hand-entered `expectedEdgeBps` is refused (`VALIDATION_EDGE_MANUALLY_ENTERED`);
- the approval's code/parameter/dataset hashes and cost/execution model versions
  must equal the running ones, and it must carry a real evaluated
  `netExpectancyLowerBound > 0`, a named approver, and an unexpired validity;
- `V24_operator_control.entry_enabled` is currently `false` with an
  **assumed** edge of 11 bps — `cost_acceptable` refuses `source: ASSUMED`.

**Deploying the executor build therefore stops new entries** until an operator
inserts a matching `boo_strategy_approvals` row. That is the intended behaviour
for an unvalidated policy, not a bug — but it is a real operational change, so
deploy it deliberately. `boo_entry_gate_control.enforcement = 'OBSERVE'` records
verdicts without blocking, so the impact can be measured first.

Exits, protection, reconciliation and settlement are untouched by the gate and
keep running regardless of the entry verdict.

---

## 5b. Evaluation and promotion

`evaluation.mjs` implements the section 8 promotion rule, and
`scripts/boo/evaluate-shadow.mjs` runs it over collected SHADOW trades:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/boo/evaluate-shadow.mjs --json /tmp/eval.json
# exits non-zero unless the verdict is PROMOTE
```

Two properties are enforced by test, not by convention:

- **Sample adequacy is checked before the point estimate**, so a thin but
  flattering sample cannot be promoted on the strength of its mean. Minimum 30
  trades over 5 independent days; below that the verdict is
  `INSUFFICIENT_SAMPLE`, which is not a pass.
- **Uncertainty is bootstrapped over day blocks, not trades.** Trades on one day
  share a market shock; treating them as independent shrinks the interval until
  almost anything looks significant. A test constructs 59 small losses plus one
  huge winning day — the mean is positive, and the rule still returns `REJECT`.

`compareVariants()` produces the A–E table when the inputs exist, and refuses to
present variants that span different cost models, risk bases or candidate sets as
comparable. Today it has nothing to compare (see §9).

## 6. SHADOW — what is actually running

`boo-r1-shadow` v3, cron `boo-r1-shadow-20260916` (jobid 80), every minute.

Verified from `boo_shadow_runs` / `boo_shadow_decisions`:

| check | result |
|---|---|
| market data arriving | yes — 528 tradable USDT perpetuals from `exchangeInfo` |
| candidate ranking updating | yes — 10 ranked, top `day_change=+0.125828` |
| setup state progressing | yes — `IMPULSE_CONFIRMED` recorded |
| refusals explained | yes — `CLOSE_BELOW_EMA20` ×5, `HIGHER_LOWS_BROKEN`, `NO_CHANGE` ×3 |
| simulated fills priced after the signal | yes — depth fetched after the trigger check |
| duplicate setup blocked | enforced via `boo_shadow_setups.entered_at` + `CONSUMED` |
| restart-safe | setup state persisted per `setup_id`, incl. `last_bar_close_time` |
| order permission | **none** — run reports `order_capability=NONE_DECLARED`, `visibleSecretNames=[]` |

Two real bugs were found by running it, not by reading it:

1. **900×1m bars = 15 hours**, but the KST day open can be 24h+ back, so every
   candidate was excluded as `KST_DAY_OPEN_MISSING`. Fixed to 1500.
2. **`asOf` was captured before the fetch loop**, so every bar's `availableAt`
   was later than `asOf` and the no-lookahead guard discarded all of them — the
   guard working correctly against a wrong clock. Fixed to sample the ranking
   clock after collection.

A third correctness issue was fixed before it could bite: polling every minute
re-read the same closed 5m bar, so one bar could drive several state
transitions. `lastBarCloseTime` now makes the machine a function of the bar
series rather than of the polling rate.

### Isolation — honest statement

The run reports `visibleSecretNames: []`, i.e. no gateway URL or signing secret
is in this function's environment, and the source contains no gateway client, no
HMAC signing and no order action. **However**, that is a property of this
function's source and current secret configuration, not a permission boundary:
Supabase functions in one project share the project's secret store. A genuine
boundary requires a separate project or host. This is listed as a LIVE_READY
blocker below rather than treated as solved.

---

## 7. Operator procedure

> Do not start until §8 shows no blockers. The activation tooling is built to
> fail while validation is missing — that is intentional and must not be
> bypassed with an environment variable.

### 7.1 Exact commit and configuration to apply

```
repo   : sanbital/Trading-booooo
branch : claude/booo-integration-accounting-risk-s1fivp
commit : <filled in by the push; use `git rev-parse HEAD` on the branch>
shadow bundle sha256 : run `node scripts/boo/bundle-shadow.mjs` and compare
```

### 7.2 Check positions, plain orders and conditional orders BEFORE anything

```sql
-- DB view
select symbol, state, remaining_quantity, entry_at, hard_stop_price
from v11_long_regime_positions where state <> 'CLOSED' order by entry_at;

select symbol, intent, state, client_order_id, requested_quantity, created_at
from v11_long_regime_orders
where state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
order by created_at;
```

```
-- Exchange view (authoritative; DB snapshot is NOT a substitute).
-- Run through the approved gateway, read-only:
--   action=portfolio           -> positions
--   action=v18_open_orders     -> plain AND conditional open orders
-- Position count 0 in a snapshot does NOT mean 0 resting/conditional orders.
```

### 7.3 Stop old-path new entries while keeping protection alive

```sql
update trading_settings set pause_new_entries = true where id = 1;
```

This blocks new entries only. Exits, protection and reconciliation continue —
verified by regression tests 12 and 30.

### 7.4 Confirm no duplicate worker

```sql
select jobid, jobname, schedule, active from cron.job
where jobname in ('v11-long-regime-executor','v11-long-regime-generator','boo-r1-shadow-20260916');

select jobid, status, start_time, end_time
from cron.job_run_details where jobid = 50
order by start_time desc limit 10;   -- expect one run per minute, none overlapping
```

### 7.5 Apply migration PART B, then deploy

```bash
# PART B only — PART A is already applied.
psql "$DATABASE_URL" -f supabase/migrations/20260916_boo_entry_gate_risk_shadow.sql
```

Deploy the executor through its pinned workflow, with
`expected_version_before = 47`. Required function environment variables (absent
values keep the gate closed, which is the safe default):

| name | purpose |
|---|---|
| `BOO_POLICY_CODE_SHA256` | sha256 of the deployed policy file set |
| `BOO_DATASET_SHA256` | sha256 of the evaluation dataset |
| `BOO_COST_MODEL_VERSION` | cost model identifier |
| `BOO_EXECUTION_MODEL_VERSION` | execution model identifier |

### 7.6 Confirm the deployed code is the code you reviewed

```sql
-- compare against the repository build
select slug, version, ezbr_sha256, updated_at
from  -- via the Supabase management API / MCP list_edge_functions
     (select 1) x;
```

Regression test 24 covers this comparison; a mismatch must abort the cutover.

### 7.7 Verify the gate BEFORE enabling entries

```sql
select phase, allowed, blocked_by, created_at
from boo_entry_gate_decisions order by created_at desc limit 20;
```

Expect `allowed=false` with a specific `blocked_by` until an approval exists.
Then, and only then:

```sql
insert into boo_strategy_approvals (
  policy_code_hash, parameter_hash, dataset_hash,
  cost_model_version, execution_model_version, result_file_hash,
  net_expectancy_lower_bound, expected_edge_source,
  evaluation_start, evaluation_end, independent_periods, trade_count,
  approved_by, valid_until, evidence)
values (...);   -- every field must match the running build; EVALUATED only
```

### 7.8 Final limited-live activation (operator only)

Use the tool. It re-derives every precondition from the live database in the
same run that performs the flip, and **it has no bypass** — no `--force`, no
environment variable, no cached verdict. A 2^8 enumeration test proves that no
subset of failing checks can produce `live_ready = true`.

```bash
# 1. Read-only preflight. Exits non-zero while anything blocks.
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/boo/activate.mjs --check \
  --executor-sha  <ezbr_sha256 of the build you reviewed> \
  --deployed-sha  <ezbr_sha256 read back from the deployed function>

# 2. Only when step 1 prints live_ready = true:
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/boo/activate.mjs --activate \
  --executor-sha <...> --deployed-sha <...> \
  --operator "<name>" --reason "<why now>"
```

On a full pass it sets `boo_entry_gate_control.enforcement = 'ENFORCE'` and
`trading_settings.pause_new_entries = false`, recording the operator and reason.
It never places, cancels or modifies an order, and never changes an account mode.

Run against the live project on 2026-09-16 it reports:

```
[FAIL] ledger_reconciled        3 unresolved
[FAIL] risk_config_valid        RISK_PER_TRADE_IMPLAUSIBLE;DAILY_LOSS_LIMIT_IMPLAUSIBLE
[FAIL] edge_measured            source=ASSUMED
[FAIL] strategy_approved        0 row(s), none live/evaluated/positive
[FAIL] shadow_sample_present    0 closed SHADOW positions
[FAIL] gate_live                gate has never evaluated
[FAIL] deployed_sha_pinned      no expected sha supplied
[PASS] no_unsettled_state       no open positions or pending orders (database view)

live_ready = false
```

### 7.9 After the first real fill

```sql
select p.symbol, p.original_quantity, p.entry_price, p.hard_stop_price,
       o.request_payload->'booRiskReservation' reserved,
       (select count(*) from exchange_trade_fills f where f.v17_position_id = p.id) fills
from v11_long_regime_positions p
join v11_long_regime_orders o on o.position_id = p.id
where p.state = 'OPEN' order by p.entry_at desc limit 5;
```

Confirm, in this order: quantity matches the gate's recorded sizing; planned
loss ≤ 0.25% of equity; a protective order exists at the **filled** quantity;
fills are linked. Also confirm the exchange shows the same exposure — the DB is
not the authority.

### 7.10 Stop conditions and recovery

Stop new entries immediately if any of these hold; none of them requires
stopping protection or settlement:

- daily or weekly loss limit reached (`boo_limit_reason` set);
- 3 consecutive losses;
- equity ≤ 95% of the high-water mark;
- any protection install failure;
- any new `boo_ledger_exceptions` row;
- deployed sha ≠ repository sha.

Resume only after the reason is recorded as resolved. A restart or a toggle must
never clear a limit by itself.

### 7.11 Rollback (preserves protection and the fill ledger)

```sql
-- 1. Stop new entries first.
update trading_settings set pause_new_entries = true where id = 1;
-- 2. Return admission to the previous behaviour without deleting anything.
update boo_entry_gate_control set enforcement = 'OBSERVE' where singleton;
```

Then redeploy `v10-lane-executor` version 47
(`ezbr_sha256 7575268e…`) through its pinned workflow.

**Do not** drop the `boo_*` tables as part of a rollback: they hold the gate's
audit trail and the unresolved ledger exceptions. PART B columns may be dropped
(see the migration footer); PART A should be exported first if it must go.
Never cancel resting protective orders as part of a rollback — regression test
22 exists because a bulk cancel once removed the only protection on a position.

---

## 8. Status — judged separately, as required

| state | value | why |
|---|---|---|
| `code_integration_complete` | **false** | Gate, risk sizing and R1 are wired into the real executor entry path at both checkpoints and typecheck clean, but the build is **not deployed**; production still runs v47. The legacy `sizeEntry` path remains present (gated, not removed). |
| `accounting_reconciled` | **false** | 119/122 positions reconcile within the declared tolerance. 3 positions (−8.00447003 USDT) have no exit fills in the ledger and cannot be recovered from the database. |
| `safety_tests_passed` | **true** | 186/186 across the shared layer: 67 section-9 regressions, 7 preflight property (2^8 enumeration), 13 evaluation/promotion, 11 futures-sweep, plus the pre-existing suite. Unit/property/fault-injection against pure modules — see `environment_integration_passed` for what they do *not* cover. |
| `environment_integration_passed` | **false** | The SHADOW runs in the real Supabase runtime against live Binance data. The **executor** build has not run in any live or staging environment; no end-to-end order path test was performed. |
| `strategy_edge_verified` | **false** | R1 is a research candidate. The promotion rule and the A–E comparator now exist and are tested, but the SHADOW has produced **0 closed trades**, so the rule returns `INSUFFICIENT_SAMPLE`. Zero trades is zero evidence, not a safe result. |
| `shadow_strategy_running` | **true** | `boo-r1-shadow` v3 + cron jobid 80, collecting real market data, ranking candidates, advancing setups, with no order capability. |
| `live_ready` | **false** | Blocked by every `false` above. |
| `live_activated_by_operator` | **false** | Not attempted. Reserved for the account owner. |

### Blockers to LIVE_READY, concretely

1. **Unresolved ledger** — 3 positions, −8.00447003 USDT, need
   `GET /fapi/v1/userTrades` re-collection through the authenticated gateway.
2. **`exchange-trade-sync` starvation** — fix is written and tested
   (`prioritizeFuturesMarkets`, validated against the live database with zero
   false positives) but **not deployed**. Until it ships, 12 markets remain
   >6h stale and new ledger holes keep forming.
3. **No strategy validation** — R1 has no evaluated edge, so the gate refuses it
   by design. The evaluator exists and runs; it needs trades. An A–E comparison
   still requires the full historical candidate set including rejected
   candidates, which this environment cannot fetch (see §9).
4. **No executor environment test** — the integrated build has never executed.
5. **SHADOW credential isolation is source-level, not boundary-level** — same
   Supabase project, shared secret store. Needs a separate project/host.
6. **Live risk configuration is invalid** — `risk_per_trade_pct=100`,
   `max_daily_loss_pct=30`, `max_consecutive_losses=1000000` must be corrected
   or the gate will keep refusing (correctly).

---

## 9. What could not be done here, and why

- **Binance is unreachable from this development sandbox.** Every request fails
  at the network policy (`CONNECT tunnel failed, response 403`). This is why no
  replay, no A–E comparison and no cost-model calibration was produced locally.
  The Supabase edge runtime *can* reach Binance — proven by `boo-market-probe`
  returning 200 for `exchangeInfo`, `klines`, `depth`, `ticker/24hr` and `time`
  — which is why the SHADOW collects there and its results are read back by SQL.
- **No authenticated exchange call was made.** No account, position, order or
  `userTrades` request. Credentials were never read, printed or written, and no
  attempt was made to route around the blocked paths.
- **A–E performance comparison is not provided.** Producing one honestly needs
  the complete historical candidate set *including rejected candidates* at each
  decision time; replaying only the fills that actually happened would measure
  the old entry policy, not the new one. The 2026-09-08–09-16 window is already
  diagnostic data and must not be re-tuned and then called out-of-sample.
  The intended path is forward SHADOW collection, which is now running.
- **Migration PART B and the `exchange-trade-sync` fix were not applied**, since
  both touch objects the live executor reads every minute.
