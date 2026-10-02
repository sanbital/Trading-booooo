The external clock replaces four sub-minute pg_cron callers and three hourly public
self-calls, plus the five-minute regime observer. Tokyo's existing monitor (2s) and
account maintenance (12s) move into that same orchestrator. Paris remains order-only.
Original strategy/model/capture/deadline/sizing/stop code remains unchanged.

The catalog preserves observer's original ten-minute clock phase and OUTBOX_WAKE
guard. Hourly scans preserve offsets 02/04/08 and skip missed historical ticks.
Every accepted endpoint call is bound to one logged deterministic DB tick. Duplicate,
stale and previous-postmaster callers fail closed. The account writer separately
revalidates original BUY permission at physical submission.

1. Apply the additive schema disabled, then the reviewed live catalog disabled at
   control level. Preserve every old cron row and both running machine images.
2. Deploy all endpoint admission changes; compare all source bytes to main. Deploy
   both gateways with external mode false; check the complete Docker COPY graph,
   existing machine size, native stop worker, legacy intervals and exact build.
3. Use the exact live cron name/schedule/command-MD5 manifest in
   trading_scheduler_pause_cron. Check queued requests and actual running jobs have
   drained; wait for paid provider work and original pending BUY windows without
   enlarging them. Enable the logged control with trading_scheduler_activate.
4. Explicit enable_external on Tokyo stops legacy timers before starting the single
   clock. Verify leader/postmaster/heartbeat/job ticks and recovery-first readiness.
   Enable the mandatory account writer on both gateways separately.
5. Observe actual job latency, original-decision funnel, same-order UNKNOWN recovery,
   protection, DB restarts and remaining cron startup timeouts. No observation of a
   future time window may be reported as complete.

Rollback scheduler only: disable_external on Tokyo, verify its external clock stopped,
then trading_scheduler_rollback with that concrete proof restores only the exact old
cron rows. Endpoint admission allows the original callers when control is disabled.
Keep account short-writer mode, unique order IDs and reconciliation fencing enabled.
The v187 executor bundle and both encrypted pre-cutover machine snapshots are the
independent P0 rollback checkpoints. Never replay past BUY or restart the DB for testing.

DB failures share the existing gateway dependency breaker (30-60s bounded backoff),
with jitter and individual job bulkheads. Process heartbeat persists during an outage.
Permanent 4xx disables the affected durable job. Timeout does not create a second
concurrent instance. Readiness must come from the real v17 account recovery path,
including orders, positions, attribution, acknowledged protection and current generation.
The scheduler has no venue submission route and no authoritative local trading state.
