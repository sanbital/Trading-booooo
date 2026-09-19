# V26 strategy search R8 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `8f85f53f2f74b7424f14820fa5b8b864e318cf42`.
- Branch: `research/v26-strategy-search-r8-20260920`.
- C32 was frozen at `188d0a70a48d9396d048dd87d6dd6eaf689d8cc7` before outcomes were read.
- Regression suite: 29/29 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

The first attempt failed closed on missing ACUUSDT funding coverage and produced no evaluated summary. The completed attempt used verified coverage for all 78 opportunity symbols, entirely reused from previously verified official Binance USD-M funding caches.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C32 | rolling cross-sectional buyer-flow acceleration | 4 | 1-3 | -0.09359 | -0.3120% | 0.3733 | -0.21733 | -0.14932 | -0.14644 | -0.06210 |

Top-three winners removed net was -0.06922 USDT; top-five removal is not informative because only four account trades existed. The opportunity-level shadow diagnostic had 48 executable trades, 15 wins, 33 losses, net -0.42926 USDT and PF 0.7524. Thus the broad buyer-flow acceleration score itself had negative cost-adjusted expectancy; the account path then reached the unchanged three-loss protection. C32 failed profitability, PF, sample, active-day, stress, top-winner and confidence-bound gates.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C33. Do not tune C32's percentile. Test a different single cross-sectional axis based on execution-adjusted continuation geometry: completed trigger breakout surplus relative to structural-stop loss and conservative round-trip costs.
