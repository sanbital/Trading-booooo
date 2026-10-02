import {assertActiveExecutionRequest,withReviewContext} from './account-execution-context.mjs';
/** Trading request lifetime and already-scheduled paid review lifetime differ.
 * Only this immutable review can start its provider stages before its original
 * deadline. Owned receipts/terminal CAS can settle afterwards; no order capability.
 */
export function createProviderJournal(db,receipts){
 return {receipts,reviewScope:(identity,operation)=>withReviewContext(db,identity,operation),
  assertCanStart:key=>{const c=assertActiveExecutionRequest(db);if(c?.kind==='REVIEW'&&c.reviewKey!==key)throw Error('REVIEW_JOB_BINDING_MISMATCH');},
  ledger:{rpc:(name,args)=>{
   if(!['ai_call_reserve_owned','ai_call_transition','ai_call_settle_receipt'].includes(name))throw Error('PROVIDER_JOURNAL_RPC_ONLY');
   if(name==='ai_call_reserve_owned'||(name==='ai_call_transition'&&args.p_state==='DISPATCHED')){
    const c=assertActiveExecutionRequest(db);
    if(name==='ai_call_reserve_owned'&&c?.kind==='REVIEW'&&c.reviewKey!==args.p_parent)throw Error('REVIEW_PROVIDER_PARENT_MISMATCH');
   }
   return receipts.rpc(name,args);
  }}};
}
