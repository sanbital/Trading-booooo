# V18 trade audit and review fixes

No live deployment, account control, circuit override, or order is performed by these scripts.

Changes are based on `release/v18-ops-isolation-3` at
`49423476c8223090404ee95e051d7dfd0af540f5`. The executor and its eight dependencies
were compared byte-for-byte with production Edge Function version 34. All matched.
The exchange sync source is first synchronized with the actual production version 61,
including its previously untracked `futures-sync.ts`. Do not replace that live version
with the older default-branch source.

## Fixes

- Collection: add paginated V17 order/position symbols to the futures sync universe.
  A position which opens and closes between sweeps remains discoverable. This changes
  collection scope only; it does not infer ownership or rewrite historical PnL.
- Runtime telemetry: advance the compatibility `last_success_at` only after entry
  evaluation and clean management/reconciliation. A heartbeat, open circuit, disabled
  runtime, lease loss, or failed account read does not become a success.
- Gateway symbol validation: accept a one-character base such as `4USDT`, retaining
  the Unicode letter/digit allow-list, USDT quote restriction and delimiter rejection.
  Exchange symbol information, freshness, price, spread, cash and risk guards still apply.

No strategy threshold, order size, leverage, slot, native stop, peak or partial-fill
state is changed. Existing positions retain their policy. No schema migration is added.

## Reproduce from the companion evidence package

Use Node 24+ and Python 3.11+. Extract the evidence package outside this checkout.

```sh
python3 research/20260911_trade_audit/analyze.py --evidence /path/to/evidence --out /path/to/analysis
node research/20260911_trade_audit/replay.mjs /path/to/evidence /path/to/analysis
npm ci --prefix test-support/v18-ops --ignore-scripts --no-audit --no-fund
PGLITE_MODULE="$PWD/test-support/v18-ops/node_modules/@electric-sql/pglite/dist/index.js" node --test --test-concurrency=1 --test-reporter=tap test-support/v17-exit/*.test.mjs research/v18/*.test.mjs test-support/v18-ops/*.test.mjs gateway/*.test.mjs
```

Actual PnL uses signed account fills, exact market/order identities and balanced
quantities. Fees are positive expenses; actual fill PnL receives no extra slippage
deduction. Funding remains unknown and is never set to zero. One-minute candle
excursions have entry/exit boundary bounds and cannot identify intrabar sequence.

The replay uses the same historical executed entries and a fixed six-hour eligibility
horizon. It is an episode diagnostic, not an account-level backtest. Changed future
entries, historical nontraded opportunities, portfolio constraints and funding are
not reproduced. The candidate rules are not selected or promoted. The evidence
package contains the prespecified gates, results, source parity and test records.

## Release and recovery limits

This is a review branch. Do not equate a PR, CI result or branch push with production
deployment. Before any release, a human operator must reconcile the current remote
source and configuration, validate the exact SHA and bundle, and check all live
positions and orders again. Preserve the existing account controls and native stops.
The executor rollback source is the verified baseline commit above/version 34;
the sync rollback is the archived production version 61. Gateway rollback must use
the currently verified deployed image, not a historical report's unconfirmed image.
No full DB history push or automatic main merge is part of this change.
