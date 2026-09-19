# V26 strategy search R14 checkpoint

Generated: 2026-09-19

Research only; no main merge, deployment, live order, account, approval or circuit change was performed.

## Baseline and preregistration

- Validator baseline: `f5ee84bfd5449189d73ccee56aabcbd51a2de53a`.
- Parent checkpoint: `66deaa11e3708d2eb0ea7ef9e651e86ec12f7a26`.
- Branch: `research/v26-strategy-search-r14-20260920`.
- C38 was frozen at `c744acc44f8122aa23e14cf1846bf5b10c97d377` before outcomes were read.
- Regression suite: 35/35 passed.
- Capital 30 USDT, leverage 3x, one position, BOO risk policy, `solveQuantity.plan.quantity`, cash buffer and exchange filters were preserved.
- Exit: `STRENGTH_LOSS_V1`; no time-only exit.

## Replay result

Used development window: `2026-08-19T15:10:00Z` to `2026-09-18T15:10:00Z`.

Verified official Binance funding cache coverage existed for all 29 symbols required by this replay. No missing funding interval was treated as zero.

| Candidate | Structure | Trades | W-L | Net USDT | Return | PF | MDD USDT | Top-1 removed | Stress 2x net | LCB/trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C38 | C34 compression-expansion plus existing market participation | 6 | 1-5 | -0.20955 | -0.6985% | 0.2228 | -0.20955 | -0.26963 | +0.60032 | -0.06860 |

Top-three winners removed net was -0.20226 USDT and top-five removed net was -0.06939 USDT. The opportunity-level diagnostic had 14 executable trades, 6 wins, 8 losses, net +0.55200 USDT and PF 2.3778.

C38 failed executable profitability, PF, sample (6 < 30), active-day (4 < 10), top-winner and confidence-bound gates. The positive 2x cost path is not robustness evidence: the higher cost assumptions changed quantity/order eligibility and therefore the realized account sequence; baseline remained negative, its top-winner removal was negative, and 2x top-three removal and LCB were also negative. Stress 4x had only one losing trade.

Walk-forward and reserved holdout were not consumed.

`no_robust_edge_found=true`

Next: C39. Leave the static participation interaction and queue axes. Test a preregistered market breadth inflection structure: require participation and BTC momentum to be improving across completed scanner snapshots, not merely above a static level, while retaining the unchanged C34 setup, thresholds, risk policy and account protections.
