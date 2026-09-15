# V24 — The three rules

Implementation: `supabase/functions/_shared/v24-leader-continuation.mjs`
Tests: `supabase/functions/_shared/v24-leader-continuation.test.ts` (51 tests, passing)

Every function is pure: no IO, no clock, no exchange access, no order submission. Each
takes an explicit `now` and only sees bars whose `closeMs < now`, so the same code can
run in the executor and in a replay without look-ahead.

**Validation status: all thresholds below are PREREGISTERED STARTING VALUES.**
`parametersValidatedByBacktest` is `false` and stays false. Nothing here is promoted to
live trading. See `HYPOTHESIS_TEST_20260915.md` for why.

Units, never mixed: `return` = decimal price fraction (unleveraged) · `bps` = return ×
10 000 · `atr` = price units · `usdt` = account currency after leverage · `R0` = initial
price risk in USDT = `q0 × (E − S0)`.

Missing or insufficient data is **UNKNOWN**. UNKNOWN never passes a gate, is never
coerced to a neutral value, and is never read as "not weak, therefore fine".

---

## 1. Entry rule

```
ENTRY = LEADER ∧ TREND ∧ (SETUP_A ∨ SETUP_B) ∧ ORDER_FLOW_CONFIRMED
              ∧ DATA_VALID ∧ COST_EDGE_VALID ∧ RISK_VALID
```

State machine, each stage recording its pass/fail reason code:
`UNIVERSE → LEADER → SETUP_FORMING → TRIGGER_CONFIRMED → EXECUTION_CHECKED → ENTRY_INTENT`

### LEADER — `leaderGate`, `rankLeaders`, `dayReturn`

| Condition | Value | Source |
|---|---|---|
| KST day return | **> 0** (strictly) | `GET /fapi/v1/klines` 15m |
| Rank by day return | **≤ 10** | computed across the full universe |
| 24h quote volume | **≥ 5 000 000 USDT** | 96 × closed 15m `quoteVolume` |

KST 00:00 = UTC 15:00 of the previous day. `dayOpen` must be the open of the 15m bar
that *starts* the KST day; if that bar is absent the symbol is UNKNOWN, never
substituted with a UTC open or with whatever bar happens to be first. At exactly
midnight the just-completed day is ranked, not an unopened new one.

Universe: `GET /fapi/v1/exchangeInfo`, `status=TRADING`, `contractType=PERPETUAL`,
`quoteAsset=USDT`, `underlyingType=COIN`. Equity/commodity/index `TRADIFI_PERPETUAL`
contracts are separated by `underlyingType`, never by guessing from the symbol string.

**Not a rejection reason**: a large day gain. +20 %, +40 %, +80 % all stay eligible —
covered by a dedicated test. Rank alone is also not a buy: it only opens the gate.

### TREND — `trendGate`, closed 5m bars

| Condition | Value |
|---|---|
| `close_5m > EMA21_5m` | required |
| `EMA9_5m > EMA21_5m` | required |
| `EMA21_5m > EMA21_5m[−3 bars]` | required |
| `RS15 = r_symbol_15m − r_BTC_15m` | **> 0** |
| `RVOL15` | **≥ 1.5** |

`RVOL15` = last closed 15m quote volume ÷ median of the previous 96 comparable buckets,
**current bucket excluded**. A partly elapsed bar is never compared against completed ones.

BTC shapes relative strength; it is **not** a hard on/off switch, and BTC being up is
never taken as evidence that an altcoin will rise. EMA50 and RSI are research variables
only — not gates, and RSI > 70 is explicitly not a rejection.

### SETUP — two paths, recorded under separate `setupId`s

**SETUP_A — pullback *or* consolidation, then re-acceleration** (`setupA`, closed 1m)

- Consolidation is anchored on the **swing high**, not on a "high ≤ breakLevel" walk-back:
  the latter silently absorbs the leg bar whose high *equals* the level, overstating the
  pullback and inflating its volume. Length must be 2–8 closed bars.
- Consolidation quote volume **<** the advance into that high, compared over the same
  number of bars so a longer window cannot beat a shorter one.
- Trigger close reclaims the setup's **anchored VWAP**.
- Trigger close **>** highest high of the previous 3 closed 1m bars.
- `RVOL1 ≥ 1.5` (median of the previous 20 closed 1m bars, current excluded).

A deep retracement is **not** required. A flat consolidation that breaks upward
qualifies on the same path — covered by a test.

**SETUP_B — breakout continuation** (`setupB`, closed 1m)

- Trigger close **>** highest high of the previous 15 closed 1m bars.
- Price stays above the breakout level for **≥ 10 s** after confirmation, proven by an
  explicit dwell observation. **A missing proof is UNKNOWN, never an implicit pass.**
- Quote volume and aggressive-buy share both expanding vs. the prior bar.
- Stop structure taken from the base the breakout came out of.

This is the path that reaches a leader which never pulls back.

**Chase cap** (`chaseGate`) — never pay more than **0.25 × ATR14_3m** above the trigger.

