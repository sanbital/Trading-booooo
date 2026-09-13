# V19 scope-aware operational regression

All symbols, IDs, times and economics are isolated synthetic fixtures. No exchange
credential, production row, signal generation, or live order is used.

| # | Input and event order | Previous result | Required assertion |
|---|---|---|---|
| 1 | close exposure final → raw fills delayed | incident → account circuit | accounting remains local; unrelated entry decision passes |
| 2 | exposure known → fee delayed | exposure/accounting conflated | `HELD` and `FILL_DETAILS_PENDING` coexist |
| 3 | active symbol quarantine → other signal | all symbols blocked | other candidate passes complete account/order risk proof |
| 4 | active symbol quarantine → same signal | lifecycle collision possible | same symbol is blocked |
| 5 | local-looking issue → account bound unknown | optimistic continuation or permanent halt | fresh evidence required; account hold |
| 6 | account flat → uncertain entry intent | flat misclassification | account hold and same identity re-query |
| 7 | terminal stop → accounting pending | terminal skipped forever | exact stop/fill is re-queried and settled |
| 8 | unclassified/manual exit | fabricated bot attribution/PnL risk | source remains unknown and no PnL is synthesized |
| 9 | partial fill/close | requested quantity used | actual residual quantity drives mismatch/protection |
| 10 | native stop races software exit | duplicate sell risk | native reconcile precedes software intent |
| 11 | order timeout → exchange success possible | replacement ID risk | original identity remains the only recheck |
| 12 | fills duplicate/reversed/late | double count/order dependence | canonical exact result once; conflict fails closed |
| 13 | restart/CAS/lease stale writer | cumulative double apply | monotonic delta rejects regression/overflow |
| 14 | stale/incomplete account response | `positions=[]` treated flat | account hold |
| 15 | recovery → superseding incident/operator halt | old recovery clears new control | exact generation CAS; halt preserved |
| 16 | many settlement delays + one manager timeout + exact active native stop | protection/entry starved | protection runs first; independent stop proof permits unrelated evaluation |
| 17 | inspection only, unresolved | success timestamp refreshed | reconciliation-success timestamp unchanged |
| 18 | normal strategy configuration and identical production-basis input | accidental strategy/risk drift | QV3, 40 USDT, 3x, 10 slots plus order quantity/price/stop remain identical |

Scenario 7 also asserts that a terminal cross-lifecycle order is no longer polled after
the exact target lifecycle has been durably recorded.

Run from the repository root:

```sh
npm ci --prefix test-support/v18-ops --ignore-scripts
PGLITE_MODULE="$PWD/test-support/v18-ops/node_modules/@electric-sql/pglite/dist/index.js" \
node --test --test-reporter=tap \
  test-support/v17-exit/*.test.mjs research/v18/*.test.mjs \
  test-support/v18-ops/*.test.mjs test-support/v19-ops/*.test.mjs gateway/*.test.mjs
```
