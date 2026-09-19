# V26 strategy search R10 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `9df7ba9cff46a0b6f09eb4a488ce3198b3ab995f`.
- Branch: `research/v26-strategy-search-r10-20260920`.
- C34 was frozen at `9b82134bb1ad8776a0030e6f4a74097ec375fef5` before outcomes were read.
- Regression suite: 31/31 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

The first attempt failed closed on missing ACUUSDT funding coverage and produced no evaluated summary. The completed attempt reused verified official Binance funding coverage for all 77 opportunity symbols.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C34 | rolling cross-sectional 60m compression to 5m expansion | 4 | 1-3 | -0.16946 | -0.5649% | 0.0089 | -0.20203 | -0.17098 | -0.12578 | -0.06036 |

Top-three winners removed net was -0.06939 USDT; top-five removal is not informative because only four account trades existed. The opportunity-level shadow diagnostic had 37 executable trades, 15 wins, 22 losses, net +0.44791 USDT and PF 1.3638. This is a useful raw-opportunity signal, but the unchanged account queue selected an early losing sequence and then activated the three-loss protection. C34 therefore failed the executable account profitability, sample, active-day, stress, top-winner and confidence-bound gates despite positive shadow expectancy.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C35. Do not tune C34's threshold or disable loss protection. Test a structurally distinct deterministic queue policy that admits only the highest C34 score within each same-time queue cohort, preserving all account limits, to determine whether cross-sectional ordering converts the positive opportunity edge into an executable path.
