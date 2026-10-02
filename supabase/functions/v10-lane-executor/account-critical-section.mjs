import {assertActiveExecutionRequest,currentAccountOwner,currentExecutionContext,withWriterContext,assertAccountWriterContext} from './account-execution-context.mjs';
// Only callers preparing a real mutation or fenced accounting commit enter here.
// The existing logged orders/dispatch remain the journal; this adds no second outbox.
export function createAccountCriticalSection({acquire,verify,heartbeat,release,now=Date.now,timers=globalThis,
 owner=()=>crypto.randomUUID(),heartbeatMs=5000,onEvent=()=>{}}){
 if(!Number.isInteger(heartbeatMs)||heartbeatMs<100||heartbeatMs>10000)throw Error('INVALID_WRITER_HEARTBEAT');
 const emit=e=>{try{Promise.resolve(onEvent(e)).catch(()=>{});}catch{}};
 return async function critical(db,operation,{deadline=Infinity,correlationId=null}={}){
  assertActiveExecutionRequest(db);const inherited=currentAccountOwner(db);
  if(inherited){assertAccountWriterContext(db);await verify(inherited,currentExecutionContext(db).fence);return operation();}
  if(now()>=deadline)return {deferred:true,reason:'DEADLINE_EXPIRED'};
  const id=owner(),started=now();let lease;
  try{lease=await acquire(id);}catch(error){
   // An uncertain acquisition is never permission to submit. Only release our UUID.
   try{await release(id,null);}catch{}throw error;
  }
  if(!lease)return {deferred:true,reason:'ACCOUNT_WRITER_BUSY'};
  if(lease.owner!==id||!Number.isSafeInteger(lease.fence)||lease.fence<1){try{await release(id,lease?.fence);}catch{}throw Error('WRITER_ACQUISITION_EVIDENCE_INVALID');}
  const controller=new AbortController();let heartbeatTask=null,finished=false;
  const fail=()=>controller.abort(Error('WRITER_HEARTBEAT_FAILED'));
  const timer=timers.setInterval(()=>{
   if(finished||heartbeatTask)return;
   heartbeatTask=Promise.resolve().then(()=>heartbeat(id,lease.fence)).then(ok=>{if(ok!==true)fail();},fail).finally(()=>heartbeatTask=null);
  },heartbeatMs);timer?.unref?.();
  emit({event:'ACCOUNT_WRITER_ACQUIRED',correlation_id:correlationId,fence:lease.fence,at_ms:started});
  try{
   return await withWriterContext(db,id,async context=>{
    context.fence=lease.fence;await verify(id,lease.fence);controller.signal.throwIfAborted();
    if(now()>=deadline)return {deferred:true,reason:'DEADLINE_EXPIRED'};
    const result=await operation({signal:controller.signal,owner:id,fence:lease.fence});
    // A timeout/heartbeat failure after submission stays an ambiguous outcome.
    controller.signal.throwIfAborted();await verify(id,lease.fence);return result;
   },{signal:controller.signal});
  }finally{
   finished=true;timers.clearInterval(timer);controller.abort();
   // Do not wait for a hung heartbeat. UUID/fence release cannot affect a successor.
   try{await release(id,lease.fence);}catch{emit({event:'ACCOUNT_WRITER_RELEASE_UNCERTAIN',correlation_id:correlationId,fence:lease.fence});}
   emit({event:'ACCOUNT_WRITER_FINISHED',correlation_id:correlationId,fence:lease.fence,duration_ms:now()-started});
  }
 };
}
