# FD1 — GPT as the final trading decision maker (entry and exit), 2026-09-24

Status: validated on replay; deployed as executor PATCH FD1-GPT-FINAL-DECISION-1 (see §4).

## 1. Design

- **Pipeline:** V17 candidate generation (top-10 KST leaders, 5m confirmation, pullback → re-acceleration trigger) → minimal deterministic conditions → GPT FD1 ENTRY decision (BUY / SKIP / ABSTAIN) → existing order guards (drift 1%, sizing 200 USDT × 3, max 10 slots, lease/fencing, dedupe, native stop).
- **Open positions:** the deterministic exit engine runs first on every tick. The native stop, R5 risk cut, P142 locks, trailing stops and the post-fill guard are never offered to GPT and never wait for it.
  - GPT decides only two things:
    - **Time-based close candidates** (V17_MOMENTUM_STALE / V17_MAX_HOLD). A valid HOLD defers the close for 15 minutes; anything else closes deterministically.
    - **EXIT on a meaningful state change** (momentum deterioration ≥1.5% from peak, or a ±2% move since the last review), only when a thesis-broken category is breached in the snapshot.
- **Server-side contract** (`_shared/gpt-final-decision/contract.mjs`):
  - Reasons must be published categories that are breached in the snapshot, and support must be facts that point up now. Both are enforced per snapshot in the output schema and re-validated on the server.
  - "Already rose", "volatile", "near a high" and "held long" are not categories.
  - HARD bands block BUY and HOLD.
  - Any failure results in ABSTAIN: no entry for a candidate, and the deterministic engine for a position.
- **Facts** (`facts.mjs`) are raw, point-in-time facts, kept separate from model judgments (V17, B06133, V30, CEC0040), which are reference only.

## 2. Interruption (resolved): OpenAI credit exhausted 2026-09-24 ~03:15Z, topped up by the operator ~03:40Z

- **OpenAI error:** HTTP 429 `insufficient_quota / credit_balance_exhausted`. This is the account's credit, not a rate limit. The production GPT entry review uses the same key, so every candidate fails closed (ABSTAIN, no order) until the credit is topped up. Exits are deterministic and unaffected.
- **Replay progress:**
  - Entry: 250 of 1,114 done.
  - Hold: 0 of 1,841 done.
  - The rest are queued as NEW in `fd1_replay_jobs`. The replay crons `fd1-replay-30s` and `fd1-replay-30s-b` are paused.
  - Spend so far is about $0.76. The replay budget is separate from the production ledger.
- **Preliminary (earliest 250 triggers, 09-08..09-11; deterministic exit, real costs):**

  | GPT decision | Trades | Total (USDT) | Avg (USDT/trade) |
  |---|---|---|---|
  | BUY | 180 | −80.6 | −0.45 |
  | SKIP | 38 | +16.6 | +0.44 |
  | ABSTAIN | 32 | +197.3 | +6.17 |

  Taking every trigger in the same sample averaged +0.43 per trade. So on this sample, GPT's BUY did not beat taking every trigger. The sample is not conclusive.
- **Exit leverage (all 1,119 triggers, deterministic engine):**
  - Exit reasons: R5_RISK_CUT 487, retestAnchor_TRAIL 215, retestAnchor_LOCK 116, NATIVE_HARD_STOP 289, V17_MOMENTUM_STALE 12.
  - Time-based exits are 1% of exits. Holding every time candidate (always-HOLD) changes the 16-day result by only +67 USDT (−1651 → −1584).
  - GPT's exit authority therefore has little room to add value. Entry selection is what matters.
- **Production:** unchanged. The executor runs main (v75: V30 front, CEC advisory, GPT V6S final entry). FD1 code is on the branch, tested (233/233) and NOT deployed.

## 3. Validation (complete, KST 2026-09-24 13:15)

GPT replay: 1,114 entry decisions (BUY 756 / SKIP 178 / ABSTAIN 164 / invalid 16) and 1,841 hold decisions (HOLD 1,483 / EXIT 108 / ABSTAIN 97 / invalid 153). Replay API cost $8.53, latency p50 1.41 s / p95 2.20 s. Invalid answers fall back: ABSTAIN on entry, deterministic engine on hold (114 of the hold invalids were HOLD during a HARD premium flag).