### ORDER_FLOW_CONFIRMED — `orderFlowGate`

Source: `GET /fapi/v1/aggTrades` / `<symbol>@aggTrade`. `m = false` is an aggressive
**buy**, `m = true` an aggressive **sell**; notional is `p × q`; windows are half-open
`[start, end)` and de-duplicated by aggregate-trade id.

| Condition | Value |
|---|---|
| `buy_share_60s` | **≥ 0.55** |
| `buy_share_180s` | **≥ 0.50** |
| `delta_60s = B − S` | **> 0** |
| mean `imbalance_25bps` over 30 s | **≥ 0.05** |
| price still above the trigger level | required |
| sample floor | ≥ 8 aggregate trades **and** ≥ 2 000 USDT in 60 s |

A 60-second burst **cannot** overwrite 3-minute selling — both scales must agree, and a
thin tape fails as `FLOW_SAMPLE_INSUFFICIENT` rather than passing as "not weak". Heavy
aggressive buying that fails to move price is recorded as `BUY_ABSORBED`.

**This is the change from production.** Deployed E1 defers only when
`return10s < −0.002` **and** `buyShare10s < 0.45` — i.e. it admits on "not strongly
weak", from a 10-second window, with no 60 s or 180 s aggregate anywhere in the path.

### COST_EDGE_VALID — `costEdgeGate`, `executionCostBps`

```
execution_cost_bps = (P_buy(q) − P_sell(q)) / mid × 10 000
                   + (entry_fee_rate + exit_fee_rate) × 10 000
                   + latency_reserve_bps
```

`P_buy`/`P_sell` are obtained by **walking the real book** (`GET /fapi/v1/depth`), so
spread and depth impact are already inside that first term and are **not** added again.
Insufficient depth returns UNKNOWN — never "fillable". Funding stays a separate signed
cashflow and is not folded in.

| Condition | Value |
|---|---|
| `spread_bps` | **≤ 10** |
| order notional | **≤ 5 %** of the thinner 25 bps side |
| expected edge | **≥ 2 × cost** |
| edge samples | **≥ 30** |

With fewer than 30 samples the gate returns `EDGE_SAMPLE_INSUFFICIENT`. There is no
default win probability. **Measured cost on this account is 5.000 bps/side, 100 % taker,
median entry spread 4.22 bps → a ~15 bps round-trip floor.**

This is also a change from production: the deployed executor computes `expectedCostBps`
and writes it into `request_payload.e1`, but no branch compares it to an edge.

---

## 2. Take-profit rule

No fixed +0.5 % / +1 % full exit. Equally, no unlimited give-back of profit already earned.

### Net realisable profit — `netRealisable`

```
G(t) = realised gross on closed parts
     + remaining × (executable sell VWAP − E)
     + funding cashflow (signed)
     − fees already paid
     − estimated fee to close the remainder
     − latency reserve not yet expressed in price
```

Priced at what the **book can actually fill**, not at the last trade. If the remainder
cannot be priced, `G` is UNKNOWN — not 0. Slippage already inside a real fill price is
**not** subtracted again. For a LONG, positive funding is a cost (tested both directions).

`M(t) = max(0, max G observed)`. Chart MFE and realisable `M` are stored separately.

### Profit lock — `profitLockFloor`

| Excursion | Floor on `G` |
|---|---|
| `M < 1.0 R0` | **no lock** — a trade that has merely twitched up is not forced into a fee-scale scratch |
| `M ≥ 1.0 R0` | at least **0.20 R0** |
| `M ≥ 2.0 R0` | at least **0.60 × M** |

The floor never decreases. `G ≤ F` produces a profit-lock exit *intent* — it is a floor
on intent, not a guarantee about the fill; a gap can still print through it.

### Trend hold — `trailLevel`

No fixed upside target for the runner. The protective level is the **higher** of:

- last **confirmed** 3m higher-low − `0.20 × ATR14_3m`
- running peak − `2.0 × ATR14_3m`

and never below the level already in force. A SELL trigger rounds **up**, so rounding
cannot widen the loss. A higher-low counts only if confirmed by bars closed at or
before `now`; a low identifiable only with later bars is look-ahead and is rejected.

### Momentum break — `momentumBreak`

Exit when structure **and** flow both fail:

- closed 1m close below the confirmed support low **∧** `buy_share_60s < 0.45`
  **∧** mean `imbalance_25bps < −0.10`, **or**
- two closed 3m bars below `EMA21_3m` **∧** `buy_share_180s < 0.50`.

Several EMA readings are not counted as several independent pieces of evidence.

### Partial take-profit

**Deliberately not enabled.** Kept as the P0 / P1 comparison the brief specifies
(P0 = no partial, P1 = 25 % at 1.5R + 25 % at 2.5R, 50 % trailed). Choosing between them
requires validation this data cannot supply, and adding partials also adds minimum-order,
residual-quantity and extra-fee effects that must be measured, not assumed.

---

## 3. Stop-loss rule

### Initial structural stop — `structuralStop`

