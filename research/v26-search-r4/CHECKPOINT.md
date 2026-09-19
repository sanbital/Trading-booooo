# V26 strategy search R4 checkpoint

Generated: 2026-09-19

Scope: research only. No main merge, deployment, live order, cancellation, liquidation, account change, approval change or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent research checkpoint: `72bee5c73c40afb533cd5a9a082647c96115e739`.
- Research branch: `research/v26-strategy-search-r4-20260919`.
- C22-C24 were frozen in `experiment-manifest.json` at remote head `5fdd89e009e00b479b032cbf59492815dc2918fe` before outcomes were read.
- Pure integrity and candidate regressions: 25/25 passed.
- Capital 30 USDT, leverage 3x, one concurrent position, existing BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit policy: `STRENGTH_LOSS_V1`; no time-only exit.

## Completed replay

Development window (already used, never described as holdout):
`2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Funding came from an explicit verified-coverage cache for all 79 symbols with candidate opportunities. Seventy-eight entries were reused from prior verified caches and the single missing symbol was fetched from Binance USD-M funding history. No missing funding was replaced by zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C22 | liquidity-adjusted leader efficiency | 14 | 5-9 | -0.35624 | -1.1875% | 0.316 | -0.36390 | -0.41974 | -0.17048 | -0.04544 |
| C23 | selective narrow leader regime | 0 | 0-0 | 0.00000 | 0.0000% | 0.000 | 0.00000 | 0.00000 | 0.00000 | NA |
| C24 | broad distributed trend | 3 | 0-3 | -0.12787 | -0.4262% | 0.000 | -0.20132 | -0.11805 | -0.18802 | -0.06187 |

C23 produced no opportunities and is a failure, not evidence. C22 and C24 were negative at both account and opportunity level. Neither cross-sectional efficiency nor a distributed leader path repaired the entry expectancy under unchanged costs and protections.

Walk-forward and the reserved unused final holdout were not consumed because no candidate passed development.

## State

`no_robust_edge_found=true`

The next iteration begins at C25. Do not loosen or micro-tune C22-C24. Move to a causally different entry sequence such as a completed breakout retest/hold or failed-retest avoidance, while preserving all risk limits.
