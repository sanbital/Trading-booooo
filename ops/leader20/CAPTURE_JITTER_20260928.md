# Collector timer jitter: 2026-09-28

At 02:31:04.447114 UTC, all ten candidate contexts returned `INVALID_OR_NONCAUSAL_BUCKET`. Their common invalid row ended at 02:29:05.040 after the previous timer tick at 02:29:00.638: only 4,402 ms of observations. Book completeness, trade sequence, depth coverage and flow causality were valid for all ten; `bucket_complete` was false. The strict validator correctly rejected the short row. QNT recovered after that row aged out of its 25-row source window.

The collector now defers emission per symbol until the existing 4,500 ms minimum is met. Flow and book deltas accumulate through the deferred tick; original interval start/end and event timestamps remain intact. One row per five-second grid cell is enforced. Actual late intervals above 5,500 ms, market stream loss, book resync and warmup remain invalid. No stored row is repaired or synthesized.

This branch starts at main `e104c14896d1fc5a5e2d1e8498e1e7f39e4e2066`, preserving the QNT fixes from PR #227. It changes only collector admission, tests, evidence and the existing image-only release request. It does not alter Edge Functions, SQL validators, AI routing, trading controls or budgets.

Validation: 20 collector core tests and the full Node suite (1,424 tests) passed; worker syntax check passed. The exact production 4,402 ms interval remains rejected in replay. A subsequent synthetic timer tick at 4,602 ms emits the same grid cell while preserving both buy and sell events. Clock reversal, overdue intervals and stream failures remain fail-closed.

Production rollout uses the existing collector-only workflow and its unchanged gates: at least ten minutes observed, at least thirty healthy samples, at least twelve strict QNT 24-bucket AVAILABLE samples, final QNT recovery, immutable trade validator hash and image-only configuration change. Rollback remains automatic on incomplete validation. Deployment status must be taken from the workflow artifact and monitoring state; this pre-deployment report is not evidence of a successful rollout.
