# V26 strategy search R17 checkpoint

Generated: 2026-09-20

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `dfcf4a274ec498f32b6238052b0a12a2e145f5bf`.
- Branch: `research/v26-strategy-search-r17-20260920`.
- C41 was frozen at `68af04498d62b819335e3e33b9e09d3cb8beb991` before outcomes were read.
- Regression suite: 38/38 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Stress 2x net | Shadow net/PF |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C41 | contemporaneous 30m/24h momentum-freshness percentile | 3 | 0-3 | -0.20590 | -0.6863% | 0.0000 | -0.20590 | -0.22473 | -0.36208 / 0.6985 |

C41 formed 74 causal opportunities. The account path admitted three trades, all losing on 2026-08-21, after which the unchanged consecutive-loss protection rejected 66 later opportunities. Five opportunities were infeasible at minimum notional. There was no winning trade, so a largest-winner exclusion is not applicable; the generic top-trade diagnostic is `-0.13956 USDT` and does not change the failure.

The opportunity-level shadow path also failed: 28 settled opportunities, 8 wins and 20 losses, `-0.36208 USDT`, PF `0.6985`. This rejects the entry hypothesis independently of the account kill-switch. Baseline sample size, active days, PF, net PnL, cost stress and confidence-lower-bound criteria all failed.

The first replay attempt correctly failed closed because the prior 77-symbol cache lacked `ALLOUSDT`. A verified full cache was then built from existing official Binance USD-M history plus direct official REST retrieval for `BICOUSDT` and `PEOPLEUSDT`; all 54 required symbols have explicit full-window coverage. Funding was never replaced with zero.

Walk-forward and the reserved unused holdout were not consumed. `no_robust_edge_found=true`.

Next: C42. Do not tune C41's percentile. Test a distinct short-horizon pulse-share structure: rank the latest completed 5m contribution relative to the preceding 25m among contemporaneous leaders, so a large but aging 30m move is not mistaken for current reacceleration.
