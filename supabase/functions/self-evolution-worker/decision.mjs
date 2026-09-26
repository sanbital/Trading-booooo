import {hash,payloadFor} from '../_shared/gpt-final-decision/api.mjs';
import {dualEntryDecision} from '../_shared/gpt-final-decision/dual.mjs';
import {recheckPayload,validateRecheck} from '../_shared/gpt-final-decision/recheck.mjs';
import {validateDecision} from '../_shared/gpt-final-decision/contract.mjs';
import {validateCapture120} from '../_shared/gpt-final-decision/capture-context.mjs';
import {validatePolicy} from '../_shared/self-evolution/policy.mjs';
import {qualify,metrics,pairedBootstrap,degradation} from '../_shared/self-evolution/statistics.mjs';
/** Historical clock is explicit and immutable. No current market query enters a replay packet. */
export function replayPayload(packet,asof){const copy=structuredClone(packet);copy.facts={...copy.facts,capture_context:undefined};
 const p=packet.task==='RECHECK'?recheckPayload(copy):payloadFor(copy),u=JSON.parse(p.input[1].content),capture=validateCapture120(packet.facts.capture_context,asof);
 if(capture.status==='AVAILABLE'){if(packet.task==='RECHECK')u.current.capture_context=capture;else u.capture_context=capture;}p.input[1].content=JSON.stringify(u);return p;}
export async function policyDecision(store,policy,event,keys){
 event=structuredClone(event);event.packet.replay_cutoff_ms=event.at_ms;event.context.refreshed_packet.replay_cutoff_ms=event.context.refreshed_at_ms;
 const key=await hash({policy,event_id:event.id,packet:event.packet,refresh:event.context.refreshed_packet,engine:'SELF_EVOLUTION_1'});
 return store.cached(key,async()=>{await store.reserve(3,.1);const r=await dualEntryDecision(event.packet,{apiKey:keys.gpt,deepseekKey:keys.deepseek,policy:policy.bundle,
   snapshotAtMs:event.at_ms,inputPayload:p=>replayPayload(p,p.replay_cutoff_ms??event.at_ms),
   validate:event.packet.task==='RECHECK'?validateRecheck:validateDecision,deadlineMs:Date.now()+20000,
   refreshPacket:async()=>({packet:event.context.refreshed_packet,captured:event.context.refreshed_at_ms})});
  const ds=r.arbitration?.deepseek,emergency=event.packet.task==='HOLD'&&!r.valid&&ds?.valid===true&&['HOLD','PROTECT','EXIT'].includes(ds.answer?.decision_preference)&&ds.answer.recommended_action===ds.answer.decision_preference;
  return {valid:emergency||r.valid,decision:emergency?ds.answer.decision_preference:r.decision,error:r.error,wire:r.wire,answer:r.answer,arbitration:r.arbitration,api_cost_usd:r.api_cost_usd,authority:emergency?'DEEPSEEK_EMERGENCY_EXIT_ONLY':r.arbitration?.authority,policy_hash:policy.sha256,latency_ms:Math.max(r.latency_ms??0,event.context.refreshed_at_ms-event.at_ms),refresh_error:emergency?null:r.arbitration?.refresh_error,final_packet:r.final_packet,final_snapshot_at_ms:r.final_snapshot_at_ms};});
}
