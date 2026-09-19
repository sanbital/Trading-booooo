# V26 strategy search R1 checkpoint

Generated: 2026-09-19

Scope: research only. No main merge, deployment, live order, cancellation, liquidation, account change, approval change or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Research branch: `research/v26-strategy-search-r1-20260919`.
- C13-C15 were frozen in `experiment-manifest.json` before outcomes were read.
- Pure integrity and candidate regressions: 22/22 passed.
- Capital 30 USDT, leverage 3x, one concurrent position, existing BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit policy: `STRENGTH_LOSS_V1`; no time-only exit.

## Completed replay

Development window (already used, never described as holdout):
`2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

All costs use the frozen validator model. Funding came from a verified coverage cache built from successful Binance USD-M funding-history responses for all 76 symbols with opportunities. A transient direct-provider timeout invalidated the first attempt before any summary was produced; the completed replay used the full-coverage cache and did not substitute zero funding.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C13 | price + taker-buy acceleration | 5 | 1-4 | -0.12330 | -0.4110% | 0.176 | -0.15418 | -0.14970 | -0.19635 | -0.05394 |
| C14 | compression to buyer-led expansion | 7 | 2-5 | -0.26280 | -0.8760% | 0.040 | -0.26280 | -0.27127 | -0.06787 | -0.05678 |
| C15 | persistent cross-sectional leader | 7 | 2-5 | -0.12973 | -0.4324% | 0.472 | -0.25904 | -0.18981 | -0.19236 | -0.04633 |

All three failed the initial development gates: negative net PnL and return, PF below 1.2, negative top-winner-removed net, negative day-block bootstrap lower bound, fewer than 30 account trades and fewer than 10 active days. Therefore walk-forward and the reserved unused final holdout were not consumed; running them cannot make a development-failing candidate eligible and would waste independent evidence.

## State

`no_robust_edge_found=true`

The next iteration must use new candidate IDs and a structurally different hypothesis. It must not tune C13-C15 thresholds against this now-viewed outcome.
