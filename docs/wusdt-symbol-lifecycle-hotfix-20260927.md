# WUSDT input and lifecycle hotfix

Baseline: main `ebcf9cdc635e4b55d026d4211f61d5deeebd2b7a` (not the earlier
`f54e2247` audit head). All 66 downloaded executor source files matched that main
after normalizing transport line endings. Production executor v109 artifact:
`fa86a068927ae1a556b04d8e2f2508e7f28ca252f0c42297f0f62dbdcff06f89`.
Claude's `AI_PROTECTION_ARBITRATION_1` is included and preserved.

## Reconfirmed incident

The three immutable signal copies in `tests/fixtures/wusdt-signals-20260927.json`
contain `B06133_MARKET_INPUT`, followed by terminal
`STALE:TRIGGER_WINDOW_CLOSED`, without a lifecycle cause. Production PostgreSQL
logs show `CEC0040_DECISION_INPUT_INVALID` at 03:07:09.455, 03:11:06.943 and
03:17:08.739 UTC on 2026-09-27 (12:07, 12:11, 12:17 KST). All trigger cutoffs
are valid minute boundaries. No Binance request occurred at the B06133 failure;
null BTC evidence was not evidence of a BTC API outage.

## Narrow changes

- B06133 and legacy GPT microstructure canonical validators accept 1–60 uppercase
  ASCII alphanumeric base characters. Absolute JS end matching rejects terminal
  newlines as well as paths, whitespace, controls and the bare quote `USDT`.
  The existing uppercase normalization boundary stays in B06133; micro consumes
  canonical input. SQL receives the same canonical uppercase symbol.
- `v11_cec0040_decide` is copied from the current `pg_get_functiondef`, with only
  the base minimum and explicit null symbol/branch rejection changed. Owner,
  ACL, signature, result, invoker security, search_path, locks, causal ordering,
  idempotency and EWMA remain unchanged. The migration contains no trading DML.
- `features.entryLifecycle.technicalFailure` stores bounded `first`, `latest`
  and first blocking `root` events. Each has signal/symbol, stage, code/reason,
  timestamp, original trigger cutoff/expiry, remaining milliseconds, GPT attempt
  and dispatch flags. Unknown GPT attempt evidence is null, never invented.
  B06133 evidence failures are nonblocking; CEC is never made ready on error.
- CEC/selector exceptions write the existing signal and decision audit before
  skipping proven symbol input/identity failures. Unknown, state identity,
  lease/account/storage failures propagate. Audit write failure also fails closed.
  GPT technical errors use `kind: TECHNICAL_ERROR`; ordinary valid SKIP remains
  a model decision. GPT attempt metadata is copied from its stored result only.
- Later notes, asynchronous review completion and claim release retain the
  failure summary. Expiry keeps `STALE:TRIGGER_WINDOW_CLOSED` and the preceding
  technical cause together. Existing rows and expired signals are not repaired.

## Verified downstream scope

The CEC target registration/recovery/observation functions have no two-character
minimum. They are unchanged and tested with WUSDT against real PostgreSQL.
Current FD1 ENTRY/FINAL RECHECK, replay and self-evolution symbol paths already
accept a one-character base. Gateway exchangeInfo still refuses unlisted,
non-TRADING and non-PERPETUAL contracts and retains lot/price/notional filters.
W entry fills, reduceOnly native protection, holding, hard-stop exit and exit
settlement are exercised with mocks. A format-valid name is never trading permission.

Only executor deployment is needed: worker v8's 36 downloaded files match main
and contain none of the six changed runtime modules. The other direct B06133
consumer, temporary `gpt-final-review-verify`, is not deployed. The worker shares
unchanged CEC pure evaluation and the DB receives the compatible input patch.

## Validation

Red: 25 JS/lifecycle tests, 19 pass / 6 fail; 23 actual CEC SQL tests,
18 pass / 5 fail. Both expose W/T rejection before the fix. The committed SQL
fixture is the read-only production function definition, not a simplified model.

Green: the three incident signals run through actual executor selectors and
the real CEC PostgreSQL implementation at trigger +9 seconds. The corrected path
reaches the GPT handoff with ordinary CEC readiness, without requiring BUY.
Completed market candles and isolated CEC learning state are synthetic fixtures;
this is control-flow regression, not historical profitability reconstruction.

Commands (set `PGLITE_MODULE` to the installed pinned
`@electric-sql/pglite@0.3.14/dist/index.js`):

```sh
node --test --test-concurrency=4 tests/wusdt*.test.mjs
node --test --test-concurrency=4 development/gpt-final-review/tests/*.test.mjs supabase/functions/_shared/*.test.mjs supabase/functions/v10-lane-executor/*.test.mjs tests/*.test.mjs development/self-evolution/tests/*.test.mjs development/gpt-final-decision/tests/*.test.mjs test-support/v17-entry/*.test.mjs test-support/v17-exit/*.test.mjs test-support/v18-ops/*.test.mjs collectors/doa-capture/*.test.mjs gateway/*.test.mjs
deno task test
deno check supabase/functions/v10-lane-executor/index.ts supabase/functions/self-evolution-worker/index.ts
git diff --check
```

The full Node run passed 1,228 tests before the final additional W recheck and
holding assertions; those passed in focused runs. The final related release suite passed 576 tests
(including the final coordinator attempt metadata), zero failures. Deno: 1,055
passed, 13 steps, zero failures. Final release receipts record deployment.

## Release and preserved settings

CLI `supabase migration new wusdt_symbol_lifecycle` generated
`20260927035950_wusdt_symbol_lifecycle.sql`. Merge the tested patch into current
main, apply this exact function body through the migration API, then deploy only
`v10-lane-executor` and compare every returned source file against the commit.
The API may timestamp its migration receipt at application time; record the
applied version explicitly and preserve SQL-body identity. Do not replay the
legacy all-migration bootstrap workflow; it is manual and changes old settings.

Baseline live settings: 150 USDT target margin, 3x leverage, 10 slots,
LIVE_LIMITED, enabled entry, closed circuit, no pause/emergency/manual flag,
GPT ENFORCE, USD 50/day and 300 calls/day, withdrawal mode false. No configuration
write belongs to this patch. `manageLeader`, `openBull` and `verifyExecutionLease`
are unchanged. Hard-stop independence, approved-floor monotonicity, GPT-final-only
protection approval, HOLD/reviewer-failure floor retention, acknowledge-before-cancel,
60-second trigger TTL, freshness, FINAL RECHECK, sizing, strategy, budgets and
DeepSeek authority are unchanged. Three-slot proportional sizing is not applied.

Completion distinguishes code/DB verification, deployed artifact verification,
and a naturally occurring post-deployment candidate. No test order, forced buy,
forced exit, signal revival or production test CEC decision is authorized by this
verification procedure. An absent natural W candidate leaves the third level open.
