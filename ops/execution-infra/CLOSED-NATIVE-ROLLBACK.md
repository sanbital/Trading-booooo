# Closed native stop reconciliation

`CLOSED_NATIVE_ABSENCE_1` verifies signed exchange negative lookup, bounded complete algo/order/trade history, flat current positions/orders and exact authoritative software exit receipts. It does not infer that a historic submission never happened. It cannot submit or cancel exchange orders, reapply PnL, reopen a position, extend BUY authority or change trading controls.

Exchange reads run outside the writer lease. The RPC acquires the existing account lease only inside its database transaction, checks postmaster identity and a five-second proof age, locks/validates the closed position and its exact unchanged receipts/stop specification, updates only the stop terminal record and writes a logged proof event. A failed batch rolls back the acquisition and all changes. A successful batch releases the lease before returning.

Deploy the backward-compatible migration before enabling the manual `closed-native-reconciliation.yml` workflow. Repository/main/version guards, private-key-free encrypted evidence and unique `(position_id, client_id)` events prevent silent or duplicate recovery. Incomplete/truncated reads, expired retention windows, foreign/unattributed fills and busy/fenced leases stay pending. A remaining backlog fails the run explicitly. Old BUY requests are never replayed.

Rollback: disable the reconciliation workflow and drop only `public.v18_reconcile_closed_native_absence(uuid,timestamptz,jsonb)`. Preserve the logged `v18_closed_native_proof_events` evidence and settled stop records. Existing v183/v184 readers already skip terminal stops, so rollback does not require reopening resolved records. Never restore historical position/PnL snapshots over subsequent trading state. Exchange-native hard stops are unchanged.

This manual recovery path is an interim tool. Its bounded proof verifier and atomic RPC must be connected to the external scheduler recovery catalog for unattended recovery; that cutover is a separate deployment. It does not establish that the account writer or all scheduler jobs have been migrated.
