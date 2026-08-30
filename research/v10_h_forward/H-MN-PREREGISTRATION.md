# V10-H M/N — Spot-flow lead before Binance response

Frozen before any future-return query for M/N.

Common causal/quality universe is the same immutable `v10_h_scanner_crossvenue_pairs` staging set and the same 14/23 bps BASE/STRESS costs.

Economic mechanism: in structural NEUTRAL, Upbit spot aggressive flow, book and microprice agree strongly in one direction while Binance fast flow remains opposite/weak and Binance price has not yet materially responded. Enter Binance in the Upbit spot-flow direction.

## H-M strict

LONG:
- Upbit move >= +10 bps
- Upbit fast trade pressure >= +0.75
- Upbit book imbalance >= +0.15
- Upbit microprice displacement >= +3.0 bps
- Upbit volume ratio >= 1.20
- Binance fast trade pressure <= +0.15
- Binance move <= +10 bps
- Binance microprice displacement <= +1.0 bps

SHORT is exact sign mirror:
- Upbit move <= -10 bps
- Upbit fast pressure <= -0.75
- Upbit book imbalance <= -0.15
- Upbit microprice <= -3.0 bps
- Upbit volume ratio >= 1.20
- Binance fast pressure >= -0.15
- Binance move >= -10 bps
- Binance microprice >= -1.0 bps

## H-N neighbor

LONG:
- Upbit move >= +5 bps
- Upbit fast pressure >= +0.65
- Upbit book imbalance >= +0.10
- Upbit microprice >= +2.0 bps
- Upbit volume ratio >= 1.00
- Binance fast pressure <= +0.25
- Binance move <= +15 bps
- Binance microprice <= +1.5 bps

SHORT is exact sign mirror.

Common:
- both venue dataQuality >= 0.80
- both venue tradeCount >= 100
- 30m/60m Binance time exits
- future outcome match only from same-asset Binance scanner observation in [target, target+3m]
- 30-minute same-asset clustering for independent-event counts
- no threshold change after this commit
