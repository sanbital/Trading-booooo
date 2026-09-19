# V26 strategy search R13 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `b1e68023e75762ea7c3fb79a726af1388f93a5f0`.
- Branch: `research/v26-strategy-search-r13-20260920`.
- C37 was frozen at `041b92b9dcb8f1c781688d39f82d0e626f6ce408` before outcomes were read.
- Regression suite: 34/34 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Verified official Binance funding cache coverage existed for all 63 symbols required by this replay. No missing funding interval was treated as zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C37 | setup-time expansion reservation then immediate trigger | 4 | 1-3 | -0.16946 | -0.5649% | 0.0089 | -0.20203 | -0.17098 | -0.09283 | -0.06036 |

Top-three winners removed net was -0.06939 USDT; top-five removal is not informative with four account trades. The opportunity-level diagnostic had 34 executable trades, 14 wins, 20 losses, net +0.03908 USDT and PF 1.0339, which is within cost/model uncertainty. The positive 4x result had only one trade and is not evidence of robustness.

C37 rejected 27 non-reserved setups but did not alter the first realized account sequence, so the unchanged three-loss protection activated after the same losing path as C34/C35. It failed profitability, PF, sample, active-day, stress, top-winner and confidence-bound gates.

Exploratory root-cause split, now classified as development-used: among the original C34 independent opportunities, the already-defined historical market-participation state was materially different. `marketAllowed=true` had 14 trades, +0.55200 USDT and PF 2.3778; `false` had 23 trades, -0.10410 USDT and PF 0.8747. This does not promote a candidate and is subject to multiple-testing correction, but supports testing an interaction structure rather than another queue variation.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C38. Leave the failed queue axis. Combine the unchanged C34 compression-expansion gate with the pre-existing, independently specified historical market-participation gate. Do not tune either threshold from these outcomes, and retain every account protection.
