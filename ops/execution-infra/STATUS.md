# Execution infrastructure work — blocked at production database readiness

This is a prerequisite source synchronization, not the requested execution-writer or scheduler rollout. No production DB, cron, Edge Function or Fly configuration was changed.

## Verified baseline

- Repository main at audit start: `c46cd0abee9f757b62b2b860724672388ad40cc2`.
- Production executor: v183, bundle SHA-256 `96d6506b248f3add6958cf9f7165367df06800859f2c7c4bb0e59ad3c3f8ccd4`.
- All 93 production dependency files were preserved before editing. Seven differed from main; the synchronized graph matches all 93 hashes in `deployment-evidence/production-v183-baseline.json`.
- Production already acquires the account lease before dispatch claim, bounds the drain, restricts it to the claimed signal, and stops on unresolved side effects. The old main had a claim-before-lease, 10-second waiting loop. Synchronization prevents redeployment of that obsolete behavior.
- Production still wraps the periodic run in a 150-second lease with a 90-second cycle budget. The source includes analysis/observation/maintenance within that leased operation. Actual lease occupancy percentiles remain unmeasured.
- Tokyo `trading-booooo-sanbital-gateway` machine `7817201a145d48`: scheduler enabled, scan 12s, monitor 2s, auto-stop off, minimum one machine. Binance `trading-booooo` machine `1850353b930168`: scheduler disabled. Both image labels point to `ce397d02336a56239d8c59950f74188ab359af29`.
- Gateway health at 2026-10-01 22:39:30 UTC / 2026-10-02 07:39:30 KST: DB circuit open; 25 failures, 4,988 suppressed cadence calls; last result DB_DEGRADED. The process remained alive.
- Exchange signed reads at 2026-10-01 22:41:48.201 UTC / 2026-10-02 07:41:48.201 KST: complete position snapshot, zero positions; complete open-order snapshot, zero ordinary and zero conditional orders. This does **not** prove the DB ledger has zero positions or unresolved orders.

## Blocking evidence

Supabase MCP SQL twice returned `Connection terminated due to connection timeout`. Independent GitHub runner audit at 2026-10-01 22:36:07.947 UTC / 2026-10-02 07:36:07.947 KST and at 22:41:31.277 UTC / 07:41:31.277 KST returned Management API HTTP 544. Pooler and direct SQL probes produced no successful result. Edge Function listing and Fly machine reads succeeded through the same runner. These observations do not establish the DB's internal cause.

Read-only runs: https://github.com/sanbital/Trading-booooo/actions/runs/36936021796 and https://github.com/sanbital/Trading-booooo/actions/runs/36936552194 . Raw evidence is encrypted with AES-256-GCM and an RSA-OAEP-SHA256 wrapped key before upload. The decryption key is outside the repository. No authentication headers or keys are logged.

Current cron commands, DB settings, schema/function drift, job duration/concurrency, unknown orders, DB positions and cohort rows could not be backed up or measured. Accordingly, there is no DB rollback point and no safe scheduler cutover authorization gate has passed. Do not deploy the next migration or switch schedulers until those reads succeed.

## Validation

- Focused executor/entry baseline: 164/164 pass. Final execution/attribution/protection/dispatch/review integration gate: 389/389 pass.
- Current production module graph is now bound into VM integration fixtures instead of leaving imported helpers undefined. Existing assertions that expected the removed in-process wake were updated to the deployed DB wake and account-before-claim behavior.
- Deno 2.5.6 check of the exact executor graph passed using the system CA store; TLS validation remained enabled.
- Broad main baseline: 1,795 tests, 1,766 pass, 29 fail. Broad synchronized graph before the final campaign-fixture correction: 1,799 tests, 1,772 pass, 27 fail. The only newly failing test was an extraction fixture anchored to an obsolete `const openSymbols` declaration; its anchor/bindings were corrected and separately rerun. Three pre-existing coordinator mock failures were corrected by supplying the real `pending`/`drainPending` interface. Final GitHub broad-suite result: 1,799 tests, 1,773 pass, 26 fail, all also present in the original main baseline. Remaining baseline failures are not a passing deployment gate.

## Remaining authorized work

1. Read and preserve current DB cron/config/function definitions, migration history, dispatch/order/fill/position state, and same-decision 24h/7d cohorts. Compare live schema with the repository before constructing expand/migrate/contract migrations.
2. Implement an account order writer with a durable command outbox, stable execution/client IDs, monotonic fencing enforced at the actual exchange boundary, atomic claim after writer ownership, heartbeat failure closing submission, and short side-effect critical sections. Keep analysis, capture, AI and universe work outside the writer. Reconciliation and protection/exit precede new entry. A state read cannot authorize submission after losing fencing.
3. Reconcile all SUBMITTING/UNKNOWN commands by the same client ID before any resend. A negative or incomplete exchange lookup is not proof of no order. Expired entry authority cannot be replayed. DB recovery freezes entries until open orders, positions, attribution, protection and capacity are reconciled.
4. Register every migrated job in one externally scheduled orchestrator; preserve live cadence, leader fencing, deterministic tick identity, per-job bulkheads and bounded backoff/jitter. Reuse the existing DB circuit. Deploy disabled; preserve cron; pause old jobs; prove no overlap; enable Fly. Roll back by disabling Fly before restoring cron.
5. Audit P10's actual management/reconciliation responsibilities and lease names before removing its entry work. Inventory market-v2-signal callers and live failure counts. Classify workflow/function owners and callers before disabling dead triggers. The legacy deploy-market-autotrader-v707 push trigger starts validation; its existing workflow_dispatch guard already blocks automatic deployment.
6. Test the requested failure matrix in isolation, then staged PR 1/2/3 rollout and actual 30m/2h/24h monitoring. Do not manufacture percentages or classify missing evidence as success.

## Rollback

This prerequisite does not change production execution. Revert its source-sync commit to restore the prior repository state, understanding that this restores the obsolete 10-second wait and must **not** be deployed over v183. Use the v183 manifest and preserved complete production bundle as the known source checkpoint. No DB/Fly/cron rollback is needed because none was changed; no subsequent infrastructure rollback is claimed to exist.

## Compute

No compute change was made. CPU, memory, I/O and connection peaks preceding restarts are unavailable. Nineteen observed interrupted/startup pairs do not prove OOM or undersizing. The support packet records the observed timeline and requests platform maintenance, process-exit, OOM and resource telemetry before making a cost-bearing recommendation.

The first new baseline CI run used a shallow checkout, which broke five historical-harness files that read the preserved historical Git revision. The checkout now fetches full history; this changes neither fixtures nor runtime policy.

## Historical automatic trigger retired

Source synchronization PR #276 was merged at 2026-10-01 22:55:36 UTC / 2026-10-02 07:55:36 KST, commit `6b83c4dc009306fe48bc0e90f80b410a61d9154f`. The corrected campaign test also matched the old `release-db-singleflight-collector-20260930.yml` push trigger. Run 36937935723 stopped at its exact-scope guard at 22:55:54 UTC / 07:55:54 KST; Edge deployment, image build/push and machine replacement were all skipped. The workflow was disabled through the Actions API. Its YAML now has workflow_dispatch only, a retired version marker and a false job guard; re-enabling the workflow cannot replay the release. Classification: migration/one-shot, historical collector release, original successful run 36730311882 at 2026-09-30 14:35:50 UTC / 23:35:50 KST. No other function/workflow was deleted or disabled.
