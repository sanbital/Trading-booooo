# V26 strategy search R3 checkpoint

Generated: 2026-09-19

Scope: research only. No main merge, deployment, live order, cancellation, liquidation, account change, approval change or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent research checkpoint: `c4fc1966a5b67251820a97a93344653fa9d0758e`.
- Research branch: `research/v26-strategy-search-r3-20260919`.
- C19-C21 were frozen in `experiment-manifest.json` at remote head `a3dcc9c7c9ad089844784ac2878d14a65945f918` before outcomes were read.
- Pure integrity and candidate regressions: 24/24 passed.
- Capital 30 USDT, leverage 3x, one concurrent position, existing BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit policy: `STRENGTH_LOSS_V1`; no time-only exit.

## Completed replay

Development window (already used, never described as holdout):
`2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Funding came from an explicit verified-coverage cache for all 27 symbols with candidate opportunities. Twenty-six entries were reused from the prior verified cache and the single missing symbol was fetched from Binance USD-M funding history. No missing funding was replaced by zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C19 | fresh leader rotation | 0 | 0-0 | 0.00000 | 0.0000% | 0.000 | 0.00000 | 0.00000 | 0.00000 | NA |
| C20 | account-feasible higher-low ladder | 8 | 2-6 | -0.23457 | -0.7819% | 0.216 | -0.29389 | -0.29031 | -0.12773 | -0.04985 |
| C21 | two-pulse orderly reset | 0 | 0-0 | 0.00000 | 0.0000% | 0.000 | 0.00000 | 0.00000 | 0.00000 | NA |

C19 produced two pre-account opportunities, but both failed the unchanged minimum-order risk budget. C21 produced no opportunities. Zero-trade results are failures, not evidence. C20 was executable but failed every economic gate; its opportunity-level diagnostic was also negative (32 trades, net -0.60672 USDT, PF 0.497).

Walk-forward and the reserved unused final holdout were not consumed because no candidate passed development.

## State

`no_robust_edge_found=true`

The next iteration begins at C22. Do not loosen or micro-tune C19-C21. Move to a different axis such as liquidity-normalized return efficiency and cross-sectional breadth/dispersion, while preserving all account protections.
