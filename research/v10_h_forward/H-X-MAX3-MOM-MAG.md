# V10-H H-X — MAX3 Momentum-Ranked Portfolio

Frozen before TEST evaluation.

Signal filter inherits H-U exactly:
- candidate: `D11_RANGE_DELEVER_REBOUND_A_H6`
- structural benchmark: RANGE
- 6h momentum <= -0.5 ATR
- 6h OI change <= -1%
- current taker flow reversal band: +0.05 <= flow1 < +0.10
- 6h global long/short ratio delta <= -0.02
- reversal candle: close > open
- qv24 >= 2,000,000
- next 1h open entry, max entry gap <= 0.75 ATR
- hold 6 hours
- base/stress round-trip cost: 14/23 bps

Portfolio rule:
- max concurrent positions: 3
- no duplicate market while a prior position in that market is active
- when multiple eligible signals share an entry time and capacity is constrained, rank by `abs(momentum6_atr)` descending; tie-break by market name
- no TEST information was used to choose this rule

TRAIN result:
- trades 26
- markets 24
- stress +208.86 bps/trade
- PF 5.771
- chronological halves +328.35 / +89.38 bps/trade
- best-trade removal +134.63 bps/trade

VALIDATION result:
- trades 12
- markets 11
- stress +170.49 bps/trade
- PF 4.488
- chronological halves +71.60 / +269.38 bps/trade
- best-trade removal +53.24 bps/trade

TEST remains unopened for this exact portfolio rule at freeze time.
