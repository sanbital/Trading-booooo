# Legacy cost lookup latency — 2026-09-28

Base: main `be6bc79a`, executor v144 / generator v40. This is a database-only change.

The 05:00 UTC batch completed with all ten IDs. PUMP and SOON ENTRY BUY reviews subsequently failed closed at FINAL with API_TIMEOUT. Their fresh 24-bucket captures remained within the unchanged 10-second age limit. The FINAL time allowance was about 4.44 seconds. GRT independently reported API_LEDGER_WRITE_FAILED and left one DISPATCHED reservation; the original RPC exception was not retained, so its precise cause is not established.

Read-only production EXPLAIN measured the daily plus monthly `ai_legacy_deepseek_used` queries at 1048.27 ms / 19,252 shared buffer hits. Capacity and protection-allocation queries together took 52.809 ms. Paid-call reservations serialize behind existing advisory locks and repeatedly decompress historical review JSON. HTTP logs around 05:01 showed reservation RPC durations of 66–2491 ms. This consumes part of provider timeout windows; it does not establish that all timeout failures share this cause.

Migration `20260928050558_leader20_legacy_cost_projection.sql` stores the existing legacy DeepSeek allocation expression as a generated numeric column and makes the existing function sum that column. Updates to source usage, settlement, model or record automatically recalculate it. It is a projection, not another charge. The migration compares every existing budget day's daily and monthly values against the original function before replacing it, and aborts on any difference. Lock acquisition is bounded to three seconds. No provider limits, rates, unknown reservations, advisory locks, freshness limits, reviewer decisions, slot contracts or protection logic change.

Validation before deployment:

- Original cost-bearing production rows: 775 across six budget days. All daily/monthly provider allocations matched exact decimal strings before/after offline migration replay. API calls and orders: zero.
- Regression cases cover unknown usage, settled dual-provider usage, capped allocations, absent/string usage, provider-ledger exclusion, late settlement, repeated settlement and source correction.
- Full Node suite: 1503 passed, zero failed. Deno/Edge code is unchanged.
- Existing review-table RLS stays enabled; no privilege or policy changes. The baseline security advisor has unrelated existing findings; this change does not claim the whole project is clean.

Evidence: `work/first-fill-checks/20260928T0507Z-legacy-cost-source.json`, `20260928T0508Z-legacy-cost-replay.json`, and `work/legacy-cost-full-node.tap`. These local evidence files are not copied into the repository.

The stored-column behavior was checked against [PostgreSQL documentation](https://www.postgresql.org/docs/17/ddl-generated-columns.html). Production application, cost parity and post-change latency must be checked separately. The FINAL timeout, GRT uncertain reservation, evidence-category errors and first-fill protection acknowledgement remain open until supported by fresh evidence.
