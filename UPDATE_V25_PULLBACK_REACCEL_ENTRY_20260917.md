# V25 — V17 entry timing: pullback + re-acceleration

`V17_PULLBACK_REACCEL_ENTRY_1`. The V17 strategy, its leader selection, its R5 exit,
its native stop, reconciliation, accounting, lease and isolation are all unchanged.
What changes is **when** a confirmed leader is bought.

## Root cause

V17 measured a 5-minute acceleration and then bought the very next ask, inside 120
seconds, at the top of the move it had just measured. Replayed on real Binance 1m
klines over 601 real merged V17 opportunities (2026-09-10 → 09-17), that entry
returned **−95.48 USDT, −0.169/trade, profit factor 0.841** — while pre-cost PnL was
roughly flat. The direction was a coin flip and the costs decided it. Most losses were
ordinary 10–20 minute pullbacks that stopped the trade out before the move resumed.

Four other things were wrong and are separated from the above rather than folded into it:

1. **Immediate chase entry** — the above. Fixed here.
2. **QV3's premature exit** — it closes a position that has merely paused, which is
   the pause the new entry exists to buy. Worth −14.5 USDT over 43 trades. Moved to
   shadow for new positions only.
3. **The 30 USDT sizing regression** — a fixed 0.12 USDT notional buffer funded out of
   a relative 12 bps price cap, self-refusing at a 90 USDT notional. Fixed in the
   previous commit on this branch (`ddedd95`); unchanged and re-verified here.
4. **E1's quote staleness** — 118 of 118 defers measured 1097–2596 ms against a
   1000 ms policy. Also fixed in `ddedd95`. Its *fast-weak directional watch* is
   narrowed here, because a completed 1m re-acceleration candle is strictly more
   evidence than a 10-second tape window and re-asking would spend half the trigger's
   executable life re-deriving the same answer.
5. **QV3's entry filter** — analysed, **not** changed: measured across all 43
   triggers it would have blocked **0**. It refuses two consecutive lower-close
   bearish 1m bars; the trigger *requires* a bullish bar above the previous close, so
   a trigger implies a QV3 entry pass. Redundant, so it stays as an independent check.

## The new entry

```
V17 leader confirmed (+ dayReturn < 8%, volumeRatio >= 1.30)   ->  ARMED
low <= ref x 0.9975              (>= 0.25% pullback)           ->  PULLBACK_OBSERVED
bullish 1m, close > prev close,
  ref x 1.0025 <= close <= ref x 1.01                          ->  TRIGGERED
fill within 60s of that candle's close                         ->  ENTERED
```

Terminal: `EXPIRED_NO_PULLBACK`, `EXPIRED_NO_REACCEL`, `CHASE_EXPIRED`, `INVALIDATED`,
`CONSUMED`. Every transition carries a reason (`V17_SETUP_ARMED`,
`V17_PULLBACK_CONFIRMED`, `V17_REACCEL_TRIGGERED`, `V17_SETUP_EXPIRED`,
`V17_CHASE_EXPIRED`, `V17_TRIGGER_STALE`, `V17_ENTRY_DRIFT`) so any decision can be
reconstructed from the audit trail.

**The 15-minute window is not a longer signal TTL.** The original signal's execution
lifetime is *replaced* by a new trigger with its own 60-second freshness measured from
the re-acceleration candle's close — stricter than the 120 seconds V17 ran with. The
release gate refuses to ship if that inequality ever inverts. A legacy signal keeps the
120-second rule, side by side, and a setup that never triggers creates no order intent
at all.

A TRIGGERED setup stops reading the tape: it is executed or it expires. It does not
re-arm, so one setup is at most one entry attempt.

## Results (real data, production modules, no lookahead)

Same candidate set for both arms — only the timing differs. Combined 7 days:

| arm | n | WR | net | expectancy | PF | MDD |
|---|---|---|---|---|---|---|
| OLD immediate + R5 | 88 | 43.2% | +24.574 | +0.279 | 1.358 | −15.07 |
| NEW pullback + R5 + QV3 current | 43 | 48.8% | +13.456 | +0.313 | 1.417 | −7.28 |
| NEW pullback + R5 + QV3 off | 43 | 53.5% | **+27.999** | **+0.651** | **1.843** | **−7.46** |

Holdout 24h (untouched): +11.523 net, +1.048/trade, PF 2.110.
Stress: +10 bp → +24.095 (PF 1.689); +20 bp → +20.191 (PF 1.550).
Pullback depth: 0.25% → PF 1.843 (n=43); 0.50% → 1.537 (n=28); 0.75% → 1.962 (n=17).

Entry quality, same symbols and exit: MAE −1.4% → −1.3%, MFE 2.3% → 2.7%,
**MFE capture 0.136 → 0.271**.

## A finding that contradicts the brief

The brief concluded that *when* you buy matters more than *what* you buy. On this data
it is the other way round. Run on the ungated V17 stream, both windows agreeing:

| arm | combined |
|---|---|
| OLD timing, no gate *(stated baseline)* | −95.48 / −0.169 / PF 0.841 |
| OLD timing, with gate *(selection only)* | +23.79 / +0.273 / PF 1.346 |
| NEW timing, no gate *(timing only)* | **−20.40 / −0.098 / PF 0.898** |
| NEW timing, with gate *(both)* | +29.84 / +0.710 / PF 1.969 |

Timing alone does **not** make the system profitable; the `dayReturn < 8%` +
`volumeRatio >= 1.30` gate does, and timing then roughly doubles expectancy and halves
drawdown on top of it. Both are worth shipping. But the gate is the necessary
condition and is the thing to protect — and the next research question is the gate, not
the pullback depth. See `research/v25-pullback-reaccel/README.md`.

## Durability and isolation

Setup state lives on the signal row (`features.v17Setup`), so it survives restarts and
is shared between concurrent executors with no new table. The state machine refuses a
candle it has already consumed, so a retried cycle cannot deepen a low or fire a second
trigger. Setup identity is `version:SYMBOL:signalId:signal5Close` — derivable by two
executors with no coordination.

Positions carry `entryTimingPolicyVersion`, stamped from the **order intent**, so no
later deploy can opt an already-open position into this policy. A new-policy position
is deliberately given **no** authoritative QV3 stamp, which is what keeps `qv3Scope()`
false for it; old positions keep their stamp and their behaviour exactly.

`SETUP_MAX_CONCURRENT = 2` limits this policy's own concurrent entries during its first
live window. It is separate from `MAX_SLOTS = 10`, which is the operator's account-wide
risk limit and is untouched.

## Not changed

Leverage 3x. Per-slot margin 30 USDT. `MAX_SLOTS` 10. `POLICY.maxEntryAgeMs` 120 s.
`POLICY.maxEntryDriftPct` 1%. `E1_POLICY.maxQuoteAgeMs` 1000 ms. R5 in full. BOO
enforcement stays `OBSERVE`; no approval row was created and no DB risk value was
altered. No strategy threshold was tuned and no parameter was re-searched — the five
frozen values are asserted against the researched ones by the release gate.

## Limits

Seven days, 601 opportunities, 43 entries under the production configuration. Enough to
reject the old entry and prefer the new one; **not** a market-wide validation.
`SETUP_POLICY.parametersValidatedByBacktest` is `false`, deliberately. Funding is not
modelled (average hold ~20 min). Lot-step rounding is not modelled in the replay;
its effect is under 1% of notional.
