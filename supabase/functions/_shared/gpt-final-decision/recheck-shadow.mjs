/** DeepSeek FINAL RECHECK observer.
 * Uses the exact RECHECK packet already prepared for GPT, starts independently, and has
 * zero order authority. A failure, timeout, invalid response, budget issue, or missing key
 * never delays or changes GPT's production decision.
 */
import {sharedReview,callCounter,MODEL_CANDIDATES} from './parallel.mjs';
import {hash} from './api.mjs';
import {recheckPayload} from './recheck.mjs';
import {flashCostCeiling} from './hold-shadow.mjs';

export const RECHECK_SHADOW_VERSION='DS_RECHECK_SHADOW_1';
export const recheckShadowJobKey=parentKey=>hash({kind:RECHECK_SHADOW_VERSION,parentKey});
export const recheckShadowEnabled=value=>value===''||value==='true';

export async function recordRecheckShadow({packet,snapshotAt,parentKey,identity,store,config,apiKey,
  enabled=false,invoke=callCounter}){
  if(!enabled||!apiKey||!packet||packet.task!=='RECHECK'||!parentKey)return {state:'DISABLED'};
  const record={version:RECHECK_SHADOW_VERSION,kind:'DS_RECHECK_SHADOW',purpose:'VERIFICATION',authority:[],
    api_approval_ref:config?.approvalRef??null,identity,parent_key:parentKey,source_commit:RECHECK_SHADOW_VERSION,
    reserved_usd:0.10,packet,snapshot_at_ms:snapshotAt,result:null};
  try{
    const key=await recheckShadowJobKey(parentKey);
    const claimed=await store.claim(key,record,config);
    if(!claimed.created)return {state:'DUPLICATE',key};
    let result,attempted=false;
    try{
      const input=await sharedReview(packet,{snapshotAtMs:snapshotAt,inputPayload:recheckPayload});
      attempted=true;
      result=await invoke(input,{...MODEL_CANDIDATES[0],apiKey,timeoutMs:4000});
    }catch{result={valid:false,attempted,error:'RECHECK_SHADOW_FAILED'};}
    const ceiling=flashCostCeiling(result);
    await store.complete(key,claimed.row.owner,{...record,result:{...result,model_requested:MODEL_CANDIDATES[0].model,
      api_cost_usd:ceiling,cost_basis:ceiling===null?'UNKNOWN_RESERVED':'DS_FLASH_PEAK_UNCACHED_CEILING_20260925'}});
    return {state:'DONE',key,valid:result?.valid===true};
  }catch{return {state:'UNAVAILABLE'};}
}
