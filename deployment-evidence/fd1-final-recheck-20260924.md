# GPT FINAL RECHECK (FD1-RC1): deployment evidence, 2026-09-24

## 1. NIL problem (production, 05:32 UTC, signal 4562515b)

- **GPT's INITIAL BUY** was judged on a snapshot taken 6.9 s after the trigger. The facts then were:
  - returns 5m +2.6%, 15m +6.2%, 60m +10.9%;
  - taker buy 5m 0.556;
  - spread 2.0 bps, slippage 1.5 bps;
  - CEC REJECT (−3.67), B06133 REJECT, V30 ADMIT.
- **At dispatch (+10.7 s)**, the E1 tape showed a return of −0.135% and a buy share of 0.485 over 779 trades. The expected cost was 14.9 bps.
- **What happened:**
  - E1 passed the candidate (`E1_NOT_FAST_WEAK`).
  - The INITIAL BUY was executed unchanged.
  - The position reached MFE +1.35% and MAE −2.65%.
  - The native stop fired: −8.25 USDT.
- **Afterwards,** the tracker's 60-minute counterfactual for NIL is −15.0%.

## 2. Design (no new strategy gate; GPT stays the decision maker)

The entry path is:

initial BUY → E1 (sensor) → change detector → FINAL RECHECK (only if triggered) → post-recheck safety → existing guards → order

**Change detector** (`_shared/gpt-final-decision/recheck.mjs`)
- It is pure and does no extra I/O.
- It compares two snapshots:
  - INITIAL: the FD1 facts plus the book mid. The mid is now stored in the hashed packet as `execution_ref`.
  - PRE-DISPATCH: E1's tape and the dispatch book (100 levels).
