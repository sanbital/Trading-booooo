# Entry evidence boundary repair — 2026-09-18

Base: `fff9cf4c90d4b9d0f390076f4b4e722b1df0fde6`.

## Findings and changes

A setup's `V17_REACCEL_TRIGGERED` event was an intermediate candidate, not final
order approval. The inspected unfilled candidates ended in `V17_ENTRY_DRIFT`.
An OBSERVE BOO verdict is not the enforcing cause of that rejection. There was
no persisted executable quote sufficient to reconstruct those historical drift
checks. This change retains the original 1% two-sided price guard, records the
actual checked limit/reference/quote timestamp/stage, and separates setup events
from completed-entry outcomes. It does not claim those candidates would have
been profitable or should have been traded.

Independently reproduced code defects:

* E1 used the old 120-second signal deadline for setup entries that can trigger
  later. Setup entries now use their own 60-second trigger deadline, bounded by
  the 15-minute setup expiry, with identity/time/reference consistency checks.
  Legacy entries keep the original deadline. No timestamp is rebased to arrival.
* BOO read `quote.raw.asks/bids` while the gateway returns normalized
  `quote.asks/bids` objects. The adapter now validates and converts them to the
  risk solver's array format. Empty, invalid, crossed, stale, future and
  inconsistent books remain unhealthy.
* The gateway reports `taker_pct`, but the executor read fraction-only names.
  Percent is converted to a fraction once, using the account/symbol response.
  Missing/conflicting fees cause explicit refusal, not zero or a default fee.
* P10 portfolio does not report account position mode. A separate authenticated
  read-only `futures_position_mode` command now supplies fresh explicit evidence.
  It never changes the mode, does not read/update the order cache, and adds no
  calls to position management/exit portfolio reads. Unknown and hedge modes do
  not become one-way approval.

## Boundaries

No live settings, database rows, validation records, strategy thresholds,
leverage, slot size, risk ceilings, protective-stop state machines, or exit
policies are changed. OBSERVE/ENFORCE is still selected by the existing control
row. Approval records and measured positive edge are not invented. Implausible
risk settings still require an explicit operator decision; margin allocation is
not reinterpreted as equity-loss risk.

A fresh mode read requires the matching gateway code before an enforcing
executor can use it. An older gateway's unknown-command response remains unknown
mode evidence. No production deployment is performed by this branch's tests.

The additional mode GET is entry-only and bounded by the existing cycle budget.
Existing quote freshness limits are not relaxed. Slow dependency reads can still
make a quote too old; these are real refusals, not grounds for admitting stale data.

## Verification

Run the new boundary/source-wiring tests and the existing gateway tests:

```sh
node --test supabase/functions/v10-lane-executor/entry-evidence.test.mjs gateway/*.test.mjs
```

The `Entry evidence regression` CI also runs the repository's canonical
`test:entry` command and the Deno BOO/margin tests with read-only runtime
permissions. No exchange/DB credentials are provided to the regression job.

These tests verify deterministic behavior with mocks and synthetic fixtures,
not profitable strategy performance or a completed live order lifecycle.

## Deployment, 2026-09-18 KST

Merged to `main` as `2f4b031` (squash of PR #142). Release order was gateway
first, executor second, and the order is enforced mechanically rather than by
convention: the executor release refuses to deploy until the live Binance
gateway's `/health` advertises `capabilities.futures_position_mode`.

| step | what | when (KST) |
| --- | --- | --- |
| gateway (Binance, Paris) | auto on `gateway/**` push | 15:33:39 |
| gateway (Upbit, Tokyo) | same image, same push | 15:34:22 |
| executor + signal generator | V26 release, dispatched | from 15:36 |

Also fired by the same push, as it does on every `_shared/**` change:
`deploy-market-autotrader-v707` (succeeded). That lane does not import the
sizing contract, so it redeployed unchanged code.

## Verified separately, and NOT fixed here

These were found while confirming the above. Each needs its own change; none is
a regression introduced by this one.

* **`exchange_trade_sync_runs` has not finalized a run since 2026-09-16
  15:29 KST** — 480 consecutive rows stuck at `RUNNING` with `completed_at`
  NULL and `markets_succeeded` 0. Per-market collection is healthy and current
  (338/338 `SUCCESS`), so no fill is being lost; it is the run-level audit trail
  that is blind. The deployed `exchange-trade-sync` is v64, whose futures sweep
  iterates the entire market universe with no cap while the spot sweep is capped
  at 240. With 338 markets that cannot finish inside the 55s cron budget, so the
  function is killed before either its success or its error finalizer runs.
  `main` already carries the fix (`prioritizeFuturesMarkets`,
  `MAX_FUTURES_SWEEP = 60`); it has never been deployed.

* **Four `CLOSE_LONG` orders from 2026-09-03 are still `SUBMITTED`** (UNIUSDT
  x2, SEIUSDT x2, with exchange order ids). They do not gate entry: the executor
  contains no reference to `SUBMITTED` at all. Resolving them needs an
  authenticated read of exchange order state, which is an operator action.

* **No `boo_*` columns exist on `trading_settings` or
  `v11_long_regime_runtime`.** The executor has referenced them since v50 and
  degrades gracefully -- the gate still records verdicts and `last_error` stays
  null -- but it is why the gate reports `COST_EDGE_NOT_MEASURED` and cannot
  persist loss-limit state. PART B of
  `20260916_boo_entry_gate_risk_shadow.sql` is unapplied.

* **`risk_per_trade_pct = 100` is deliberate, not a unit bug.** Migration
  `202607260003_remove_unapproved_sizing_caps.sql` set that default, widened the
  constraint from `0.05..2` to `0.05..100`, and named itself accordingly.
  `v10-lane-executor` never reads the field; only the market-autotrader lane
  does. The V17 slot is bounded by the sizing contract (30 USDT at 3x, 30.25
  USDT ceiling), not by this percentage. The BOO gate reads it as though it
  governed V17 and therefore reports `RISK_PER_TRADE_IMPLAUSIBLE`. Reconciling
  the two is a design decision for the operator; the value was NOT changed.

* **A 30 USDT slot structurally excludes coarse-step symbols.** The admissible
  window is `[90.09, 90.75]` notional at the ask -- 0.66 USDT wide. Any symbol
  whose lot step is worth more than that can never land inside it. NEARUSDT
  (step 1 at ~3.25 USDT) and UNIUSDT (step 1 at ~8.5 USDT) are refused for this
  reason, correctly, and eight times on 2026-09-18 alone. Widening the overshoot
  budget or raising the slot would change it; both are operator decisions and
  neither was taken.
