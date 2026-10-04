import {createAccountCriticalSection} from './account-critical-section.mjs';
import {currentExecutionContext,withAnalysisContext,withLeaseCleanup,assertActiveExecutionRequest} from './account-scope-context.mjs';
const unwrap=(r,code)=>{if(r?.error)throw Error(code);return r?.data;};
export function createHostAccountScopes(db,{budget,onEvent=()=>{},timers=globalThis}={}){
 const rpc=async(name,args)=>unwrap(await db.rpc(name,args),name.toUpperCase()+'_UNAVAILABLE');
 const emit=event=>{try{Promise.resolve(onEvent(event)).catch(()=>{});}catch{}};
 const releaseAnalysisLease=async(owner,fence)=>{
  // Retrying the same UUID/fence cannot release a successor. A false result is
  // also complete: the first attempt may have committed without its response.
  let lastError='V17_RELEASE_ANALYSIS_LEASE_UNAVAILABLE';
  for(let attempt=1;attempt<=3;attempt++){
   try{
    const released=await withLeaseCleanup(db,async()=>await db.rpc('v17_release_analysis_lease',{p_owner:owner,p_fence:fence})
     .abortSignal(AbortSignal.timeout(700)));
    if(!released?.error&&(released?.data===true||released?.data===false)){
     if(attempt>1)emit({event:'ANALYSIS_LEASE_RELEASE_RECOVERED',attempts:attempt,fence});
     return;
    }
    lastError=String(released?.error?.code||'V17_RELEASE_ANALYSIS_LEASE_UNAVAILABLE');
   }catch(error){lastError=String(error?.name||'V17_RELEASE_ANALYSIS_LEASE_UNAVAILABLE');}
   if(attempt<3)await new Promise(resolve=>timers.setTimeout(resolve,100*attempt));
  }
  emit({event:'ANALYSIS_LEASE_CLEANUP_WARNING',cleanup_warning:'V17_RELEASE_ANALYSIS_LEASE_UNAVAILABLE',
   attempts:3,fence,error_code:lastError,recovery:'TTL_EXPIRY',lease_ttl_seconds:150});
 };
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
  catch(error){await releaseAnalysisLease(owner,null);throw error;}

  if(!lease)return {ok:true,skipped:'PERIODIC_ANALYSIS_BUSY'};
  if(lease.owner!==owner||!Number.isSafeInteger(Number(lease.fence))){await releaseAnalysisLease(owner,null);throw Error('ANALYSIS_ACQUISITION_EVIDENCE_INVALID');}
  const controller=new AbortController();let running=false;
  const timer=timers.setInterval(()=>{if(running)return;running=true;
   rpc('v17_heartbeat_analysis_lease',{p_owner:owner,p_fence:Number(lease.fence)}).then(ok=>{if(ok!==true)controller.abort(Error('ANALYSIS_HEARTBEAT_FAILED'));},()=>controller.abort(Error('ANALYSIS_HEARTBEAT_FAILED'))).finally(()=>running=false);
  },5000);timer?.unref?.();
  try{return await withAnalysisContext(db,()=>operation(db),{owner,signal:controller.signal,capabilities:{fence:Number(lease.fence),budget:budget?.()}});}
  finally{timers.clearInterval(timer);controller.abort();await releaseAnalysisLease(owner,Number(lease.fence));}
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
