# V10-H Candidate Lock — H-U RANGE Delever Rebound

Locked before querying H-U performance on D11 TEST events.

## Economic mechanism

A structural RANGE market experiences a six-hour downside displacement and open-interest deleveraging. The rebound candle has turned positive and global long/short positioning has fallen. The key refinement is that the first-hour taker flow must be only mildly positive: a small 5-10% buy imbalance is interpreted as exhaustion/recovery confirmation; >10% aggressive buying is treated as chase/instability and excluded.

This refinement was chosen from TRAIN+VALIDATION event-level evidence only. H-U TEST-filtered performance has not been queried before this lock.

## Exact production/research rule

Source semantics inherited unchanged from `REGIME_ROUTER_V8_OI_POSITIONING_1H_30D_D11_SELECT` / `D11_RANGE_DELEVER_REBOUND_A_H6`:

- venue: Binance USD-M Futures
- benchmark regime: BTC 1h exact D11 RANGE classifier
- market qv24 >= 2,000,000 quote
- ATR > 0
- six-hour momentum <= -0.5 ATR
- six-hour open-interest change <= -1.0%
- **current 1h taker-flow imbalance >= +0.05 and < +0.10**
- six-hour global long/short account-ratio delta <= -0.02
- signal candle closes above open
- entry at next 1h open
- reject entry gap > 0.75 ATR from signal close
- LONG only
- fixed hold: 6 hours
- BASE cost: 14 bps round trip
- STRESS cost: 23 bps round trip
- market-level research permits each market independently
- production portfolio: max 1 concurrent position; simultaneous signals ranked by highest qv24

## TRAIN evidence

29 events / 27 markets:
- STRESS mean: +183.06 bps/trade
- PF: 4.755
- chronological halves: +273.37 / +86.30 bps
- remove-best-event STRESS: +115.86 bps
- max market share: 6.9%

## VALIDATION evidence

14 events / 13 markets:
- STRESS mean: +158.17 bps/trade
- PF: 4.775
- chronological halves: +47.09 / +269.26 bps
- remove-best-event STRESS: +58.02 bps
- max market share: 14.3%

Neighbor H-V (flow 0.05-0.12) remained positive but had a negative first validation half, so it is not selected.

## TEST decision gates

H-U may proceed only if the fixed TEST shows:
- >=20 market-level events
- positive STRESS mean
- PF > 1.10
- both chronological halves positive
- remove-best-event STRESS mean positive
- no single market >40%

Then max-one-position portfolio TEST must also be positive under STRESS and PF >1.10. No H-U threshold may change after this commit.
