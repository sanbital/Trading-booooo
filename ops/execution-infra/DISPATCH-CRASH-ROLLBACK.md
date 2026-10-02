# DISPATCH_NO_RESUBMIT_1 deployment and rollback

Apply the formal expand migration before deploying the journal hook in the executor.
It replaces the existing claim/transition RPCs without changing their signatures,
state vocabulary, 24-second execution reserve, BUY deadline, guards or strategy.
The order writer and external scheduler are separate pending cutovers.

The previous production claim RPC could reclaim `ORDER_SUBMITTING` after lease
expiry. The new RPC routes it to UNKNOWN, before checking deadline, and blocks every
existing order identity from becoming a new entry. A submitted request can never
return to READY. UNKNOWN is reconciled only from the same GPT completion, confirmed
order-state evidence, and matching position attribution; partial fills stay partial.
The existing engine still fetches and reconciles the exact client order ID.

On an executor rollback, redeploy preserved v184 source and keep these safe RPCs.
They are backward compatible. Disable the new journal hook, rather than restoring
unsafe ambiguous-order reclaim. Keep recovery events and the logged dispatch/order
ledger. Do not delete UNKNOWN, reuse client IDs, replay expired BUYs, or restore old
position/PnL snapshots. An UNKNOWN lacking complete evidence remains entry-blocking
through the existing account order risk guard and requires same-ID reconciliation.

If the migration itself must be investigated, freeze new entries using the existing
operator controls, retain protection/exit/reconciliation and inspect the preserved
pre-migration function definitions. Never restore the old claim RPC while entries
are live. `leader20_reconcile_execution_dispatches` performs no exchange mutation.
