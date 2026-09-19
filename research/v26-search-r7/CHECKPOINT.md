# V26 strategy search R7 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `a062f4c0c84315e651cd913127643676f98c6e97`.
- Branch: `research/v26-strategy-search-r7-20260920`.
- C31 was frozen at `8f93898139e1e23dd9eab80eb2537f7ee2aa5dfb` before outcomes were read.
- Regression suite: 28/28 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

The first attempt failed closed on missing ACEUSDT funding coverage and produced no evaluated summary. The completed attempt used verified coverage for all 84 opportunity symbols: 82 reused and two freshly fetched from Binance USD-M funding history.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C31 | rolling cross-sectional pullback recovery quality | 3 | 0-3 | -0.14538 | -0.4846% | 0.000 | -0.17834 | -0.11337 | -0.14734 | -0.06893 |

The opportunity-level shadow diagnostic had 58 executable trades, 18 wins, 40 losses, net -0.13773 USDT and PF 0.9393. Thus the broad score itself had negative cost-adjusted expectancy; the account path then stopped after three consecutive losses. C31 failed profitability, PF, sample, active-day, stress, top-winner and confidence-bound gates.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C32. Do not tune C31's percentile. Test a different single cross-sectional axis focused on current buyer-flow acceleration relative to peers, because pullback recovery geometry alone did not discriminate winners.
