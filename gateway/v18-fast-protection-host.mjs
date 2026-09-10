/** Bounded polling host. Only calls the executor's management-only mode.
 * The executor holds the shared database lease; no database credential lives here.
 * No polling starts on import or construction. */
export const FAST_PROTECTION_VERSION='V18-FAST-PROTECTION-1';
export function createFastProtectionHost({invoke,intervalMs=2000,timeoutMs=45000,
 timers=globalThis,clock=Date.now,report=()=>{}}) {
 if(!Number.isFinite(intervalMs)||intervalMs<2000||intervalMs>30000)throw Error('INVALID_FAST_INTERVAL');
 if(!Number.isFinite(timeoutMs)||timeoutMs<1000||timeoutMs>45000)throw Error('INVALID_FAST_TIMEOUT');
 let running=false,stopped=true,timer=null,controller=null,failures=0,generation=0;
 const state={version:FAST_PROTECTION_VERSION,enabled:false,inFlight:false,runs:0,failures:0,lastStartedAt:null,lastSuccessAt:null,lastFailureAt:null,lastDurationMs:null};
 function schedule(delay){if(stopped)return;timer=timers.setTimeout(tick,delay);timer?.unref?.();}
 async function tick(){
  if(stopped||running)return;
  running=true;state.inFlight=true;const gen=generation,start=clock();state.lastStartedAt=start;
  controller=new AbortController();const timeout=timers.setTimeout(()=>controller?.abort(),timeoutMs);
  try{
   const out=await invoke({mode:'protect'},controller.signal);
   if(gen!==generation)return;
   if(out?.ok!==true)throw Error('FAST_PASS_FAILED');
   state.runs++;failures=0;
   if(out.skipped!=='V17_EXECUTOR_BUSY'&&out.skipped!=='RUNTIME_DISABLED')state.lastSuccessAt=clock();
  }catch{
   if(gen===generation){failures++;state.failures++;state.lastFailureAt=clock();}
  }finally{
   timers.clearTimeout(timeout);controller=null;running=false;state.inFlight=false;
   state.lastDurationMs=clock()-start;
   if(gen!==generation&&!stopped)schedule(0);
   else if(gen===generation&&!stopped){
    // A sparse feed or a failed pass produces observable degradation, not a tight loop.
    const wait=failures?Math.min(60000,intervalMs*2**Math.min(failures,5)):intervalMs;
    report({...state});schedule(wait);
   }
  }
 }
 return {start(){if(!stopped)return;stopped=false;state.enabled=true;generation++;schedule(0);},
  stop(){stopped=true;state.enabled=false;generation++;if(timer!==null)timers.clearTimeout(timer);controller?.abort();},
  status:()=>({...state}),tick};
}
