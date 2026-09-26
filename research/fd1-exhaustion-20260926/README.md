# FD1 low-MFE entry losses — root cause, evidence-layer change and A/B (2026-09-26)

Scope: the production V17/FD1 live loss streak of 2026-09-26 00:21–12:21 KST ("enters often, barely
rises, exits within minutes via native stop or GPT EXIT"). Leverage 3x, 150 USDT/slot margin cap,
MAX_SLOTS 10, native stop and all protection are unchanged by this work.

## 0. What production actually runs

Executor v90 runs the unmerged branch `release/doa-capture-20260925` (commit `f606f61`): ENTRY prompt
hash `6861e409…`, RECHECK `11c8b72d…`, HOLD `f7af874f…`. `main` (`5d1effd9…` ENTRY) was used only until
2026-09-25 13:25 UTC. This branch is built on `f606f61`, so it does not revert the live DOA capture
context. `main` was **not** used as the baseline.

## 1. The 12 hours (DB, positions entered 00:21–12:21 KST)

12 entries, 11 closed: 3 wins / 8 losses, net −38.21 USDT, mean hold 16.35 min, exits 8 native stop
(of which 6 at the R5 −1.2% risk cut) / 3 FD1 GPT EXIT. Mean MFE 0.995% (losers 0.418%); 7 of 8 losers
never reached +1%. Execution was not the problem: fill vs last close −20…+26 bps (mean ≈ +2 bps),
trigger→fill 19–41 s, every FINAL RECHECK was the forced `INITIAL_ANSWER_AGED` re-ask and answered BUY.

Per-trade reconstruction (facts = the exact production packet; post-exit = next 60 min):

| trade | pnl | MFE | fatigue axes weak at entry | taker5 | accel 5/15 · 15/60 | min since 60m high | prior same-symbol | post-exit 60m high |
|---|---:|---:|---|---:|---|---:|---|---:|
| PROM 02:16 (win) | +3.77 | 2.09% | none | 0.68 | +.0085 · +.0059 | 0 | — | +1.47% |
| GRASS 02:20 (win) | +9.93 | 3.94% | none | 0.70 | +.0009 · +.0049 | 0 | — | +6.22% |
| GRASS 02:49 | −11.40 | 0.08% | PRICE, FLOW, PARTICIPATION, BOOK | 0.46 | −.0003 · −.0047 | 17 | win 15 min earlier, no new high since | +3.09% |
| GRASS 03:31 (win) | +0.66 | 1.56% | PARTICIPATION | 0.55 | −.0054 · +.0151 | 9 | loss 36 min earlier, new high since | +1.96% |
| ARK 03:52 | −5.88 | 0.65% | none | 0.60 | +.0073 · +.0040 | 0 | — | +0.24% |
| PROM 04:07 | −9.15 | 0.31% | none | 0.61 | +.0047 · +.0180 | 0 | win 99 min earlier, new high | −0.72% |
| LDO 05:09 | −6.04 | 0.39% | (OI falling only) | 0.51 | +.0041 · −.0057 | 0 | — | −0.23% |
| SEI 05:25 | −5.86 | 0.21% | none | 0.53 | −.0026 · +.0083 | 0 | — | −0.45% |
| EIGEN 05:28 | −4.15 | 0.97% | none | 0.69 | +.0095 · −.0023 | 0 | — | −1.05% |
| WLD 08:24 | −4.24 | 0.68% | none | 0.56 | −.0036 · +.0135 | 0 | — | +2.58% |
| SEI 10:21 | −5.85 | 0.06% | none | 0.65 | +.0014 · +.0103 | 0 | — | −0.62% |

Only GRASS 02:49 shows the exhaustion signature. Most losers had *strong* current propulsion at entry
(at the 60m high, taker 0.53–0.69, accelerating) and then reversed; the post-exit paths show the exits
were right.

## 2. Root cause, in order of weight

1. **The candidate universe itself had negative expectancy, and GPT added almost no selection.**
   Replaying all 3,092 V17 candidates (09-02..09-26) through the live R5 exit on 1m klines:
   −1.46 USDT/trade (450 notional, 0.1% fees). Current generator (09-17+): −1.21; last 7d −2.87 over
   all candidates; last 12h −3.55. GPT ENTRY (FD1 era, 151 decisions) bought 84%; its BUYs made
   −1.36/trade vs −1.52 for its SKIPs. 119 of 126 BUYs cited *only* `return_*` trend facts as support.
2. **The ENTRY question and contract reward trend, not propulsion.** A BUY needs two up facts incl. one
   price/flow fact; every V17 candidate satisfies this with returns alone (the generator requires them).
   GPT's `downside_pct` anchored to the 2.5% stop constant while the real loss is the −1.2% risk cut.
3. **The risk bands only detect collapse.** On the 150 production ENTRY packets: MOMENTUM_FADED 0/150
   (impossible on a V17 trigger), SELL_DOMINANCE 6, SELL_WALL 6, PUMP_REVERSAL 1. So `risk_soft` was
   empty on the losers; SKIP was only reachable via EV_UNFAVORABLE (needs NEGATIVE ev and downside>upside).
4. **No same-symbol memory** reached GPT; GRASS was re-bought 15 min after exiting a winner, with no new
   high, all fatigue axes weak.
5. **CEC0040 was shown as a per-candidate REJECT/effective_allowed=false** although it is one
   strategy-wide EWMA with a round-robin probe schedule (every 3rd rejected signal = PROBE).
6. **Cooldown declaration vs behaviour.** `POLICY.cooldownMs=30min` is consumed only in the signal
   generator, measured from `now()` (≈5 min after the new bar), so bars 25 min apart passed
   (GRASS 02:10→02:35 KST). It is not an exit cooldown; executor/admission do not use it.

What the data does **not** support (so it was not built):
- Point-in-time facts carry little out-of-sample signal: gradient boosting / ridge trained on 09-02..16,
  tested on 09-17..26: corr(pred, net) −0.12…+0.01 (reverse split 0.01); low-MFE AUC 0.57.
- No fatigue axis or pair of axes lowers per-trade EV consistently in both halves. Every deterministic
  gate tried (≥2 or ≥3 axes, PRICE&FLOW, +CEC, hard cooldowns) only removes trades: 30d average per trade
  stays −1.46.
- CEC REJECT vs PROBE: 12h −4.62 vs −2.76, 24h −3.10 vs −1.50, 48h −1.54 vs −1.55, 7d −1.42 vs −3.02;
  corr(prediction, outcome) −0.005. Its 12h "accuracy" is chance. No veto.
- Open-interest decline is *not* weakness here: falling 5m OI did better in both halves.
- Re-entries overall (−0.75/trade) beat first entries (−1.58). Hard 30-min post-exit cooldown: 30d
  +194 USDT only by removing 120 trades, average unchanged (−1.46), 44 winners missed.

## 3. Counter-hypotheses

| hypothesis | verdict | evidence |
|---|---|---|
| 1 stop too tight | rejected | removing the −1.2% risk cut: current −1.21→−1.53, legacy −1.55→−1.91; −1.8% cut or 20-min arm also worse |
| 2 bad regime | partly supported | all candidates 12h −3.55 vs prior 6.5d −2.83; GPT BUYs ≈ universe in the window (−3.77 vs −3.55) |
| 3 slippage/latency | rejected | fills −20…+26 bps, mean ≈ +2 bps; 19–41 s trigger→fill |
| 4 FINAL RECHECK stale | minor | all rechecks were AGED re-asks on fresh facts; it had no propulsion/fatigue comparison (now added) |
| 5 5m closed-candle lag | not the cause | entries use 1m trigger; most losers were at the 60m high at entry |
| 6 prompt weighting | supported | trend-only support, 84% BUY, EV anchored on stop constant |
| 7 late-stage universe | weakly supported | current sample: return_4h>25% −3.47/trade, day_return>25% −2.48; not in legacy |

## 4–7. Change, risks, selection, A/B

See sections below (A/B filled from `fd1_replay_jobs` run tags `x26-base` / `x26-new`).
