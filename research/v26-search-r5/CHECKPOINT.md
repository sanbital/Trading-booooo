# V26 strategy search R5 checkpoint

Generated: 2026-09-19

Scope: research only. No main merge, deployment, live order, cancellation, liquidation, account change, approval change or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent research checkpoint: `7875a1e82186b59f7cabba4c6c962454fdce3515`.
- Research branch: `research/v26-strategy-search-r5-20260919`.
- C25-C27 rules were frozen at remote head `48835be00ea95980cfed5e0943b7551d7da9772c` before outcomes were read.
- Pure integrity and candidate regressions: 26/26 passed.
- Capital 30 USDT, leverage 3x, one concurrent position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit policy: `STRENGTH_LOSS_V1`; no time-only exit.

The preregistration manifest initially mislabeled the inherited R4 development window by one day. The first replay itself used the R4 window shown below and failed closed on missing funding coverage before generating a summary. The manifest window label was then corrected; candidate rules and thresholds were not changed.

## Completed replay

Development window (already used, never described as holdout):
`2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

The first attempt stopped on missing ALLOUSDT funding coverage and was not evaluated. The completed attempt used explicit verified coverage for all 25 opportunity symbols; 23 were reused from prior verified caches and two were fetched from Binance USD-M funding history. Missing funding was never replaced by zero.

| Candidate | Structure | Account trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C25 | completed breakout retest and recovery | 2 | 2-0 | +0.35799 | +1.1933% | Inf | -0.04036 | +0.00016 | -0.00388 | +0.00016 |
| C26 | controlled pullback and reclaim | 3 | 1-2 | -0.08955 | -0.2985% | 0.354 | -0.12651 | -0.13866 | -0.06944 | -0.06936 |
| C27 | three-minute breakout acceptance | 1 | 0-1 | -0.00250 | -0.0083% | 0.000 | -0.03895 | 0.00000 | 0.00000 | NA |

C25's positive headline was only two active-day trades, depended on one large win, and became negative under the preregistered 2x cost stress. It fails the minimum 30 trades, 10 active days, robustness and stress gates. C26 and C27 were negative and sample deficient. None passed development.

Walk-forward and the reserved unused final holdout were not consumed.

## State

`no_robust_edge_found=true`

The next iteration begins at C28. Do not tune C25-C27 around the two observed C25 trades. Move to a structurally different pre-entry failure-avoidance or cross-sectional relative-pullback hypothesis while preserving all risk limits.
