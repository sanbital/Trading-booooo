# V10-H Q/R — Cross-venue pressure-spread relative value

Frozen before any future-return query for Q/R.

Economic mechanism: in structural NEUTRAL, the relative aggressive-flow imbalance between Upbit spot and Binance becomes extreme. The spot venue's own L2/microprice confirms the sign while absolute one-minute price movement remains bounded. Enter Binance in the sign of `Upbit fast pressure - Binance fast pressure` and expect cross-venue flow information to propagate.

Common quality:
- immutable `v10_h_scanner_crossvenue_pairs`
- both dataQuality >= 0.80
- both tradeCount >= 100
- BASE/STRESS round trip = 14/23 bps
- 30m and 60m fixed Binance time exits
- outcome matching only from same-asset Binance scanner observation in [target,target+3m]
- 30-minute same-asset clustering for independent-event counts

## H-Q strict

LONG:
- `up_pressure_fast - bin_pressure_fast >= +1.10`
- Upbit microprice displacement >= +1.5 bps
- Upbit book imbalance >= +0.05
- Upbit volume ratio >= 1.00
- abs Upbit M1 move <= 60 bps
- abs Binance M1 move <= 50 bps

SHORT is exact sign mirror with pressure spread <= -1.10, Upbit microprice <= -1.5 bps and book <= -0.05.

## H-R neighbor

LONG:
- pressure spread >= +0.90
- Upbit microprice >= +1.0 bps
- Upbit book imbalance >= +0.03
- Upbit volume ratio >= 0.80
- abs Upbit M1 move <= 70 bps
- abs Binance M1 move <= 60 bps

SHORT is exact sign mirror.

No threshold changes after this commit.