Same 1,119 V17 pullback triggers, same entry price rule, exits, costs (real 5+5 bp fee, 5/10 bp slip; 44 bp stress in brackets). Cap 4 slots, net USDT / trades / PF / MDD [44bp]:

| arm | 24h | 48h | 7d | 16d | MDD 16d |
|---|---|---|---|---|---|
| A previous prod (B06133+CEC, det exit) | −13 / 4 | −42 / 9 | −124 / 29 | −119 / 42 / 0.62 [−164] | −129 |
| B0 V30 + CEC hard, det exit | −112 / 9 | −53 / 23 | +18 / 97 | +80 / 176 / 1.06 [−171] | −188 |
| B1 V30, CEC advisory (= v75 production), det exit | −130 / 23 | −207 / 54 | −37 / 228 | +198 / 410 / 1.07 [−294] | −369 |
| X all triggers, det exit | −295 / 42 | −467 / 103 | −843 / 446 | −1053 / 777 / 0.82 [−1885] | −1147 |
| C GPT on all triggers + GPT hold | −238 / 30 | −270 / 76 | −289 / 327 | −438 / 553 / 0.89 [−1043] | −462 |
| C1 same, det exit | −241 / 30 | −276 / 76 | −273 / 326 | −435 / 553 [−1031] | −507 |
| C2 GPT + V30 gate | −87 / 15 | −155 / 42 | −80 / 174 | −47 / 299 [−417] | −258 |
| C3 GPT + CEC gate | −113 / 13 | −204 / 33 | −97 / 144 | −295 / 239 [−603] | −387 |
| **C4 GPT + V30 + CEC gates + GPT hold (DEPLOYED)** | −63 / 6 | −85 / 18 | +50 / 71 | **+343 / 129 / 1.41 [+208]** | **−117** |

Findings:
- GPT improves on "take every trigger" (C vs X) but GPT alone with the relaxed front is clearly worse than production: C is not deployable.
- Hard gates kept on data: V30 (C3→C4: 16d −295 → +343) and CEC0040 (C2→C4: −47 → +343, MDD −258 → −117). This reverts main's CEC-advisory change (14c257f/d7c50a4) on evidence.
- C4 vs current production B1: better in 24h, 48h, 7d and 16d, MDD −117 vs −369, 44 bp stress +208 vs −294. C4 vs B0 (same gates without FD1): better in 24h/7d/16d, 48h −85 vs −53. Short windows are small samples (6–18 trades).
- GPT exit authority is nearly neutral (C vs C1 within ±15 USDT): time exits are ~1% of exits; stops dominate.
- Not replay-validated (no historical books): book-based categories (spread, thin liquidity, sell wall, fill slippage). They are live only and observed in production.

Production defect found and fixed during pre-deploy reconciliation: `v11_cec0040_decisions/targets` CHECK constraints rejected branch V30_SCORE, so every V30-only candidate failed CEC0040 (fail-closed) since the V30 cutover. Migration 20260924041645.

## 4. Production deployment (KST 2026-09-24 13:19–13:22)

- **Pre-deploy reconciliation (KST 13:09):**
  - Binance: 0 positions, 0 normal orders, 0 conditional orders.
  - DB: 0 open positions, 0 unresolved orders.
  - Circuit closed, protection FLAT, GPT control ENFORCE ($3/300 per day).
  - Sizing 200 USDT × 3, max 10 slots.
  - Found `entry_block_reason = CEC0040 branch check violation`, a pre-existing V30 defect. Fixed by migration 20260924041645.
- **Main changes merged first:**
  - CEC advisory (14c257f/d7c50a4), reverted on data (§3).
  - Continuation trigger (8895c28), kept as the operator deployed it. The release workflow permits exactly that file content. **Continuation triggers are not covered by the FD1 replay**, which used pullback triggers only. They still pass the V30, CEC and GPT gates.
- **Executor deploys:**
  - v77 at commit 8e8058d.
  - v78 at commit ffe01b4, which narrows SELL_WALL to net imbalance after the live probe showed max-ask-level ≥10× is normal on liquid books.
  - Both went through the release workflow: frozen-policy proof, 233/233 tests, deno check, version pin, bundle parity.
- **Post-deploy (order-free `fd1-probe`):**
  - v77 on SOLUSDT: entry SKIP, valid categories. HOLD was invalid (HOLD listing reasons) and fell back to the deterministic time exit, as designed.
  - v78 on DOGEUSDT: entry SKIP with MOMENTUM_FADED and SIGNAL_INVALIDATED, valid, 2.2 s, $0.0036. HOLD valid, 1.6 s, so the time exit was deferred 15 minutes.
  - Candles, microstructure and derivatives were complete. orderCalls = 0.
