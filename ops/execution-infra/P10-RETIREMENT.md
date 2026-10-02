# P10 entry retirement candidate

Production market-autotrader v453 was downloaded and preserved before editing.
Its index matches main (ignoring terminal newline); its `cycle-lease-retry.mjs`
is newer. Main is synchronized to the production helper's single DB admission
attempt: uncertain acknowledgements fail closed without immediate retry traffic.

The P10 scan retains portfolio/exposure checks, fee reconciliation, external-flow
detection, snapshots, accounting, lock reconciliation and residual cleanup.
The entry signal load/claim/order loop is removed after that maintenance completes.
The independent P10 monitor, exit, native protection and pending-order reconciliation
paths are preserved. Existing entry settlement helpers remain for durable in-flight
recovery; they are not blanket-deleted. Retirement has explicit version
`P10_ENTRY_RETIREMENT_20261002_1` and no runtime re-enable switch.

A test executes the real transpiled scan with entry otherwise permitted, validates
that fee/snapshot/accounting/open-order/lock/cleanup/heartbeat work completes, and
fails if entry signal or order functions execute. The post-submit reconciliation
latch ownership and gateway APPLIED safeguards retain their existing tests.

This is **not deployed**. The prompt identifies P10 entry as permanently DB-blocked;
the current guard definition/settings must still be checked when production SQL is
available before rollout. P10 uses its own `autotrader-scan`/`autotrader-monitor`
lease, not the V17 execution lease. This change reduces unnecessary DB/signal/order
attempt work; it is not described as directly freeing the V17 lease.

Market-v2-signal migration is prepared in the external scheduler PR. Its actual
three live cron names/cadences/failure counts are unavailable while DB returns 544;
no cron was removed or moved, and the historical 21 failures were not reused as a
current count. Cron offsets and workflow/function ownership remain pending live
inventory verification. The one already verified historical collector workflow was
retired in merged PR #277; no other unknown path is deleted.

Rollback this code commit to restore the preserved v453 scan after stopping new
entry dispatch. The production DB guard must remain in place throughout rollback.
Retain the synchronized v453 admission helper; do not restore main's immediate retry.
