# Fenced account writer — prepared expand stage

This change is disabled and is **not a completed production writer conversion**.
The original v183 executor still owns its original account lease. Nothing here routes
its orders into the new outbox until the production adapters and cutover are verified.

## Implemented and isolated verification

`20261001233000_account_writer_expand.sql` creates logged request/event/lease/control
tables with service-only RPCs, immutable execution identity, unique submission client
IDs, lease-before-claim ordering, monotonic fencing, heartbeat failure, exact terminal
reasons, and reconciliation priority. An expired submitted command remains UNKNOWN;
it is never changed back to PENDING. Reconciliation needs conclusive exchange identity
evidence; a negative lookup alone cannot authorize a resend.

`account-order-writer.mjs` reuses injected production validation/settlement adapters.
It repeats validation after DB I/O and never extends deadlines or freshness thresholds.
Gateway `order-writer-fence.mjs` binds the submitted command to the exact durable JSON
payload and current account fence immediately before side effects. Read-only exchange
proofs remain available when DB admission fails. Gateway mode defaults to disabled.

Follow-up adapters add exact signed command transport, same-client-ID exchange query
using existing entry/exit receipt guards, corroborated never-placed proof with the
existing six-hour retention bound, and partial-fill finality enforcement. DB constraints
bind the reserved client ID to the actual submitted JSON payload. Ambiguous attempts
back off without blocking higher-priority protection; their presence freezes all entries.

`account-writer-recovery.mjs` runs ordered readiness, open-order, position, unknown-order,
fill, protection and capacity adapters outside the writer lease. Only the final short
DB completion holds that lease. Postmaster/generation and a durable event cursor reject
stale recovery evidence. Existing v183 validation/position/protection callbacks are
still not wired to these new workers, so this remains a disabled expand stage.

The new isolated tests use real PostgreSQL functions via PGlite, not a duplicate JS
state machine. They verify unique identities, claim takeover, stale fencing/heartbeat,
crash after submission, same-ID timeout recovery, negative lookup uncertainty,
partial fills, terminal refusal, priority, and postmaster-bound recovery freeze.
An independent analysis test proves only the new infrastructure's lack of an analysis
lease; it is not evidence that the legacy 90-second production cycle is converted.

## Activation requirements still outstanding

1. Obtain current live schema/functions/cron backups and unresolved orders/positions.
2. Wire all existing create/cancel/exit/protection/reconciliation callers to this outbox,
   retaining their existing authority, capacity, 24-bucket, freshness and native-stop rules.
   Bind settlement to existing fill/position/accounting truth. Convert periodic analysis
   to its own lease. The prepared module alone does not accomplish these changes.
3. Measure critical-section p99 and network bound. The DB refuses activation without
   a recorded measurement and TTL exceeding both; no production TTL is guessed here.
4. Make every caller provide a durable envelope before requiring gateway fencing.
   Stop the legacy writer before enabling the new writer. Never run both writers.
5. Complete isolated end-to-end tests with real production adapters, then perform
   staged activation and observe the same decision cohort for 30m, 2h and 24h.

## Rollback

While disabled, revert the gateway/code commit. Keep the expanded logged tables;
their presence has no effect on the legacy lease/trigger/cron. After activation, first
stop new entry admission, reconcile SUBMITTING/UNKNOWN and verify protection. Disable
new writer workers before restoring the previous writer and gateway mode. Never drop
outbox history or restore an old snapshot over orders sent after that snapshot.

## Operational evidence

Read-only runner 36942548821, 2026-10-01 23:46 UTC / 2026-10-02 08:46 KST:
DB query HTTP 544; exchange complete positions and ordinary/conditional orders all zero
at 23:46:40.630 UTC / 08:46:40.630 KST. The DB ledger remains unverified.
