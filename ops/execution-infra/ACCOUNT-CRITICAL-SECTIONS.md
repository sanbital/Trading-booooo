# Account critical sections — staged, explicit activation

This replaces the executor's account-wide 90s scan/model lease with a separate
logged, postmaster-fenced analysis lease. The existing logged dispatch/orders remain
BUY execution truth. No strategy/model/freshness/window/capacity setting changes.

A writer acquires the existing v17 account lease before atomic dispatch claim, then
releases it while the claimed signal prepares market data and GPT delta review.
The writer is reacquired for original-authority/current portfolio/order/circuit/
capacity/fresh 24-bucket checks and mandatory durable ORDER_SUBMITTING acknowledgement.
The original deadline remains fixed. Uncertain submission never becomes READY.

Native protection, exits and same-order reconciliation use short writer sections.
GPT/candle/QV3/scan work runs outside them. Owned paid-provider journal receipts use
an isolated journal client; a finished analysis task cannot start another paid review
or acquire order authority. Heartbeats run every 5s with owner/fence/postmaster checks.
The existing 150s TTL/30s verify reserve remain unchanged during measured rollout;
new critical-section duration must be measured before reducing that compatibility TTL.

After any DB generation change entries stay frozen until fresh complete venue
orders/positions, exact original-order reconciliation, attribution and acknowledged
protection match the DB manifest. Existing native stops remain venue resident.
No expired BUY, previous order tick or old authority is replayed.

Gateway signed mutations check the DB writer after local queue/time synchronization
and after signing, immediately before network send. A suspended request retains its
original timestamp and the venue's existing 5s recvWindow. Nonce/HMAC controls remain.
With the mandatory gateway flag enabled, retired P10 BUY cannot use the management
compatibility adapter. Existing reduce-only CLOSE/cancel/native protection acquire
the same account writer at the gateway. Spot/Upbit keep their existing account controls.

## Expand, validate, activate

1. Apply additive migration with short_writer_enabled=false.
2. Deploy gateway with ORDER_WRITER_REQUIRED=false and existing machine/flags unchanged.
   Signed writer envelopes are checked even in staged mode. Check encrypted machine
   rollback snapshots and both live build markers.
3. Deploy exact main executor bundle; compare every deployed source, not version alone.
4. At a quiet clock phase, ensure legacy active account holder has finished, then
   atomically enable short_writer_enabled. Do not widen a BUY deadline to bridge cutover.
5. Verify recovery generation, writer/analysis heartbeats, no unknown order/missing stop.
   Enable gateway ORDER_WRITER_REQUIRED after management compatibility is verified.
6. Observe same-cohort dispatch/claim/submit/protection and actual writer p50/p95/p99.

Rollback: stop new writer admissions, drain active sections, set short_writer_enabled=false
and revert only executor bundle to the saved v186 source. Disable gateway mandatory flag
before a legacy executor is restored; preserve additive logged state, order IDs and restart
fencing. Reconcile UNKNOWN before entries resume. No replay and no database restart.
Scheduler cutover is separate and has not occurred in this PR.
