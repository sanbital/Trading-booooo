# V24 — Exit-policy comparison: attempted, and why it is NOT reportable

§8-A of the brief asks for "기존 진입 그대로, 청산만 변경" — hold the real entries
fixed and swap only the exit policy. This was built and run. **The result is not
reportable, because the baseline could not be validated against the real trades.**
This document records the attempt, the measurement that killed it, and what would be
needed to do it properly. It exists so the next attempt does not repeat the work.

## What was built

`v24.simulate_exit(position_id, policy)` walks the real 1m path of each real position
(695 166 collected 1m bars covering every live trade window) and applies one exit
policy, using this account's measured costs (5.0 bps/side).

- `OLD_V17_R5` — production as deployed: −2.5 % baseline, R5 risk cut to −1.2 % armed
  by +1 % MFE or 10 min, profit lock capturing 50 % at +2 % MFE, 1.5 % trail armed at
  +3 % MFE, 45 min momentum-stale, 6 h max hold, plus the QV3 two-bearish-1m overlay
  for positions opened after its 2026-09-11T15:20Z cutover.
- `NEW_V24` — structural stop, profit lock on net R, ATR trail, early failure, time stop.

Protection never moves down in either policy. Same-bar touches of both the protection
level and a new high are resolved conservatively (protection first) and flagged.

## Baseline validation — the step that failed

| Sample | Real net | Simulated `OLD_V17_R5` | Error |
|---|---:|---:|---:|
| 122 positions (first coverage batch) | −1.64 | −3.59 | −1.95 |
| **269 positions (full matched set)** | **−38.90** | **+2.31** | **+41.21** |

Correlation on the 122-position batch was 0.739 with a 0.97 USDT mean absolute error —
encouraging. On the full set the aggregate error is **+41 USDT, larger than any effect
the experiment was meant to measure.** A comparison run on this baseline would be
meaningless, so the `NEW_V24` number is deliberately not quoted as a result.

### Where the error lives

| Real exit reason | n | Real net | Sim net | Sim − Real | Real hold | Sim hold |
|---|---:|---:|---:|---:|---:|---:|
| `V17_NATIVE_STOP` | 150 | −31.35 | +5.94 | **+37.28** | 960 s | 799 s |
| `V17_HARD_STOP` | 10 | −41.66 | −12.47 | **+29.19** | 1477 s | 931 s |
| `V17_TRAILING_STOP` | 10 | +35.50 | +8.94 | **−26.56** | 1582 s | 533 s |
| `QV3_TWO_BEARISH_CLOSED` | 72 | +12.80 | +10.78 | −2.03 | 624 s | 581 s |

The overlay that runs on 1-minute closes (QV3) reproduces almost exactly. Everything
driven by the protection ratchet does not — and it misprices **both** tails, letting
losers recover that really stopped out, and cutting winners that really ran.

## The blocker, measured

Production's protective stop is not a static −2.5 % level. `hard_stop_price` is
recorded on every position, and across 318 positions the stop at exit sat on average
only **0.514 %** below entry, ranging from +2.500 % (the untouched initial stop) to
−12.825 % (a stop ratcheted far *above* entry after a large move).

That ratchet is driven by `X1_FAST_OBSERVATION_OVERRIDE_1`, which polls top-of-book at
**1-second** resolution with `maxQuoteAgeMs: 1000`. **A 1-minute kline cannot
reconstruct a level that moved on 1-second observations of the bid.** This is a
data-resolution blocker, not a coding gap: the inputs that set the stop were never
stored, and no public endpoint can recover them after the fact.

Two further gaps compound it:
- Native stops trigger on **mark price**; only contract-price klines are available, and
  `markPriceKlines` is 1m at best, so the trigger instant still cannot be replayed.
- No historical order book exists at all, so every book-dependent gate in the V24 entry
  rule is untestable historically, by construction.

## What this attempt did produce: measured stop slippage

Fill price vs. the stop trigger recorded on the position (negative = filled below the
trigger, adverse for a LONG):

| Exit path | n | mean | p50 | p10 | p05 | worst |
|---|---:|---:|---:|---:|---:|---:|
| `V17_NATIVE_STOP` (exchange-resident) | 155 | **−3.5 bps** | −1.8 | −15.5 | −48.6 | −348.5 |
| `MICRO_HARD_STOP` | 22 | −7.9 bps | −5.7 | −18.3 | −22.6 | −44.0 |
| `V17_HARD_STOP` (bot-driven market close) | 10 | **−89.4 bps** | −60.7 | −234.6 | −251.7 | −268.9 |

Two things follow, and both are usable now:

1. **The exchange-resident stop is ~25× cheaper than the bot-driven fallback** (−3.5 bps
   vs −89.4 bps mean). `NATIVE_STOP_ENABLED` defaults to OFF in the executor
   (`env("V17_NATIVE_STOP")==="true"` is required). Whenever it is off, every stop pays
   the expensive path. It was evidently on for this period — 155 native-stop exits —
   and the measurement argues strongly for keeping it on.
2. **A slippage reserve calibrated to the median is wrong for sizing.** The median
   native stop slips 1.8 bps but the 5th percentile slips 48.6 bps and the worst
   observed 348.5 bps. `sizePosition`'s `slipReserveBps` default of 2 bps is a median
   assumption; position sizing that must survive the tail should use the p05, not the
   median. This is recorded as a parameter to set deliberately, not silently changed.

## What would make the experiment valid

Per §3-B of the brief, this belongs in **forward shadow**, not history:

1. Record, per position and per evaluation tick, the protection level the executor
   actually computed and the top-of-book it computed it from. The executor already
   holds both; they are simply not persisted at tick resolution.
2. Run `NEW_V24` as a shadow policy on the same live ticks, writing its would-be
   decisions alongside — never submitting an order.
3. Compare only after the shadow has accumulated enough independent events, with the
   purge/embargo and minimum-sample rules of §9 applied.

Until then the correct statement is: **the exit-policy change is unvalidated, and
nothing about it is promoted.**
