# V26 strategy search R15 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `c870a1091bcd7d083cfe5a8b4b9c3906ece81f4a`.
- Branch: `research/v26-strategy-search-r15-20260920`.
- C39 was frozen at `3b9fb66406126bf92d0948fd6f3b1716af6ad889` before outcomes were read.
- Regression suite: 36/36 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Verified official Binance funding cache coverage existed for all 46 symbols required by this replay. No missing funding interval was treated as zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C39 | C34 plus joint liquid-universe breadth/BTC momentum inflection | 8 | 2-6 | -0.07425 | -0.2475% | 0.7255 | -0.16438 | -0.21879 | -0.03182 | -0.04133 |

Top-three winners removed net was -0.26697 USDT and top-five removed net was -0.18827 USDT. The opportunity-level diagnostic had 14 executable trades, 5 wins, 9 losses, net -0.08246 USDT and PF 0.8206.

C39 failed executable profitability, PF, sample (8 < 30), active-day (5 < 10), cost stress, top-winner and confidence-bound gates. Stress 4x had only one winning trade because most orders became infeasible and is not evidence of robustness.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C40. Abandon the C34 market-regime interaction axis. Test a rank-acceleration leader structure using strictly improving completed 15m ranks and a principled recent-return contribution check, while retaining all existing risk and execution protections.
