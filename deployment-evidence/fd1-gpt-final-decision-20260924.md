# FD1 — GPT as the final trading decision maker (entry and exit), 2026-09-24

Status: IN PROGRESS (design, implementation and replay validation; production decision pending).

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

## 2. Validation status: BLOCKED (OpenAI credit exhausted, 2026-09-24 ~03:15Z)

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
