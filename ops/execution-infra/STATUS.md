# Execution infrastructure — production cutover incomplete

Latest executor v185 was deployed at 2026-10-02 07:03:33.832 UTC / 16:03:33.832 KST from main commit `9e8758a583e2bd91381a99ebc72243f8a4fb3437`. All 93 retrieved source files matched. Bundle hash: `8605919e53c5a0fbfd758222445e8ca89a9a020ace23edb52e06c410ea6c3d46`.

Applied protections: explicit PRE_SEND native submission evidence, proof-backed reconciliation of seven closed absent native stops, ambiguous dispatch no-resubmit guard and same-decision durable reconciliation. Formal migration versions are `20261002061335` and `20261002070129`.

At 07:04:03.179307 UTC / 16:04:03.179307 KST: live=true, circuit=false, last_error=null; open positions, ordinary unresolved orders, UNKNOWN dispatches, closed-native backlog were each zero. This snapshot is not a successful BUY funnel. The earlier v184 same-cohort sample still had five unclaimed expired BUYs and one circuit dropout among eleven approvals.

Full writer/scheduler cutover is still required. Periodic scan/AI/observation work still shares the account execution lease. Fly external registry/recovery binding and cron cutover, P10 entry retirement and public self-call migration are not live. Do not deploy old main or activate a dummy recovery adapter. Preserve strategies, guards and native protection.

Production cron/settings/schema/functions were backed up in encrypted audit run 36966323876 (04:50:56.002 UTC / 13:50:56.002 KST). v183/v184 source/hash rollback points are preserved. Keep no-resubmit RPCs when rolling executor source back to v184. Do not restore old ledger/PnL or replay expired BUYs.

Repeated postmaster starts at 05:36:11.400746, 06:06:03.502642 and 06:35:57.669629 UTC / 14:36:11.400746, 15:06:03.502642 and 15:35:57.669629 KST remain unexplained. No agent restart or paid compute change was performed. Independent read-only metrics/health sampling is running. See REPORT-20261002.md for current evidence and outstanding completion criteria.
