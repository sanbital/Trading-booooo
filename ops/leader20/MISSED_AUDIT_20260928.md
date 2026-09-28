# Missed-opportunity audit lookup repair

Production integrity check at 2026-09-28 03:20 UTC found repeated 120-second SQL timeouts in audit cron jobs 93 and 95. The recent lane failed 11/12 runs in the preceding hour; catchup failed 5/12. Some successful catchup calls return early when the shared advisory lock is busy, so their success does not establish journal freshness. Last journal synchronization was 2026-09-26 21:27 UTC and three signals since the first-fill cutoff were missing.

The unchanged production SELECT plan performs a sequential review scan and order scan for each of up to 3,000 signals (estimated total cost 545,486.12). Add only two partial B-tree indexes: production reviews by signal/creation/completion, and open-long orders by signal/creation. Both heap relations are below 1 MB. A 500 ms lock timeout and 3 s statement timeout bound deployment lock exposure. No function, classification, budget, schedule, trading control or privilege change is included.

The existing entry lifecycle fixture now installs these indexes before checking classifications, entry-only evidence, chase anchors and order attempt evidence. All eight lifecycle, missed-opportunity and reconciliation SQL tests passed. Deployment and runtime timing must be verified separately; this initial report does not claim that the production fault is resolved.

## Applied and verified

Migration `20260928032432_missed_opportunity_lookup_indexes` applied successfully. Both indexes are valid/ready and total 112 KiB. No function body changed: audit sync/track/lane and strict capture RPC hashes match before/after. Existing five-signal ENTRY/RECHECK/attempt/classification query results match exactly; eight SQL regression tests pass with the applied migration filename. Security advisors stayed at the same seven existing notices with no new finding.

The same 3,000-signal query now uses both indexes; planner cost fell 545,486.12 → 32,523.62 (94.04%). This is an estimate, not elapsed time. The next natural recent-lane cron at 03:25 UTC actually succeeded in **2.805654 seconds**, after repeated 120-second timeouts. Last journal synchronization advanced to 03:25, and the three previously missing signals were present at 03:25:51. A newly created signal can remain pending until the next unchanged five-minute synchronization; this is distinct from the prior 30-hour stall.

The broader integrity check also found one capture-ingest HTTP 503 (`EDGE_FUNCTION_ERROR`) at 03:08:02 UTC. Current capture requests have recovered and all ten strict 24-bucket contexts were AVAILABLE at 03:26:16; the fix does not claim to diagnose that transient error or prevent every future Edge failure. No paid audit review or manual trade was made. New ten-minute paid batch activation remains blocked by the separately documented semantic/recall gates.
