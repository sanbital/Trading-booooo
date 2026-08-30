# V10 frozen discovery decision

Completed 2026-08-30 03:41 UTC. Decision: **NO_TRADE_NO_VALIDATION_EDGE**.

The preregistered family-wise rule could lock at most one candidate. None of the 24
candidates passed, so the immutable lock contains an empty candidate set. The final
2025-11-02 through 2026-01-01 TEST was neither downloaded nor accessed; `test_metrics`
remains null. This is the required outcome when discovery/validation evidence is absent,
not an incomplete test cycle.

## Best validation configuration in each family

Figures are four-fold validation aggregates. Cumulative bps and drawdown are unit-trade
portfolio replay quantities and should not be read as a fixed-capital percentage without
the locked sizing layer. BASE/STRESS include 14/23 bps round-trip costs respectively.

| Family | Best frozen config | Trades | Days | Win | BASE bps | STRESS bps | Stress/trade | PF | + folds | Stress DD bps |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Flow disagreement | V10_FLOW_DISAGREEMENT_B | 23 | 19 | 39.13% | -494.69 | -701.69 | -30.51 | 0.413 | 1/4 | -735.13 |
| BEAR capitulation recovery LONG | V10_BEAR_CAPITULATION_RECOVERY_B | 114 | 37 | 42.98% | -633.68 | -1,659.68 | -14.56 | 0.736 | 1/4 | -2,573.42 |
| Korean volume-shock transmission | V10_KOREAN_VOLUME_SHOCK_B | 350 | 102 | 38.57% | -7,687.44 | -10,837.44 | -30.96 | 0.516 | 0/4 | -10,896.25 |
| Korean-flow volatility breakout | V10_KOREAN_FLOW_VOL_BREAKOUT_B | 534 | 105 | 41.20% | -8,249.01 | -13,055.01 | -24.45 | 0.483 | 0/4 | -13,055.01 |
| BEAR rebound-failure SHORT | V10_BEAR_REBOUND_FAILURE_B | 756 | 75 | 41.14% | -12,332.07 | -19,136.07 | -25.31 | 0.563 | 0/4 | -19,136.07 |
| KST session transmission | V10_INTRADAY_KST_TRANSMISSION_A | 931 | 113 | 39.10% | -17,801.08 | -26,180.08 | -28.12 | 0.460 | 0/4 | -26,311.65 |
| RANGE VWAP/ATR reversal | V10_RANGE_VWAP_REVERSAL_B | 1,557 | 129 | 37.51% | -31,155.84 | -45,168.84 | -29.01 | 0.468 | 0/4 | -45,566.85 |
| Upbit lead continuation | V10_UPBIT_LEAD_A | 1,832 | 140 | 39.41% | -36,065.75 | -52,553.75 | -28.69 | 0.474 | 0/4 | -52,574.03 |
| Cross-exchange breadth | V10_CROSS_EXCHANGE_BREADTH_B | 2,317 | 142 | 39.92% | -36,327.12 | -57,180.12 | -24.68 | 0.487 | 0/4 | -57,244.37 |
| Upbit/Binance convergence | V10_DIVERGENCE_CONVERGENCE_B | 2,496 | 142 | 40.06% | -44,401.47 | -66,865.47 | -26.79 | 0.562 | 0/4 | -66,865.47 |
| Korean residual rank | V10_KOREAN_RESIDUAL_RANK_B | 3,162 | 144 | 38.55% | -63,096.83 | -91,554.83 | -28.95 | 0.524 | 0/4 | -91,554.83 |
| Binance BTC/ETH beta residual | V10_BINANCE_BETA_RESIDUAL_B | 3,585 | 144 | 40.78% | -64,295.64 | -96,560.64 | -26.93 | 0.594 | 0/4 | -96,798.95 |

The least-negative family was also the sparsest and failed trade-count, signal-day,
stress-PF, mean-return, fold, and neighboring-parameter gates. The only other family
with one positive fold, BEAR capitulation recovery, reversed sharply in the other three
folds. Every family was negative even under BASE costs; therefore no result depends on
the 9 bps BASE-to-STRESS increment.

The machine-readable report includes all 24 configurations and, for each, gross/base/
stress return, trade and day counts, win rate, profit factor, drawdown, 1%/5% tail,
MAE/MFE, turnover, exposure, market/month/regime/side/tactical breakdowns, half-sample
stability, top-winner removal, all chronological folds, gate booleans, and neighbor
evidence.

## Promotion result

- New RANGE strategies: rejected; route to CASH.
- New BEAR continuation SHORT: rejected; route to CASH.
- New BEAR reversal LONG: rejected; route to CASH.
- Existing BULL I46/P10 LONG: preserved from production evidence, not reselected on V10.
- Final TEST access timestamp: null.
- Candidate lock SHA-256: `d7da8d3e6703b2981f174d09e8b900f0753638ee7ed0296111a444455c9a6554`.
- Discovery report SHA-256: `b1b0c1c9d376a2e223545ef5c56395d8e960c7272daa4b641bc031c07fada51f`.