```
S0 = setup_low − max(2 × tick_size, 0.20 × ATR14_3m)      (rounded DOWN for a LONG)
```

Fixed **before** the order is dispatched. For SETUP_B, `setup_low` is the structural
support of the base the breakout came from.

No single flat −1 % / −1.5 % / −2.5 % for every symbol. Equally, "it is volatile" does
not license an unbounded loss: `maxStopDistancePct = 0.035` caps it, and beyond that the
signal is skipped rather than stretched.

**This is the change from production**, where `POLICY.stopPct = 0.025` is applied
identically to every symbol regardless of ATR or structure, and where R5's risk cut
needs +1 % MFE or 10 minutes to arm — so a trade that falls straight from entry rides
the full −2.5 %. That bucket is the single largest loss cluster in the real ledger
(34 trades, −103.7 USDT).

### Size from risk — `sizePosition`

```
per_unit_loss = (E − S0) + E×entry_fee + S0×exit_fee + E×slip_reserve
q_risk        = risk_budget / per_unit_loss
q_final       = floor_to_step( min(q_risk, q_notional, q_margin, q_liquidity) )
```

`risk_budget` = min(the approved per-trade loss limit, 0.5 % of equity).
`q_liquidity` = 5 % of the thinner 25 bps side.

**The stop is never moved up to fit the risk budget.** A wider stop produces a *smaller*
position (tested), and if it is still not viable the signal is skipped. Below the
exchange minimum, no order — the risk limit is never raised to manufacture one.

> **Slippage reserve, measured.** Realised stop slippage against the recorded trigger is
> −3.5 bps mean on the exchange-resident native stop (p05 −48.6, worst −348.5) versus
> **−89.4 bps mean on the bot-driven market close** (p05 −251.7). The default 2 bps
> reserve is a *median* assumption; sizing that must survive the tail should use the p05.
> This is flagged as a parameter to set deliberately, not changed silently.

### Early failure — `earlyFailure`, first 5 minutes

Price has lost the trigger/setup support **∧** `buy_share_60s < 0.45` **∧** at least one of:

- 3-minute flow also selling
- 25 bps bid depth down ≥ 40 % on a like-for-like band
- mean `imbalance_25bps < −0.10`

A single print or one-tick book flicker is not enough (tested). Bid-depth comparison must
be band-matched, or a price move alone looks like vanishing liquidity. The hard stop is
exempt from every confirmation delay and is evaluated first in `evaluateExit`.

### Time stop — `timeStop`, after 5 minutes

`M < 0.30 R0` **∧** price not holding above the trigger **∧** `buy_share_180s ≤ 0.50`.

Small profit alone never triggers it: a consolidation whose structure and flow are still
intact is held (tested).

### Standing protections

- Exchange-native hard stop is the last line of defence and is **~25× cheaper** than the
  bot-driven fallback — keep it enabled.
- A registered protective order is never removed because of a data outage.
- A LONG's protective level never moves down.
- No averaging down, no martingale, no leverage increase to recover a loss.
- No re-entry on the same signal after a stop: a new setup and recovered flow are
  required, with a 5-minute cooldown (`reentryAllowed`).
- A single symbol's data fault is isolated to that symbol; if total account exposure
  cannot be established, new entries stop while existing protection continues.

---

## Outputs

**Entry** — `ENTER | SKIP`, `state`, `setupId`, `setupType`, `policyVersion`,
`signalTime`, `reasonCodes[]`, `proposedQuantity`, `initialStop`, `estimatedCostBps`,
`R0`, `dataQuality`.

**Exit** — `HOLD | UPDATE_PROTECTION | REDUCE | EXIT`, with `reason`, `protectionStage`,
`stopPrice`, `G`, `M`, `floor`, `priceBasis`, `remainingQty`, `policyVersion`.

Ordering in `evaluateExit` is deliberate: hard protection → profit lock → early
failure / time stop → momentum break → ratchet-and-hold.

---

## Validation status — read this before using any number above

| Component | Status |
|---|---|
| Implementation + 51 regression tests | **complete, passing** |
| Real-ledger reconstruction (269 round trips) | **complete** |
| Live-code audit (A–H) | **complete** |
| Full-market hypothesis test (654 symbols, 31 days) | **complete — result is NEGATIVE** |
| Entry rule out-of-sample validation | **not achieved** |
| Exit rule A/B comparison | **attempted; baseline failed validation** |
| Book-dependent gates | **untestable historically — no depth data exists** |
| Live promotion | **NOT DONE and not recommended** |

The top-10 KST day-gainer LONG continuation premium is absent, and mildly reversed, over
2026-08-15 … 2026-09-15 — in a market where BTC gained 22 %. At symmetric 1 %/1 % over one
hour, a top-10 gainer touches −1 % **before** +1 % in 63.7 % of cases. Every TP/SL pairing
tested falls 25–50 points short of its break-even first-touch rate, before costs.

The rules above are a better-specified implementation of the strategy. They are **not**
evidence that the strategy makes money, and they must not be promoted on the strength of
being better-specified.
