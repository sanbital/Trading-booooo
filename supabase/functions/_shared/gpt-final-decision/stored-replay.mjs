import {readSources} from './market.mjs';
import {bars} from './facts.mjs';
import {technicalFacts} from './technical.mjs';
/** Order-free current-policy replay using ONLY a stored decision-time packet.
 * No Binance reads, outcome columns, synthetic buckets or trading table writes. */
import {hash} from './api.mjs';
import {dualEntryDecision} from './dual.mjs';
import {DYNAMIC_VERSION,entryCaptureSafety,dynamicDelta} from './dynamic-flow.mjs';
import {recheckPayload,validateRecheck} from './recheck.mjs';
import {baselinePolicy} from '../self-evolution/policy.mjs';
import {SupabaseReviewStore,readReviewControl} from '../gpt-final-review/supabase-store.mjs';
import {configFromControl} from '../gpt-final-review/coordinator.mjs';
export async function prepareStoredReplay(record){
 const packet=structuredClone(record.result?.final_packet??record.packet);
 if(!packet||!['ENTRY','HOLD','RECHECK'].includes(packet.task))throw Error('REPLAY_PACKET_MISSING');
 const at=record.result?.final_snapshot_at_ms??record.snapshot_at_ms??packet.dynamic_as_of_ms??packet.position?.valuation?.snapshot_at_ms;
 if(!Number.isSafeInteger(at))throw Error('REPLAY_TIMESTAMP_MISSING');
 packet.dynamic_policy=DYNAMIC_VERSION;packet.dynamic_as_of_ms=at;
 if(packet.task==='RECHECK')packet.dynamic_change=dynamicDelta(packet.initial?.capture_context,packet.facts?.capture_context);
 const safety=entryCaptureSafety(packet.facts?.capture_context,at);
 if(packet.task==='HOLD')packet.dynamic_data_state={status:safety.ok?'AVAILABLE':'DATA_DEGRADED',confidence:safety.ok?'NORMAL':'LOW',
  last_valid_age_ms:null,drift_from_last_valid:null,emergency_packet:{status:'UNAVAILABLE',reason:'NOT_SAVED_AT_HISTORICAL_INSTANT'},exposure_increase_allowed:false};
 packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
 return {packet,at,safety};
}
export async function storedDynamicReplay(db,{sourceJobKey,runId,apiKey,deepseekKey,fetchFn=fetch,includeTechnicals=false}){
 if(!/^[a-f0-9]{64}$/.test(sourceJobKey))throw Error('REPLAY_JOB_KEY');
 const source=await db.from('gpt_final_entry_reviews').select('record,purpose,created_at,signal_id').eq('job_key',sourceJobKey).maybeSingle();
 if(source.error||source.data?.purpose!=='PRODUCTION')throw Error('REPLAY_SOURCE_NOT_PRODUCTION');
 const selected=source.data.record.result?.final_packet??source.data.record.packet;
 if(selected?.task==='RECHECK'&&!selected.initial?.capture_context&&source.data.signal_id){
  const prior=await db.from('gpt_final_entry_reviews').select('record').eq('signal_id',source.data.signal_id)
    .eq('purpose','PRODUCTION').lt('created_at',source.data.created_at).order('created_at',{ascending:false}).limit(10);
  const entry=prior.data?.find(x=>x.record?.packet?.task==='ENTRY');
  if(entry)selected.initial={...selected.initial,capture_context:entry.record.packet.facts.capture_context??null};
 }
 const {packet,at,safety}=await prepareStoredReplay(source.data.record);
 let technicalAudit=null;
 if(includeTechnicals){
   const {src,errors}=await readSources(packet.symbol,at,{mode:'REPLAY',fetchFn,ms:2500});
   const extra=technicalFacts(bars(src.one??[],60000,at),bars(src.five??[],300000,at));
   packet.facts={...packet.facts,values:{...packet.facts.values,...extra.values},missing:{...packet.facts.missing,...extra.missing},technical_context:extra.context};
   packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
   technicalAudit={source:'HISTORICAL_COMPLETED_CANDLES',cutoff_ms:at,values:extra.values,missing:extra.missing,errors};
 }
 const key=await hash({version:'DYNAMIC_CONTINUITY_REPLAY_2',sourceJobKey,runId,includeTechnicals});
 const store=new SupabaseReviewStore(db),config=configFromControl(await readReviewControl(db),k=>globalThis.Deno?.env?.get(k)??'');
 const record={version:'DYNAMIC_CONTINUITY_REPLAY_2',kind:'STORED_DYNAMIC_REPLAY',purpose:'DRYRUN',
  identity:{symbol:packet.symbol,source_job_key:sourceJobKey},source_commit:'DYNAMIC_CONTINUITY_2',api_approval_ref:config.approvalRef,
  reserved_usd:.10,packet,snapshot_at_ms:at,result:null};
 const claimed=await store.claim(key,record,config);
 if(!claimed.created)return {orderCalls:0,duplicate:true,jobKey:key};
 const realStart=Date.now(),clock=()=>at+Date.now()-realStart;
 const paidFetch=await store.transport(key,record,fetchFn);
 const result=await dualEntryDecision(packet,{apiKey,deepseekKey,fetchFn:paidFetch,now:clock,snapshotAtMs:at,deadlineMs:at+8000,
  policy:baselinePolicy(),reviewTier:packet.task==='HOLD'?'FAST':'FULL',
  ...(packet.task==='RECHECK'?{inputPayload:recheckPayload,validate:validateRecheck}:{})});
 await store.complete(key,claimed.row.owner,{...record,result:{...result,final_packet:undefined},
  technical_audit:technicalAudit,replay_limitations:{historical_clock:true,current_prompt:true,outcomes_excluded:true,
    emergency_packet_reconstructed:false,trajectory_available:safety.ok,original_data_unchanged:true}});
 return {orderCalls:0,jobKey:key,sourceJobKey,task:packet.task,symbol:packet.symbol,captureSafety:safety,
  technical_audit:technicalAudit,decision:result.decision,valid:result.valid,error:result.error,latency_ms:result.latency_ms,
  audit:result.dynamic_audit,answer:result.answer,missing_history:!safety.ok};
}
