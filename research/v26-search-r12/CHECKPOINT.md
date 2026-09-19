# V26 strategy search R12 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `27926473a93591bfed6e147a6f31096e159a325f`.
- Branch: `research/v26-strategy-search-r12-20260920`.
- C36 was frozen at `c83251548f408349a68ade6efd0134f5493a4e46` before outcomes were read.
- Regression suite: 33/33 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Verified official Binance funding cache coverage existed for all 53 symbols required by this replay. No missing funding interval was treated as zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C36 | completed 15m C34 queue auction | 6 | 2-4 | -0.07772 | -0.2591% | 0.7097 | -0.32502 | -0.25627 | -0.11587 | -0.06806 |

Top-three winners removed net was -0.20340 USDT and top-five removed net was -0.06932 USDT. The opportunity-level shadow diagnostic had 32 executable trades, 12 wins, 20 losses, net -0.38771 USDT and PF 0.6590.

C36 materially changed the account path and reduced headline loss versus C35, but the apparent improvement depended on two winners: removing the largest winner made net loss substantially worse. Waiting for the completed 15-minute auction also caused 37 otherwise eligible paths to breach the unchanged entry-drift limit, and the delayed opportunity population had negative raw expectancy. C36 failed profitability, PF, sample, active-day, stress, top-winner and confidence-bound gates.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C37. Do not tune thresholds, shorten the fixed C36 batch after seeing its result, or relax protections. Test a different causal structure that reserves one setup at the completed 15-minute scanner cutoff using only setup-time compression/current-strength evidence, then allows that reserved setup to trigger immediately. This removes the harmful post-trigger delay while preventing later first-arrival queue dilution.
