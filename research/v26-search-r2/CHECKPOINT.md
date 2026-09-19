# V26 strategy search R2 checkpoint

Generated: 2026-09-19

Scope: research only. No main merge, deployment, live order, cancellation, liquidation, account change, approval change or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent research checkpoint: `fc95371430d3d1e6595957534301dcb1d248cc06`.
- Research branch: `research/v26-strategy-search-r2-20260919`.
- C16-C18 were frozen in `experiment-manifest.json` at remote head `cac572bccb0e0624288f4171bd5bee9545d6a61f` before outcomes were read.
- Pure integrity and candidate regressions: 23/23 passed.
- Capital 30 USDT, leverage 3x, one concurrent position, existing BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit policy: `STRENGTH_LOSS_V1`; no time-only exit.

## Completed replay

Development window (already used, never described as holdout):
`2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Funding came from an explicit verified-coverage cache for all 144 symbols with candidate opportunities. Seventy-three entries were reused from the prior verified cache and 71 missing symbols were fetched from Binance USD-M funding history. No missing funding was replaced by zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C16 | pullback absorption and reference reclaim | 4 | 1-3 | -0.09351 | -0.3117% | 0.373 | -0.22283 | -0.14925 | -0.13328 | -0.05466 |
| C17 | BTC-relative strength residual reacceleration | 3 | 0-3 | -0.20482 | -0.6827% | 0.000 | -0.21248 | -0.13848 | -0.27331 | -0.06877 |
| C18 | failed-breakdown sweep and buyer-flow reclaim | 5 | 1-4 | -0.10727 | -0.3576% | 0.342 | -0.16115 | -0.16301 | -0.17111 | -0.03057 |

All three failed the initial development gates: negative account-level net PnL and return, PF below 1.2, negative top-winner-removed net, negative day-block lower bound, fewer than 30 account trades and fewer than 10 active days. C18's opportunity-level shadow diagnostic was positive, but the executable account replay remained negative under unchanged min-notional, slot and loss-limit protections; the shadow result is not account performance and is not promotion evidence.

Walk-forward and the reserved unused final holdout were not consumed. A development-failing candidate cannot be rescued by inspecting independent evidence.

## State

`no_robust_edge_found=true`

The next iteration begins at C19 and must use a new structural hypothesis. Do not tune C16-C18 against this now-viewed outcome. A useful next axis is market-regime-conditioned leader rotation or account-feasible structural geometry that preserves every risk limit, rather than another pullback/reclaim threshold variation.
