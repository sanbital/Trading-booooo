# Provider restart evidence and fallback

No production restart or paid compute change was performed by this task. The user previously reported a manual restart; attribution for later restarts is unconfirmed.

Postmaster starts observed on 2026-10-02 UTC / KST:
09:03:04.641372 / 18:03:04.641372;
09:47:36.990946 / 18:47:36.990946;
10:12:10.597090 / 19:12:10.597090;
10:31:45.925847 / 19:31:45.925847.
Postgres interrupted recovery logs were returned for 09:47:37.000, 10:12:10.604, 10:31:45.933 UTC / 18:47:37.000, 19:12:10.604, 19:31:45.933 KST. The query window 08:30–11:05 UTC / 17:30–20:05 KST did not establish clean shutdown, OOM or maintenance/restart actor. An empty result is not absence proof.

Independent sample workflow 36985304386 / artifact 11221812491 contains 480 samples from 08:39:52.779–10:39:37.700 UTC / 17:39:52.779–19:39:37.700 KST. 442 metric HTTP results (441 valid memory observations), 38 metric transport gaps and 39 health transport gaps are preserved. CPU excluding iowait p99=60.54%, max=61.28%; minimum available memory=353,513,472 bytes; connection peak=23/90; observed oom_kill counter=0. Maximum iowait=47.29% does not establish causal pre-crash I/O saturation. Cached/asynchronous scrape intervals do not support a disk utilization percent. The pre/post-start windows are in deployment-evidence/platform-resource-restart-windows-0839-1039.json.

Earlier unbounded telemetry was a proven application CPU/load defect and was fixed at 08:16 UTC / 17:16 KST. Later unclean restarts continued without demonstrated CPU/memory/connection exhaustion. Therefore no compute upgrade is claimed to fix the restart cause. Provider Support needs kernel/container termination reason, database/control-plane restart actor and maintenance/upgrade/host event history for these exact windows. This draft has not been sent to a third party.

The immediate architecture removes Supabase pg_cron/pg_net from execution delivery, and uses a logged outbox and external clock. DB loss freezes entry while native venue stops remain. Leader/writer generations invalidate old holders on readiness, and recovery reconciles venue orders, positions, attribution and protection before entry. Actual recovery after 10:12/10:31 starts completed at 10:12:49.388573/10:32:24.396841 UTC (19:12:49.388573/19:32:24.396841 KST), in 38.79/38.47 seconds. These were naturally observed restarts, not injected failures.

If provider restarts remain unexplained, the simpler next hosting boundary is a dedicated order worker plus an independently operated logged PostgreSQL execution ledger; Supabase becomes a UI/analytics mirror and public Edge wakes are optional. A second durable venue-independent state store must not become another authoritative writer. Migration requires backup/restore checks, single-writer fencing, exact client IDs and native order reconciliation before writer handover. Replacing Supabase alone cannot remove ambiguous venue timeouts. Replacing Fly alone cannot make DB-free trading safe. No new compute purchase or provider migration was performed without a concrete tested handover.
