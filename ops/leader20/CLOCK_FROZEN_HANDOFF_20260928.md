# Frozen capture handoff

Baseline: main `9e7cce617513eadef1b64240d8bacfa974576104`, production executor
153 (`d8701e789398016e1a34c21c99dbeaebc1f3e6f7a11c5dcad8bae11223bdbe4e`) and
generator 45 (`386ce6f5762ff139f6463a3d78031cf17d2046279a7b5a8146950111bce804ab`).
All 85 executor and 16 generator files matched that main baseline after line-ending
normalization. No rollback, risk change, budget change or validation order.

The 22:40 KST incident reached SQL claim at T+31.442s, past the old 30s gate,
despite a valid capture and two available entries. Main had already expanded that
gate to 60s. That interim change did not provide bounded capture readiness retries,
latency-derived reserve, per-slot telemetry or explicit late-FINAL errors.

The contract remains T-120s through T, with 24 ordered 5s data buckets plus a
seed. The entry window is [T,T+120s). A batch's own expires_at now uses the same
absolute deadline instead of a fresh 90-second lifetime after insertion.

Production latency measured 2026-09-28:

| Population | n | p95 ms |
| --- | ---: | ---: |
| DeepSeek batches, preceding 24h | 77 | 9,680.2 |
| GPT production calls, preceding 24h | 540 | 9,533.3 |
| All earlier clock releases, batch to last GPT | 5 | 87,570.3 |
| Current v153, 22:50 and 23:00 slots, batch to last GPT | 2 | 66,834.7 |

The old releases include additional rechecks and are not the current execution
contract. The current end-to-end sample is small; 80,000ms reserves its observed
p95 plus 13,165ms for execution safety and tail latency. Admission is computed as
`decision_deadline - decision_reserve_ms`, currently T+40s. This permits a first
READY at T+35s, rejects T+100s, and does not pretend a 30s reserve covers the real
handoff. Both Edge and SQL use the control value (allowed range 30,000–119,999ms).

Missing/incomplete capture assembly retries at 250/500/1000ms without holding DB
locks or paying a provider. Every attempt retains the original slot, and stops
before the reserve boundary. Intrinsically invalid/noncausal symbols remain
individually blocked; they are never repaired with post-T buckets. The original
clock reader, funded capture shutdown and continuous held-position capture stay
unchanged. Closed-candle momentum also remains bounded by T across retries.

SQL's existing claim lock plus a unique clock periodic_slot index gives exactly
one batch per slot. Snapshot hashes and entry_window are copied from each frozen
batch symbol into the advisory passed to GPT, including unavailable advice.
The trajectory hash uses the existing canonical validator representation used by
GPT; DeepSeek's matrix keeps original precision. Invalid JSON and timeouts remain
unavailable advisory evidence, never a GPT veto. A late GPT completion is invalid
ABSTAIN / CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION, never market SKIP or WAIT.

The generator includes batch_outcome with slot, deadline, reserve boundary, reason,
ready/blocked counts, capacity and retry count. Its older batch response remains
compatible. Nonessential observation housekeeping no longer precedes the clock
batch; the existing finish function still performs that housekeeping before events.

Service-only leader20_clock_slots stores capture, batch, provider and order times,
generated latency columns, counts and slot_status. Journal triggers preserve
observations if an Edge response is lost. A telemetry-only expiry job finalizes
unfinished slots; it makes no capture, AI or order requests. Provider journals
retain individual GPT latency; slot GPT latency spans first start to last completion.

Validation: full Node suite 1,608 passed before the final hash-binding additions;
final focused suite 59 passed; Deno 1,055 passed (13 steps), and both entrypoints
typechecked. The focused suite includes actual SQL reserve/expiry/idempotency,
22:40 delayed readiness, provider failure, late completion, telemetry, capacity
shutdown, holdings continuity, and the original NMR BUY through the real IOC
dispatcher with a mock exchange and zero post-BUY AI calls.

Deployment versions, artifact hashes and the next natural production slot are
recorded separately after deployment. No natural BUY is forced for verification.
