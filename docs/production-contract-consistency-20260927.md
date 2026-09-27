# Production contract consistency correction

Baseline: main `ec2ad11070e724bb3ab2c673979184718d3769ec`, executor v116,
artifact `3132fe8f1eaf1ae787bab5a7a4c796680d38300ba3691a4fc6b04011817a5e03`.

## Runtime corrections

- HOLD snapshot refresh recomputes `protection.approved_crossed` and `candidate_crossed`
  from the same refreshed executable bid used by `soft_trigger.crossed`. Approved and candidate
  prices remain fixed. This covers initial preparation and FINAL refresh, declines and recoveries.
- DeepSeek live transport has only `decision_preference`. The redundant `recommended_action`
  is generated on the server for canonical consumers. Legacy canonical responses with conflicting
  decisions are invalid (`DEEPSEEK_DECISION_MISMATCH`), never silently repaired. Task, identity,
  snapshot and evidence checks remain required. Evidence IDs and DEGRADED_VALID behavior remain.
- Prompts describe the unchanged dynamic single-model BUY rule (advisor invalid/unavailable:
  confidence >=0.8 and ACCELERATING/STABLE). The threshold is imported from DYNAMIC_POLICY.
  Honest confidence is required; models must not inflate it to pass. No additional threshold exists.
- Authority wording now describes the already implemented emergency HOLD/EXIT exception.
  Valid GPT FINAL takes precedence; DeepSeek never authorizes ENTRY or protection raises.
  The emergency consumer and its identity/snapshot/freshness checks are unchanged.
- Reconnecting partial-close tests exposed a separate quantity mismatch: native stop synchronization
  used the pre-exit portfolio quantity and cleanup-only symbol rules even when a terminal order had
  filled only partially. It now uses the durable residual that `applyExitReceipt` reconciled against
  the post-fill account observation and the actual symbol tick/step. The existing acknowledge-before-
  cancel mechanism remains. Flat positions still retire stops; partial exits keep protection.

No market strategy, sizing, leverage, slots, trigger TTL, trajectory freshness, FINAL RECHECK,
single-model threshold, R5 rule, stop level, reduceOnly behavior or emergency authority was changed.
No model calls, retries, or model time budgets were added. A partial close now uses the existing
symbol-rules read for residual protection instead of the flat-position cleanup shortcut.

## Verification

- Full Node suite: 1,406 passed, 0 failed. Full Deno suite: 1,055 passed plus 13 steps,
  0 failed. Deno type checks passed for executor, self-evolution worker and capture ingest.
- Actual NEAR fixture continues to retain FINAL SKIP with no order.
- New tests cover crossing/recovery/equality/missing levels, frozen input immutability, and actual
  HOLD FIRST/FINAL orchestration with changing bid and fixed protection levels.
- All three advisory tasks test the single live decision field and canonical alias; conflicting
  legacy decisions are rejected consistently by normal and emergency validation.
- Existing confidence boundary tests retain 0.79 rejection / 0.8 acceptance and propulsion checks.
- QV3 tests now distinguish a strategy candidate from an approved FINAL exit, preserving actual
  close/settlement, timeout reconciliation, residual protection, and duplicate-order assertions.
  Pullback entries explicitly assert absence of legacy QV3 authority. Partial receipt fixtures
  provide the same-order lookup required by current execution reconciliation.
- Executor behavior comparison is pinned to v116, the production contract inherited by this change,
  instead of pre-GPT v38. Historical QV3 rule/decision parity remains separately asserted.
- QV3 research tests are included in the production AI CI job. Byte parity normalizes Windows
  line endings only; no assertion is skipped or weakened to accept logic changes.

On the pinned production timeout snapshot, serialized request bytes are DeepSeek 39,466 -> 39,453
and FINAL 115,240 -> 115,237. This measures request size, not live provider latency.
Deployment smoke must use the existing read-only ops-readiness mode; no forced order or model probe.
