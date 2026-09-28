# UNKNOWN provider receipt preservation — 2026-09-28

INX FINAL RECHECK `bed1dcafcd10a21d174983435a63db04d019f8e3cf646555f44f20eeb6509ba3` completed with valid WAIT at08:01:39 UTC. Its GPT FIRST leg timed out after HTTP200 with header request ID `req_302baf9fdfb14e15837cbeab096143a7` and no usage. The provider ledger correctly retained UNKNOWN and $0.0577395, but dropped that known receipt and elapsed time. Both paidTransport's UNKNOWN call and ai_call_transition's UNKNOWN branch omitted the metadata.

The transport now passes observed request ID and elapsed time when usage is unavailable, and elapsed time alone for failures before headers. The SQL transition records those fields on UNKNOWN. An owner-checked repeated UNKNOWN can fill missing metadata without replacing existing values, usage, state, reservation or charge. Later settlement preserves an existing receipt when no new request ID is supplied. Owner locks, dispatch deadline checks, cancellation rules, exact-once settlement and token/cache rates remain authoritative. No API retry, extra call, market packet, AI decision, deadline, budget, slot, order or protective setting changes.

Validation:
- Original journal receipt and UNKNOWN reservation replayed with an injected incomplete HTTP200 body. Original implementation reproduces missing request ID/latency; patched transport keeps the receipt with one provider call and no cancellation or usage invention.
- Isolated PostgreSQL replays the exact production function before applying the migration, then verifies owner rejection, missing-metadata enrichment, conflicting replay non-overwrite, unchanged charged reservation, no UNKNOWN cancellation, later cached-token settlement and original terminal-parent dispatch fence.
-31 focused checks pass; full Node mjs suite1692/1692; Deno1055/1055 plus13 steps; executor/generator type checks pass. An initial unfiltered Node invocation incorrectly selected Deno TypeScript tests; the mjs-only full rerun is the Node result above.
- Downloaded executorv145 has81files. Local main plus this patch differs only in functions/_shared/leader20/paid-transport.mjs; other80files match after line-ending normalization. No schema table/column or pricing changes.

This fixes receipt observability, not provider response latency, recurrent capture gaps, semantic reasoning errors or the unsustainable all-ten GPT monthly scenario. The original INX FINAL WAIT remains a valid non-entry. First fill/stop acknowledgement reconciliation is still pending.

Deployment and exact production reconciliation are recorded in the heartbeat release artifact after merge.
