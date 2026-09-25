/** Independent HOLD observer. Its result is never read by holdStep or the order executor. */
import {sharedReview,callCounter,MODEL_CANDIDATES} from './parallel.mjs';
export const HOLD_RELEASE='FD1-EXIT-HARDENING-DS-SHADOW-1';
// Enabled by the 2026-09-25 deployment approval; explicit false/invalid value disables.
export const holdShadowEnabled=value=>value===''||value==='true';
/** Peak-rate upper bound, not an invoice. Official price card checked 2026-09-25. */
export function flashCostCeiling(result){
  const u=result?.usage;
  if(result?.model!=='deepseek-flash'||!u||![u.prompt_tokens,u.completion_tokens].every(x=>Number.isSafeInteger(x)&&x>=0))return null;
  // Charge all input at cache-miss peak price to avoid under-reserving cache/time boundaries.
  const cost=(u.prompt_tokens*.3+u.completion_tokens*1.2)/1e6;
  return cost<=.10?cost:null;
}
export async function recordHoldShadow({packet,snapshotAt,key,parentKey,identity,store,config,apiKey,
  enabled=false,invoke=callCounter}){
  if(!enabled||!apiKey)return {state:'DISABLED'};
  const record={version:'DS_HOLD_SHADOW_1',kind:'DS_HOLD_SHADOW',purpose:'VERIFICATION',authority:[],
    api_approval_ref:config.approvalRef,identity,parent_key:parentKey,source_commit:'DS_HOLD_SHADOW_1',
    reserved_usd:0.10,packet,snapshot_at_ms:snapshotAt,result:null};
  try{
    const claimed=await store.claim(key,record,config);
    if(!claimed.created)return {state:'DUPLICATE'};
    let result,attempted=false;
    try{
      const input=await sharedReview(packet,{snapshotAtMs:snapshotAt});
      attempted=true;result=await invoke(input,{...MODEL_CANDIDATES[0],apiKey,timeoutMs:8000});
    }catch{result={valid:false,attempted,error:'SHADOW_FAILED'};}
    // Unknown usage keeps the full reservation; known usage settles to a peak-rate ceiling.
    const ceiling=flashCostCeiling(result);
    await store.complete(key,claimed.row.owner,{...record,result:{...result,model_requested:MODEL_CANDIDATES[0].model,
      api_cost_usd:ceiling,cost_basis:ceiling===null?'UNKNOWN_RESERVED':'DS_FLASH_PEAK_UNCACHED_CEILING_20260925'}});
    return {state:'DONE'};
  }catch{return {state:'UNAVAILABLE'};}
}
