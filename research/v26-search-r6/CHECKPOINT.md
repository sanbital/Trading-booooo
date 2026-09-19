# V26 strategy search R6 checkpoint

Generated: 2026-09-19

Scope: research only. No main merge, deployment, live order, cancellation, liquidation, account change, approval change or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent research checkpoint: `44095ffce688770a1f5dd997524c7b1caf7ed7a2`.
- Research branch: `research/v26-strategy-search-r6-20260919`.
- C28-C30 were frozen at remote head `4db0e9695c7df64f6cda6fa492372e7298bfd6be` before outcomes were read.
- Pure integrity and candidate regressions: 27/27 passed.
- Capital 30 USDT, leverage 3x, one concurrent position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit policy: `STRENGTH_LOSS_V1`; no time-only exit.

## Completed replay

Development window (already used, never described as holdout):
`2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

The completed attempt used explicit verified Binance USD-M funding coverage for the sole opportunity symbol, ZENUSDT, reused from the prior verified cache. Missing funding was never replaced by zero.

| Candidate | Structure | Account trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C28 | pullback seller exhaustion | 1 | 0-1 | -0.05133 | -0.1711% | 0.000 | -0.05133 | 0.00000 | 0.00000 | NA |
| C29 | volume dry-up then reacceleration | 0 | 0-0 | 0.00000 | 0.0000% | 0.000 | 0.00000 | 0.00000 | 0.00000 | NA |
| C30 | absolute buyer-notional escalation | 0 | 0-0 | 0.00000 | 0.0000% | 0.000 | 0.00000 | 0.00000 | 0.00000 | NA |

C28 was negative and sample deficient. C29 and C30 produced no opportunities and therefore no evidence. None passed development. Walk-forward and the reserved unused final holdout were not consumed.

## State

`no_robust_edge_found=true`

The next iteration begins at C31. Do not relax C28-C30 until they trade. Their conjunctions are too selective for the required sample. Move to one structurally broader hypothesis at a time, preferably cross-sectional ranking of pullback quality followed by the existing trigger rather than stacking more absolute gates.
