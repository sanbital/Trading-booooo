import {createAccountCriticalSection} from './account-critical-section.mjs';
import {currentExecutionContext,withAnalysisContext,withLeaseCleanup,assertActiveExecutionRequest} from './account-scope-context.mjs';
const unwrap=(r,code)=>{if(r?.error)throw Error(code);return r?.data;};
export function createHostAccountScopes(db,{budget,onEvent=()=>{},timers=globalThis}={}){
 const rpc=async(name,args)=>unwrap(await db.rpc(name,args),name.toUpperCase()+'_UNAVAILABLE');
 const verifyWriter=async(owner,fence)=>{
  if(await rpc('v17_verify_execution_lease',{p_owner:owner})!==true)throw Error('V17_EXECUTION_LEASE_EXPIRED');
  const row=unwrap(await db.from('v17_execution_lease').select('owner,fence').eq('singleton',true).single(),'WRITER_FENCE_READ');
  if(row?.owner!==owner||Number(row?.fence)!==fence)throw Error('V18_EXECUTION_FENCED');
 };
 const critical=createAccountCriticalSection({timers,onEvent,
  acquire:async owner=>{const parent=assertActiveExecutionRequest(db);if(parent?.kind==='ANALYSIS')await rpc('v17_require_analysis_scope',{p_owner:parent.owner,p_fence:parent.fence,p_dispatch:parent.claim?.signalId??null});if(await rpc('v17_acquire_execution_lease',{p_owner:owner})!==true)return null;
   const l=unwrap(await db.from('v17_execution_lease').select('owner,fence').eq('singleton',true).single(),'WRITER_ACQUIRE_EVIDENCE_READ');
   return {...l,fence:Number(l?.fence)};},verify:verifyWriter,
  heartbeat:(owner,fence)=>rpc('v17_heartbeat_execution_lease',{p_owner:owner,p_fence:fence}),
  release:owner=>withLeaseCleanup(db,()=>rpc('v17_release_execution_lease',{p_owner:owner}))});
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
 return {critical,periodic,dispatch,verify,current:()=>currentExecutionContext(db)};
}
