import {createAccountCriticalSection} from './account-critical-section.mjs';
import {currentExecutionContext,withAnalysisContext,withLeaseCleanup,assertActiveExecutionRequest} from './account-scope-context.mjs';
const unwrap=(r,code)=>{if(r?.error)throw Error(code);return r?.data;};
export function createHostAccountScopes(db,{budget,onEvent=()=>{},timers=globalThis}={}){
 const rpc=async(name,args)=>unwrap(await db.rpc(name,args),name.toUpperCase()+'_UNAVAILABLE');
 const verifyWriter=async(owner,fence)=>{if(await rpc('v17_verify_writer',{p_owner:owner,p_fence:fence})!==true)throw Error('V18_EXECUTION_FENCED');};
 const critical=createAccountCriticalSection({timers,onEvent,
  acquire:async owner=>{const parent=assertActiveExecutionRequest(db);if(parent?.kind==='ANALYSIS')await rpc('v17_require_analysis_scope',{p_owner:parent.owner,p_fence:parent.fence,p_dispatch:parent.claim?.signalId??null});const l=await rpc('v17_acquire_gateway_writer',{p_owner:owner});return l?{...l,fence:Number(l.fence)}:null;},verify:verifyWriter,
  heartbeat:(owner,fence)=>rpc('v17_heartbeat_execution_lease',{p_owner:owner,p_fence:fence}),
  release:(owner,fence)=>withLeaseCleanup(db,()=>rpc('v17_release_writer',{p_owner:owner,p_fence:fence}))});
 const verify=async()=>{
  const c=assertActiveExecutionRequest(db);if(!c)throw Error('EXECUTION_SCOPE_REQUIRED');
  if(c.kind==='WRITER')return verifyWriter(c.owner,c.fence);
  return rpc('v17_require_analysis_scope',{p_owner:c.owner,p_fence:c.fence,p_dispatch:c.claim?.signalId??null});
 };
 const periodic=async(operation)=>{
  const owner=crypto.randomUUID();let lease;
  try{lease=await rpc('v17_acquire_analysis_lease',{p_owner:owner});}
  catch(error){try{await withLeaseCleanup(db,()=>rpc('v17_release_analysis_lease',{p_owner:owner,p_fence:null}));}catch{}throw error;}

  if(!lease)return {ok:true,skipped:'PERIODIC_ANALYSIS_BUSY'};
  if(lease.owner!==owner||!Number.isSafeInteger(Number(lease.fence)))throw Error('ANALYSIS_ACQUISITION_EVIDENCE_INVALID');
  const controller=new AbortController();let running=false;
  const timer=timers.setInterval(()=>{if(running)return;running=true;
   rpc('v17_heartbeat_analysis_lease',{p_owner:owner,p_fence:Number(lease.fence)}).then(ok=>{if(ok!==true)controller.abort(Error('ANALYSIS_HEARTBEAT_FAILED'));},()=>controller.abort(Error('ANALYSIS_HEARTBEAT_FAILED'))).finally(()=>running=false);
  },5000);timer?.unref?.();
  try{return await withAnalysisContext(db,()=>operation(db),{owner,signal:controller.signal,capabilities:{fence:Number(lease.fence),budget:budget?.()}});}
  finally{timers.clearInterval(timer);controller.abort();await withLeaseCleanup(db,()=>rpc('v17_release_analysis_lease',{p_owner:owner,p_fence:Number(lease.fence)}));}
 };
 const dispatch=async(claim,row,operation)=>withAnalysisContext(db,()=>operation(db),{
  owner:claim.owner,capabilities:{fence:Number(row.claim_attempts),claim,budget:budget?.()}});
 // Parallel analyses share only this short mutation queue. Nested operations keep
 // their existing writer; queued callers revalidate original authority on acquisition.
 let mutationTail=Promise.resolve();
 const serializedCritical=(...args)=>{
  if(currentExecutionContext(db)?.kind==='WRITER')return critical(...args);
  const task=mutationTail.then(()=>critical(...args));
  mutationTail=task.catch(()=>{});return task;
 };
 return {critical:serializedCritical,periodic,dispatch,verify,current:()=>currentExecutionContext(db)};
}