- Threshold bands are in `research/fd1-final-recheck-20260924/README.md`:
  - price vs initial ≤ −0.25% or ≥ +0.5%;
  - tape return ≤ −0.25%;
  - tape return < 0 AND buy share < 0.5 (FD1's own support directions, both reversed);
  - buy share ≤ 0.40, or down ≥ 0.15 from the initial 5m share;
  - spread +5 bps and ×2;
  - depth −50%;
  - imbalance −0.30;
  - slippage +5 bps;
  - an FD1 book band that got worse;
  - missing initial reference, quote or tape. This always triggers; missing data is never a pass.
  - Tape triggers need at least 20 trades.

**FINAL RECHECK input**
- INITIAL: the BUY decision, its support with values, its summary, and all initial facts.
- CURRENT: fresh FD1 facts. These include candles, flow, BTC, OI, funding, premium and the book.
- DELTA: price, tape return, buy share, share change, spread, ask/bid depth, imbalance, slippage and elapsed time.
- The trigger reasons and the risk flags.
- The V17, V30, B06133 and CEC0040 judgments, as evidence only.
- The question GPT is asked: "지금 이 순간에도 신규 LONG 진입 근거가 충분한가?" ("Is there still enough basis for a new LONG entry right now?")

**Server-side validation**
- SKIP needs a category that is breached now. PRICE_SLIPPED alone is invalid.
- "Already rose" is not a category.
- BUY needs at least 2 current up-facts, one of them a trend fact, and no HARD flag.

**Fail closed**
- Only a valid, unexpired FINAL BUY continues.
- SKIP, ABSTAIN, timeout (4 s), API error, invalid answer, expired answer (8 s from its snapshot), an exhausted budget, or `RC_LIMIT_REACHED` means no order.
- There is never a fallback to the INITIAL BUY.

**Maximum rechecks:** one per candidate. The journal key is signal + initial snapshot hash, and a second claim fails closed. There is no GPT loop.

**Post-recheck safety** (pure, before the unchanged dispatch block)
- The dispatch quote must be newer than the answer.
- Spread must be ≤ 25 bps.
- Mid drift since the answer's snapshot must be within −0.25% / +0.5%.
- After that, the existing checks run unchanged: quote age ≤ 1 s, depth, IOC, margin, slots, duplicates, BOO, lease/fencing and circuit.

**Recording**
- The order intent carries `entry_final_recheck` and the position carries `metadata.finalRecheck`. Both include:
  - the initial decision and its timestamps;
  - the pre-dispatch snapshot;
  - trigger reasons and deltas;
  - the final decision and its time;
  - `decision_to_order_ms`.
- `fd1_final_recheck_log` gets one row per candidate that reaches the detector, whether it traded or not.
- The `fd1-final-recheck-track-5m` job adds:
  - 5/15/30/60-minute counterfactual returns, MFE/MAE and stop-proxy PnL;
  - for traded rows, entry, exit, reason, net PnL and position MFE/MAE.
- The `fd1_final_recheck_evaluation` view reports, per arm: avoided loss, missed upside, latency and cost.

**Unchanged:**
- 200 USDT × 3, 10 slots;
- native stop, R5, P142, X1, protection;
- lease/fencing, reconciliation, dedupe, circuit;
- E1 (a frozen file);
- CEC as evidence, GPT as the final decision maker.

## 3. Tests

- **Local:** 309/309. This includes 19 new recheck tests: the brief's scenarios 1–14, detector bands, the contract, and hook-exact regression.
- **Release workflow:** the regression step (fail 0 required), deno check and bundle parity all passed.
- **`test:entry`:** the same 27 pre-existing failures as main b0af0dc, and no new ones (see the comment on PR #179).

## 4. Replay A/B (order-free, 80 FD1 replay BUYs, 2026-09-22 06:40 to 09-24 00:20)

- **Inputs:**
  - initial facts and answer from `fd1_replay_jobs`;
  - pre-dispatch tape from Binance aggTrades over [+1 s, +11 s);
  - real GPT FINAL RECHECK calls in REPLAY mode, with no historical book.
- **Outcome model:** 600 USDT; native stop −2.5% within 60 minutes, otherwise the 60-minute close; fee 0.6 USDT.

| arm | trades | net USDT | USDT/trade | win | 15m | 60m | MAE |
|---|---|---|---|---|---|---|---|
| A: every INITIAL BUY (current) | 80 | −423.1 | −5.29 | 28% | −0.15% | −1.32% | −4.99% |
| B: recheck, traded (no recheck + FINAL BUY) | 45 | −236.2 | −5.25 | 29% | +0.28% | −1.21% | −4.65% |
| B: not traded (FINAL SKIP 32 + timeout 3) | 35 | −186.9 | −5.34 | 26% | −0.70% | −1.46% | −5.42% |

- **Recheck rate:** 37/80 (46%).
- **FINAL answers:** SKIP 32, BUY 2 (both PRICE_CHASE only), timeout 3 (replay used an 8 s timeout).
- **BUY retention after a recheck:** 2/37 (5%).
- **Avoided loss vs missed upside:** 399.2 vs 212.3 USDT.
- **Honest reading:**
  - Rechecked candidates do have worse short-horizon paths (15m −0.70% vs +0.28%).
  - Expectancy per trade is unchanged (−5.25 vs −5.34).
  - The total improves (−423 → −236) because fewer trades were taken in a negative-expectancy sample. It is not evidence of better selection.
  - With 80 samples, no superiority is claimed.
- **The FINAL RECHECK is conservative.** Once a change is flagged, GPT almost always SKIPs. The evaluation view is the monitor for this.
- **API:** latency p50 1.96 s, p95 3.2 s, max 5.6 s (plus 3 of 37 over 8 s); cost $0.0042 per call.

## 5. Deployment (release workflow from main)

- **Pre-deploy (06:39Z):**
  - Binance: 0 positions, 0 ordinary orders, 0 conditional orders.
  - DB: 0 open positions, 0 unresolved orders.
  - Circuit closed, protection FLAT, GPT ENFORCE ($3 / 300 per day).
  - Sizing 200 × 3, 10 slots.
- **Migration 20260924064044:** adds `fd1_final_recheck_log`, the tracker and cron, the evaluation view, and the replay RECHECK task. It is observational only.
- **PR #179, main 3d4b2aa:**
  - Run 35966104595 deployed `v10-lane-executor` v80 → v81. Bundle parity verified over 50 files.
  - Run 35966110923 deployed `gpt-final-decision-replay` v6 → v7.
- **PR #180, main 46bf412** (probe fixture judged at its own dispatch instant): run 35966438418 deployed `v10-lane-executor` v81 → v82.

## 6. Post-deploy (v82, PATCH FD1-GPT-FINAL-RECHECK-1)

- **ops-readiness:**
  - Binance 0/0/0, DB 0/0.
  - Circuit closed, protection FLAT, GPT ENFORCE, OpenAI key present.
  - Sizing 200 × 3 × 10.
- **Scheduled cycles:** HTTP 200 on the new PATCH.
- **`fd1-recheck-probe` LIVE, SOLUSDT** (order-free):
  - Fixture initial BUY followed by a seller-dominated tape.
  - Detector: PRICE_ADVERSE, TAPE_FLOW_REVERSED, TAPE_RETURN_ADVERSE, BUY_SHARE_LOW, BUY_SHARE_DROP.
  - Real GPT FINAL answered SKIP (valid) in 2.8 s, $0.0043. No order; orderCalls 0.
- **`fd1-recheck-probe` NIL** (stored production records; current facts replayed at NIL's dispatch instant):
  - Detector: TAPE_FLOW_REVERSED only, at an elapsed time of 10.7 s.
  - Real GPT FINAL answered SKIP (TAPE_SELLING): "상승 추세는 아직 살아 있지만 직전 체결 흐름이 매도 쪽으로 꺾여 신규 롱 근거가 약해졌다" ("The uptrend is still alive, but the latest trade flow has turned to sellers, so the basis for a new long has weakened"). 1.96 s. No order.
- **Tracker self-test** on NIL (row deleted afterwards):
  - forward 5m −4.6%, 60m −15.0%, stop proxy hit at minute 2;
  - real position −8.25 USDT, MFE +1.35%, MAE −2.65%.
- **Not proven live:** a real candidate going FINAL BUY → post-recheck safety → order. No eligible live candidate appeared. That path is covered by tests 2+3, 7, 8 and 11.
