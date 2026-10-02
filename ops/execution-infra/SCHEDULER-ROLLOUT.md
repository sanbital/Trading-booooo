# External scheduler — disabled candidate

This PR registers no guessed live cron cadence and changes no active scheduler.
`EXTERNAL_SCHEDULER_ENABLED=false` and `ORDER_WRITER_REQUIRED=false` remain explicit
Fly defaults. If external mode is enabled, the legacy scan/monitor timers are not
started. All migrated jobs share the existing gateway DB circuit; retryable failures
receive capped exponential backoff/jitter, permanent 4xx disable their job, and each
job has its own timeout and bulkhead. An adapter that ignores abort cannot cause a
second local execution of that job. The process and its heartbeat stay alive.

## Durable admission

DB leader fencing, deterministic DB-clock tick identity, target/body binding and
endpoint acceptance prevent duplicated scheduler calls. Endpoint admission executes
after existing authentication, before lease/settings/market work. With no envelope
and the admission flag off, the expand code preserves existing endpoint behavior.
Catalog activation blocks matching legacy cron calls even if pg_net retained an old
wake. CURRENT_ONLY jobs cannot replay old ticks. Signal and entry jobs cannot be
configured for cursor catchup; only reconciliation, attribution, accounting,
protection sync and maintenance can use durable cursors.

## Recovery limitation

The orchestrator checks the writer's durable postmaster-bound recovery completion.
It does **not yet implement production fill/position/protection recovery adapters**.
When completion is absent, entry-dependent jobs remain frozen. Jobs explicitly
registered as recovery work may continue. This is a fail-closed prepared stage,
not evidence of automatic production recovery. Final rollout must wire and test the
existing reconciliation/attribution/protection/capacity adapters in the required order.

## Cutover

1. Read/back up live cron, schema, settings and orders; identify each real caller,
   cadence, timeout, execution overlap policy and token name. Deploy disabled images.
2. Verify health, image/commit, target authentication and registered jobs; record
   the current gateway commit and health time. Register jobs disabled first.
3. Enable audited catalog rows while the scheduler control remains disabled.
   `trading_scheduler_pause_cron` verifies job id/name/schedule/command MD5 against
   the live inventory and stores a logged backup before pausing those jobs.
4. Verify no old cron run or in-flight endpoint remains. Activate endpoint admission.
   `trading_scheduler_activate` refuses active or starting/running old cron jobs.
5. Activate Fly external mode; its legacy timers are excluded. Verify leader/ticks,
   recovery, protection, unknown orders and actual cohort observations.

Rollback: disable Fly external mode **before** restoring old cron; fence the external
leader and retain durable outbox truth. `trading_scheduler_rollback` verifies unchanged
backed-up commands and restores each previous active state. It refuses rollback until
the caller explicitly records that Fly was verified disabled. A cutover version cannot
be reused. Expanded tables remain until all logs/orders are reconciled; no history is
dropped. Stop legacy scan/monitor timers during an external rollback transition before
restoring their intended mode, so two versions cannot run together.

## Additional source drift found

Production market-autotrader v453 differs from main in `cycle-lease-retry.mjs`: it
does not immediately retry an uncertain DB lease acquire. Preserve that behavior.
Production market-v2-signal v81 matches main. Signal-generator v51 has older bundled
copies of capture-context, dynamic-flow, paid-transport and campaign than main/v183.
Do not silently redeploy it from the shared main graph: isolate/preserve its dependency
version or prove strategy equivalence before changing its bundle. Backups are retained
outside the repository. This dependency audit is an outstanding deployment gate.

No pg_cron was paused, removed or rescheduled in production. No self-call trigger was
changed. SQL/cron cutover tests use an isolated PostgreSQL runtime with a mock cron
schema; they are not production pg_cron observations.