- **Scheduled cycles** on FD1-GPT-FINAL-DECISION-1 returned HTTP 200 (KST 13:20, 13:21, 13:22).
- **Unchanged:** native STOP_MARKET sync, R5, P142, 1% drift guard, lease/fencing, dedupe, circuit, 200 × 3, 10 slots.

## 5. Operator directive (KST 2026-09-24, after deployment)

- **Directive:** The operator will remove the hard rejects (V30 and CEC0040 hard gates, etc.). The final trading decision is made through the GPT API. The removal will be done by the operator's separate GPT agent, not in this workstream. This workstream does not remove them.
- **For whoever removes them, the checks that currently enforce the gates:**
  - `development/gpt-final-review/tests/v30-live.test.mjs`: "live baseline keeps every CEC0040 check".
  - `baselineAllowedLive` in `_shared/gpt-final-review/contract.mjs`.
  - `applyCec0040Selection` / `openBull` in the executor, and `applyB06133Selection` (V30_FRONT_REJECT).
  - The release workflow's exact-content check on `leader-pullback-reaccel.mjs` (8895c28) and its PATCH grep.
  - `development/gpt-final-review/executor-hooks-fd1.mjs` (hook list regenerated from the diff against a19f76e).
- **Reference data:** In the replay (§3), GPT on all triggers without these gates (arm C) was clearly worse than the gated arm C4 (16d −438 vs +343). Watch performance after the removal.

## 6. CEC0040 as GPT evidence; GPT is the sole final entry decision (KST 2026-09-24 14:20–14:26)

- **Scope:**
  - Took over PR #175 (continuation execution window) and the prepared CEC-removal intent.
  - The CEC-removal patch was not on GitHub. It was implemented here as the re-application of 14c257f/d7c50a4 plus the fixes below.
- **Pre-existing defects found:**
  1. **V30 stamp integrity.** `baselineAllowedV30` compared stamps with JSON.stringify. Postgres jsonb reorders keys, so every V30 candidate read back from the DB failed the GPT baseline and the openBull V30 re-check. GPT was never reached for a V30 candidate since the V30 cutover. Fixed in PR #177.
  2. **GPT OFF/SHADOW passed candidates through** to order admission without a GPT BUY. They now admit no new entry.
  3. **CEC target tracking only covered ADMIT/PROBE** (`modelAllowed`), a selection bias. It now covers every ready decision; migration 20260924052022.
  4. **Continuation triggers were rejected** by the execution window (`pullbackObserved` required). Fixed by PR #175.
- **Traceability:**
  - The GPT decision is stored with the order intent (`entry_gpt_decision`) and the position (`gptEntryDecision`), next to the CEC stamp (`entry_controller` / `cec0040`).
  - CEC action → GPT decision → entry → exit → net PnL is joinable per position.
- **Tests:** 290/290. The release verifier passed: exact-content allowances for entry-evidence.mjs (ebed212) and leader-pullback-reaccel.mjs (8895c28).
- **Deploys** (release workflow from main):
  - Run 35959574067: main 3d07bad → v79.
  - Run 35959823684: main bc6ae9c → v80.
- **Post-deploy:**
  - ops-readiness: PATCH FD1-GPT-FINAL-ENTRY-CEC-EVIDENCE-2, GPT ENFORCE, Binance 0/0/0, DB 0/0, circuit closed, protection FLAT, 200 × 3 × 10.
  - fd1-probe CYSUSDT: entry SKIP valid (2.6 s), HOLD valid. orderCalls 0.
  - Scheduled cycles: HTTP 200.
- **Order-free proof on the real stored CYSUSDT row** (CEC REJECT, prediction −3.67, continuation), `research/fd1-gpt-final-decision-20260924/cec-reject-reachability-proof.mjs`:
  - Execution window valid (CONTINUATION_TRIGGER).
  - GPT baseline passes and GPT sees CEC REJECT.
  - GPT BUY leads to an order candidate. SKIP or ABSTAIN leads to no order.
- **Reminder (§3):** the replay favoured V30 + CEC hard gate (16d +343 vs −47 without it). This change implements the operator's architecture decision; outcomes are recorded for comparison.
