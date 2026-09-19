# V26 strategy search R9 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `bb4095c9f8762e5a5f74c5634d0b35726e618f65`.
- Branch: `research/v26-strategy-search-r9-20260920`.
- C33 was frozen at `ded03884b3ccbe58adc7a8d8fa25cd9062a37b91` before outcomes were read.
- Regression suite: 30/30 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

The first attempt failed closed on missing ACEUSDT funding coverage and produced no evaluated summary. The completed attempt had verified coverage for all 83 opportunity symbols: 81 reused and two fetched from official Binance USD-M funding history.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C33 | rolling cross-sectional execution-adjusted breakout value | 3 | 0-3 | -0.15310 | -0.5103% | 0.0000 | -0.20157 | -0.12109 | -0.19039 | -0.06055 |

Top-three and top-five removal are not informative because only three account trades existed. The opportunity-level shadow diagnostic had 54 executable trades, 19 wins, 35 losses, net +0.05980 USDT and PF 1.0309. That marginal shadow value is below the required PF and robustness threshold, while the executable account path lost its first three trades and activated the unchanged loss protection. C33 failed profitability, PF, sample, active-day, stress, top-winner and confidence-bound gates.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C34. Do not tune C33. Test a distinct longer-horizon regime-transition structure: causal trailing-60m volatility compression followed by current completed expansion, ranked cross-sectionally to distinguish fresh impulses from late chases.
