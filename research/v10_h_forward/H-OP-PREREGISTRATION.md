# V10-H O/P — Futures-flow absorption toward spot

Frozen before any outcome query for O/P.

Economic mechanism: in a structural NEUTRAL market, Upbit spot aggressive flow points strongly one way while Binance aggressive flow points the opposite way. If Binance book/microprice have already rotated toward the Upbit spot direction, the futures-side aggressive flow is being absorbed; enter Binance toward spot-flow convergence.

Common quality:
- immutable `v10_h_scanner_crossvenue_pairs`
- both dataQuality >= 0.80
- both tradeCount >= 100
- 14/23 bps BASE/STRESS costs
- 30m/60m fixed Binance exits

## H-O strict

LONG:
- Upbit fast pressure >= +0.65
- Binance fast pressure <= -0.45
- Upbit book imbalance >= +0.10
- Upbit microprice >= +2.0 bps
- Binance book imbalance >= +0.05
- Binance microprice >= +0.50 bps
- abs Binance M1 move <= 25 bps
- abs Upbit M1 move <= 40 bps

SHORT is exact sign mirror.

## H-P neighbor

LONG:
- Upbit fast pressure >= +0.55
- Binance fast pressure <= -0.35
- Upbit book imbalance >= +0.08
- Upbit microprice >= +1.5 bps
- Binance book imbalance >= +0.03
- Binance microprice >= +0.30 bps
- abs Binance M1 move <= 30 bps
- abs Upbit M1 move <= 50 bps

SHORT is exact sign mirror.

The price caps are RANGE-state exclusion gates, not directional requirements. No threshold changes are permitted after this commit.