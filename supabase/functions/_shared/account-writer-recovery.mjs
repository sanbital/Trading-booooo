/** Ordered recovery, with long reads/attribution outside the short writer lease.
 * This pipeline cannot bypass the existing reconciliation/protection/capacity adapters.
 * Their incomplete verdict keeps entries frozen; it never submits an entry or replays ticks.
 */
export function createWriterRecovery({repository,account,openOrders,positions,
  reconcile,attributeFills,protection,capacity,onEvent=()=>{}}) {
  return async ({signal}={}) => {
    const observe=(stage,result)=>{try{Promise.resolve(onEvent({stage,result})).catch(()=>{});}catch{}};
    let lease;
    try {
      const begin=await repository.recoveryStatus(account);
      if (!begin?.postmaster_at) throw Error('DB_READINESS_INCOMPLETE');
      signal?.throwIfAborted();observe('DB_READINESS','COMPLETE');
      const orders=await openOrders({signal});
      if (orders?.complete!==true) throw Error('OPEN_ORDERS_INCOMPLETE');
      signal?.throwIfAborted();observe('OPEN_ORDERS','COMPLETE');
      const held=await positions({signal});
      if (held?.complete!==true) throw Error('POSITIONS_INCOMPLETE');
      signal?.throwIfAborted();observe('POSITIONS','COMPLETE');
      const context={orders,positions:held,signal,postmaster_at:begin.postmaster_at};
      for (const [stage,adapter] of [['UNKNOWN_RECONCILIATION',reconcile],
        ['FILL_ATTRIBUTION',attributeFills],['PROTECTION_SYNC',protection]]) {
        const result=await adapter(context);
        if (result?.complete!==true) throw Error(`${stage}_INCOMPLETE`);
        signal?.throwIfAborted();observe(stage,'COMPLETE');
      }
      // Capture the mutation cursor before final capacity verification. Any later
      // writer action, DB restart or generation change makes completion fail closed.
      const checkpoint=await repository.recoveryStatus(account);
      if (checkpoint.postmaster_at!==begin.postmaster_at || checkpoint.generation!==begin.generation) {
        throw Error('RECOVERY_GENERATION_CHANGED');
      }
      if ((await capacity(context))?.complete!==true) throw Error('CAPACITY_INCOMPLETE');
      signal?.throwIfAborted();observe('CAPACITY_RECALCULATION','COMPLETE');
      lease=await repository.acquire(account,crypto.randomUUID());
      if (!lease) throw Error('RECOVERY_WRITER_BUSY');
      const completed=await repository.completeRecovery(lease,checkpoint.generation,{
        db_ready:true,open_orders_complete:true,positions_complete:true,unknown_reconciled:true,
        fills_attributed:true,protection_complete:true,capacity_recalculated:true,
        postmaster_at:checkpoint.postmaster_at,event_cursor:checkpoint.event_cursor,
      });
      observe('RECOVERY_COMPLETE',completed?'COMPLETE':'INCOMPLETE');
      return completed===true;
    } catch (error) {
      observe('RECOVERY_BLOCKED',String(error?.message??'DEPENDENCY_UNAVAILABLE'));
      return false;
    } finally {
      if (lease) try{await repository.release(lease);}catch{}
    }
  };
}
