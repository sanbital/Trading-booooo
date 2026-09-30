export const EXECUTION_DISPATCH_STATE=Object.freeze({
  READY:'READY_TO_EXECUTE',CLAIMED:'EXECUTION_CLAIMED',SUBMITTING:'ORDER_SUBMITTING',
});

const rowOf=data=>data?.row??null;

/** Atomic signal claim. SQL owns contention, lease recovery and deadline refusal. */
export async function claimExecutionDispatch(db,{signalId=null,owner,minRemainingMs}){
  const r=await db.rpc('leader20_execution_claim',{p_signal_id:signalId,p_owner:owner,
    p_min_remaining_ms:minRemainingMs});
  if(r.error)throw Error(`EXECUTION_DISPATCH_CLAIM:${r.error.message}`);
  return {...(r.data??{}),row:rowOf(r.data)};
}

/** Best-effort state journal: trading truth remains order/position/exchange reconciliation. */
export async function transitionExecutionDispatch(db,{signalId,owner,state,error=null,orderId=null}){
  const r=await db.rpc('leader20_execution_transition',{p_signal_id:signalId,p_owner:owner,
    p_state:state,p_error:error,p_order_id:orderId});
  if(r.error)throw Error(`EXECUTION_DISPATCH_TRANSITION:${r.error.message}`);
  return r.data;
}

export function prioritizeSignal(rows,signalId){
  if(!signalId)return rows;
  const index=rows.findIndex(row=>String(row?.id)===String(signalId));
  if(index<=0)return rows;
  return [rows[index],...rows.slice(0,index),...rows.slice(index+1)];
}
