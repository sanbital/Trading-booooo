# V10-H Production Candidate Lock — H-W

Locked before querying the MAX-3 portfolio path on TEST.

H-W uses the exact H-U signal. No signal threshold changes.

## Signal

Binance USD-M Futures, BTC benchmark D11 RANGE, qv24 >= 2m, six-hour momentum <= -0.5 ATR, six-hour OI change <= -1%, 1h taker flow >= +0.05 and < +0.10, six-hour global long/short delta <= -0.02, bullish reversal candle, next-1h-open entry, entry gap <=0.75 ATR, LONG, fixed six-hour exit, 14/23 bps BASE/STRESS costs.

## Portfolio implementation

- canonical V10 maximum concurrent positions: 3
- at each entry hour, free expired positions first
- fill available slots from simultaneous H-W signals ordered by highest qv24, then market symbol
- no duplicate per-market overlap because the underlying signal simulator already blocks re-entry through each six-hour hold
- no leverage or sizing change is part of H-W selection

## TRAIN MAX-3

26 trades / 24 markets:
- STRESS +198.96 bps/trade
- PF 5.544
- halves +328.35 / +69.57
- remove-best +124.33
- max market share 7.7%

## VALIDATION MAX-3

12 trades / 11 markets:
- STRESS +170.49 bps/trade
- PF 4.488
- halves +71.60 / +269.38
- remove-best +53.24
- max market share 16.7%

## TEST gate

Proceed toward production only if fixed TEST MAX-3 has positive STRESS mean, PF >1.10, and no catastrophic concentration. H-W TEST MAX-3 has not been queried before this lock.
