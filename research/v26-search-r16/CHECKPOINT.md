# V26 strategy search R16 checkpoint

Generated: 2026-09-20

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `eda03ac6729f46593c2647406db6a12f85f501ef`.
- Branch: `research/v26-strategy-search-r16-20260920`.
- C40 was frozen at `c33251a4d22042e7576d26dc75d62a79c9d2e17e` before outcomes were read.
- Regression suite: 37/37 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C40 | strict two-snapshot rank acceleration plus recent-half contribution | 0 | 0-0 | 0.00000 | 0.0000% | 0.0000 | 0.00000 | 0.00000 | 0.00000 | NA |

C40 produced no executable or shadow opportunities. Of 723 filtered signals, 267 setups expired, 142 became chase-expired, 295 lacked both required historical eligible-rank observations and 19 failed the frozen acceleration rule. Missing rank history was correctly UNKNOWN/reject. Zero trades are a failure, not evidence.

No trade required a funding event, but the verified coverage cache remained configured and no zero substitution occurred. Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C41. Do not relax C40 rank history. Test a broader cross-sectional momentum-freshness score: the proportion of the 24h leader move contributed by the current completed 30m return, ranked among contemporaneous eligible leaders. This directly separates old leaders from currently contributing leaders without another absolute conjunction.
