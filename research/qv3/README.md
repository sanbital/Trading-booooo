# QV3 ENTRY_EXIT_TWO integration

Baseline: remote v10-lane-executor v35, source e008db827227bbd75fd8a4d7e6b26dcec2d77500.
All nine fetched executor files match that source byte for byte.

`leader-qv3-rules.mjs` is the supplied research module with only its import path
changed. Operational calls select ENTRY_EXIT_TWO exclusively. The runtime adapter
adds completed-candle continuity, duplicate/OHLC checks, explicit ownership, and a
position-specific persisted favorable-close proof. It does not change thresholds.

The original protocol remains classified `DEFER`; its failed evidence gates are not
rewritten as passing. At the operator's explicit direction, the live integration has
a fixed `QV3_LIVE_CUTOVER=2026-09-11T15:20:00.000Z` and an immutable
`OPERATOR_OVERRIDE_PROTOCOL_DEFER_20260911` audit basis. HTTP bodies and environment
variables cannot move or broaden the cutover. This is an operator override, not an
evidence-based live-promotion approval.
Only new entries bearing the matching cutover stamp could use QV3. Recovery takes
that stamp from the original order intent. Existing positions keep their policy.

Baseline stops, deadlines, and native protection execute before the optional QV3
exit check. Candidate exits reuse closePos, persisted intent identities, settlement,
lease fencing and protection cleanup. Ambiguous dispatches remain reconciliation
work; they are never blindly resubmitted.

The separate `qv3-entry-exit-shadow` function cannot import/call live orders. It
uses public market GETs and reads existing scan/ownership/control tables. Its only
write target is v18_strategy_shadow_runs under QV3_ENTRY_EXIT_TWO_SHADOW_1. No DB
schema change is needed. Authentication uses the existing diagnostic token.
`qv3-ops-status` exposes only fixed authenticated read commands: p10_portfolio,
v18_open_orders and symbol_info for 4USDT, plus sanitized gateway health metadata.

Tests:

```sh
node --test research/qv3/*.test.mjs test-support/v18-ops/run-race.test.mjs test-support/v18-ops/settlement.test.mjs test-support/v18-ops/runtime-observability.test.mjs
node --test gateway/server.test.mjs
PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js node --test test-support/v18-ops/postgres.test.mjs
node research/qv3/replay-selected.mjs /absolute/path/to/unmodified/evidence
```

The selected replay reproduces only BASELINE and ENTRY_EXIT_TWO from the fixed
archive window. It does not search other candidates, bootstrap again, reconstruct
cash/slots/replacement entries, or establish independent profitability.

Blocked evidence includes fewer than 100 post-update trades, zero independent
validation trades (30 required over 3 windows), 17 baseline errors above 0.25 USDT,
missing account replay/funding and negative absolute stress PnL. The original 99%
familywise descriptive interval crosses zero. Passing engineering tests does not
resolve those failures. Original protocol and its hash remain unchanged.

Live deployment: `v10-lane-executor` v36 contains the fixed-cutover QV3 integration.
Its rollback reference is v35 at source
`e008db827227bbd75fd8a4d7e6b26dcec2d77500`; do not redeploy an older gateway,
market-autotrader, main, or release bundle. A rollback must preserve every live
position/order row and resident protection, restore only the executor's exact v35
files, verify the remote source and exchange/DB reconciliation, and then use the
normal recovery gates before allowing new entries. The independent
`qv3-entry-exit-shadow` collector can be stopped separately without changing live
execution or deleting its evidence.
