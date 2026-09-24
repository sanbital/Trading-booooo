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
