# V26 strategy search R11 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `fb9520632c5dc59ce058d6ec0f417a0acc8c26e8`.
- Branch: `research/v26-strategy-search-r11-20260920`.
- C35 was frozen at `98d35d0c656a2d0753fb2f6da53a615be7a08d5a` before outcomes were read.
- Regression suite: 32/32 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Verified official Binance funding cache coverage existed for all 76 symbols required by this replay. No missing funding interval was treated as zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C35 | highest C34 score per identical trigger timestamp | 4 | 1-3 | -0.16946 | -0.5649% | 0.0089 | -0.20203 | -0.17098 | -0.12578 | -0.06036 |

Top-three winners removed net was -0.06939 USDT; top-five removal is not informative because only four account trades existed. The opportunity-level shadow diagnostic remained 37 executable trades, 15 wins, 22 losses, net +0.44791 USDT and PF 1.3638.

C35 removed two lower-scored same-timestamp opportunities, but neither was on the realized account path. The account therefore selected the same initial sequence as C34 and reached the unchanged three-loss protection. C35 failed account profitability, sample, active-day, stress, top-winner and confidence-bound gates. This is a genuine unchanged-result finding, not a replay omission.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C36. Do not tune C34/C35 thresholds or relax protections. Test a completed 15-minute queue auction: batch only C34-eligible triggers from the same fully completed scanner cycle, choose the highest pre-entry expansion score, and enter no earlier than the next one-minute open. This tests near-time queue competition rather than exact-timestamp duplicates while remaining causal.
