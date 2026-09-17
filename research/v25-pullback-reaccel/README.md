# V17 entry timing: pullback + re-acceleration

Replay of `V17_PULLBACK_REACCEL_ENTRY_1` against real Binance USDⓈ-M 1m klines and
the real V17 signals production wrote, 2026-09-10 → 2026-09-17.

## What is real here

| input | source |
|---|---|
| candidates | `public.v11_long_regime_signals`, the signals production actually generated (post-`confirm5`, post-cooldown) |
| features | the `features` jsonb on those rows — `dayReturn`, `volumeRatio`, `qv24`, `referenceClose`, `signal5Close` |
| 1m OHLC | `fapi.binance.com/fapi/v1/klines`, fetched read-only through the production DB's `http` extension (no table was created or written) |
| setup logic | `supabase/functions/_shared/leader-pullback-reaccel.mjs` — the module the executor runs |
| exit logic | `leader-exit-review.mjs` R5 — the module the executor runs |
| QV3 | `leader-qv3-rules.mjs` `exitSignal(..., 'ENTRY_EXIT_TWO')` — the module the executor runs |

Nothing about the strategy is reimplemented in this directory. `replay.mjs` only
supplies data, sequences time and accounts for cost.

## No lookahead

Enforced structurally, not by convention:

- `completedCandle()` refuses any bar whose `closeTime >= now`, so a forming candle
  can never advance a setup;
- the earliest entry is the **open of the minute after** the trigger candle closed;
- inside a holding bar the stop is tested against the level fixed at the **end of the
  previous bar**, and only then does the bar's high advance the peak — a bar can
  never raise the stop and fill it in the same minute;
- a gap through the stop fills at the bar's open, not at the stop level.

## Cost model

5 bp taker each side. Every exit additionally pays ≥10 bp adverse slippage (stop and
discretionary alike). Stress runs add +10 bp and +20 bp on top. Funding is **not**
modelled — average hold is ~20 minutes and no funding boundary is crossed by most
trades, but this is an omission, not a zero.

Lot-step rounding is not modelled: per-symbol exchange filters for this window are not
on record for all 56 symbols. Notional is a flat 90 USDT. The sizing contract
guarantees the live quantity reaches ≥90.09 USDT, so the unmodelled effect is under
1% of notional.

## Headline

Gated candidates, same candidate set for both arms, combined 7 days:

| arm | n | win rate | net | expectancy | PF | MDD |
|---|---|---|---|---|---|---|
| OLD immediate entry + R5 | 88 | 43.2% | +24.574 | +0.279 | 1.358 | −15.07 |
| NEW pullback entry + R5 + QV3 current | 43 | 48.8% | +13.456 | +0.313 | 1.417 | −7.28 |
| NEW pullback entry + R5 + QV3 off | 43 | 53.5% | **+27.999** | **+0.651** | **1.843** | **−7.46** |

QV3's exit costs 14.5 USDT across 43 trades — the direction the brief predicted.

## The finding that contradicts the brief

The brief's conclusion was "when you buy matters more than what you buy". On this
sample it is the other way round. Run on the **ungated** V17 stream — 601 real merged
opportunities, both windows agreeing:

| arm | dev 6d | holdout 24h | combined |
|---|---|---|---|
| OLD timing, no gate *(the stated baseline)* | −70.68 / −0.156 / PF 0.855 | −24.81 / −0.221 / PF 0.781 | **−95.48 / −0.169 / PF 0.841** |
| OLD timing, with gate *(selection only)* | +12.15 / +0.176 / PF 1.223 | +11.64 / +0.647 / PF 1.826 | **+23.79 / +0.273 / PF 1.346** |
| NEW timing, no gate *(timing only)* | −14.04 / −0.085 / PF 0.912 | −6.36 / −0.148 / PF 0.846 | **−20.40 / −0.098 / PF 0.898** |
| NEW timing, with gate *(both)* | +17.15 / +0.553 / PF 1.795 | +12.69 / +1.154 / PF 2.378 | **+29.84 / +0.710 / PF 1.969** |

- The stated baseline reproduces: −0.169/trade, PF 0.841 (brief: −0.1803, PF 0.713).
- **Timing alone does not fix it**: −0.098/trade, PF 0.898. Better than −0.169, still
  losing.
- **Selection alone already does**: +0.273/trade, PF 1.346.
- Together they are best, and timing's contribution on top of selection is large:
  expectancy +0.273 → +0.710, PF 1.346 → 1.969, MDD −15.07 → −7.46.

Both changes are worth shipping. But the `dayReturn < 8%` + `volumeRatio ≥ 1.3` gate
is the *necessary* condition and the pullback timing is the amplifier — so the gate is
the thing to protect, and the next research question is the gate, not the pullback
depth.

This is not trade-count reduction flattering the result: the average *trade* improves
at every step, not just the total.

## Does the new entry actually enter better?

| | OLD | NEW |
|---|---|---|
| avg MAE | −1.4% | −1.3% |
| avg MFE | 2.3% | 2.7% |
| MFE capture | 0.136 | **0.271** |

Same symbols, same signals, same exit. The new entry roughly doubles how much of the
favourable excursion the trade keeps.

## Robustness

Pullback depth (combined, QV3 off): 0.25% → +27.999 (PF 1.843, n=43) · 0.50% → +13.224
(PF 1.537, n=28) · 0.75% → +14.265 (PF 1.962, n=17). Positive at every depth, so 0.25%
is the high-sample point of a ridge rather than a peak. Production default stays
0.25%; the parameters were **not** re-searched here.

Cost stress (combined, QV3 off): base +27.999 (PF 1.843) · +10 bp +24.095 (PF 1.689)
· +20 bp +20.191 (PF 1.550).

## Reproduce

```bash
node research/v25-pullback-reaccel/run.mjs             # every arm, split and stress
node research/v25-pullback-reaccel/gate-attribution.mjs all|dev|holdout
node research/v25-pullback-reaccel/find-triggers.mjs 0.0025
```

`data/` holds the fetched klines and the candidate rows. Re-fetching needs the DB's
`http` extension; see the queries in this session's transcript.

## Limits

Seven days, 601 opportunities, 43 entries under the production configuration. That is
enough to reject the old entry and to prefer the new one; it is **not** a market-wide
validation and must not be recorded as one. `SETUP_POLICY.parametersValidatedByBacktest`
is `false` for that reason.
