/** Evidence selection transport. The model chooses a named fact; source values are
 * attached locally, never generated, rounded, or corrected from model text.
 * The canonical validator still checks identity, freshness at the caller, claims,
 * numeric evidence requirements, completeness, and unsupported prose. */
import {FACTORS,LIMITS,ensure,evidenceAt,validateShape,parseApiResponse,validateAnswer} from './contract.mjs';
export const WIRE_VERSION='FACTREF4';
const original=['volumeRatio','return5m','return15m','return30m','return60m','btc_return30m','btc_return2h','source_buy_share_3m','source_price_change_3m','source_buy_share_first','source_buy_share_previous','source_buy_share_latest'];
const current=['return_5m','return_15m','return_30m','return_60m','volume_ratio_3m','taker_buy_ratio_3m','relative_strength_btc_15m','distance_recent_high_15m','distance_sma20','distance_trigger_reference','last_body','last_upper_wick','last_lower_wick','last_close_change','day_return','spread','depth','funding',
 'bid_depth_25bps','book_imbalance_25bps','ask_depth_to_slot_notional','mark_index_premium','open_interest_usdt','oi_change_5m','oi_change_60m'];
export const FACT_PATHS=Object.freeze(Object.fromEntries([
 ...original.map(k=>['O_'+k,'/original_model/metrics/'+k]),
 ...FACTORS.map(k=>['F_'+k,'/original_model/factors/'+k]),
 ...current.map(k=>['C_'+k,'/current_market/metrics/'+k])
]));
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str=maxLength=>({type:'string',minLength:1,maxLength});
const ref={type:'string',enum:Object.keys(FACT_PATHS)};
const ev=obj({p:ref,n:str(80)});
export const WIRE_OUTPUT_SCHEMA_V4=obj({
 w:{type:'string',enum:[WIRE_VERSION]},c:str(80),h:str(64),d:{type:'string',enum:['PASS','VETO','ABSTAIN']},
 k:{type:'array',minItems:1,maxItems:8,items:obj({i:{type:'string',enum:[...FACTORS,'CURRENT_REACCELERATION']},v:{type:'string',enum:['SUPPORTED','CONTRADICTED','UNKNOWN']},e:{type:'array',maxItems:6,items:ref}})},
 s:{type:'array',maxItems:3,items:ev},o:{type:'array',maxItems:3,items:ev},
 m:{type:'array',maxItems:24,items:ref},n:str(120)
});
export function factTable(packet){
 const facts={};for(const [id,path] of Object.entries(FACT_PATHS)){
  const value=evidenceAt(packet,path);facts[id]={path,value:value.value,unit:value.unit};
 }
 return facts;
}
export function compactInputV4(packet){
 const input={...packet,evidence_refs:factTable(packet)};
 ensure(new TextEncoder().encode(JSON.stringify(input)).length<=LIMITS.inputBytes,'INPUT_TOO_LARGE');return input;
}
export function expandWireV4(wire,packet){
 validateShape(wire,WIRE_OUTPUT_SCHEMA_V4);
 const path=id=>{ensure(Object.hasOwn(FACT_PATHS,id),'EVIDENCE_REFERENCE_INVALID');const p=FACT_PATHS[id];evidenceAt(packet,p);return p;};
 const evidence=e=>{const p=path(e.p),fact=evidenceAt(packet,p);return {field_path:p,observed_value:fact.value,unit:fact.unit,interpretation:e.n};};
 return {candidate_id:wire.c,snapshot_hash:wire.h,decision:wire.d,
  assessment:{PASS:'SUPPORTED',VETO:'CONTRADICTED',ABSTAIN:'INSUFFICIENT_EVIDENCE'}[wire.d],
  checked_claims:wire.k.map(x=>({claim_id:x.i,verdict:x.v,evidence_paths:x.e.map(path)})),
  supporting_evidence:wire.s.map(evidence),opposing_evidence:wire.o.map(evidence),missing_fields:wire.m.map(path),summary:wire.n};
}
export function parseApiResponseV4(raw,packet){return expandWireV4(parseApiResponse(raw),packet);}

/* V5 transport (latency profile). Same verdict contract, candidate/snapshot echo and
 * server-side fact restoration as V4; it removes transport duplication only:
 *  - input: each fact is sent once as [value, unit, formula, missing_reason] instead of
 *    the metric object AND a second evidence_refs copy;
 *  - output: evidence is a bare fact ID list (no per-fact prose); one short summary.
 * Interpretation text in the canonical answer is a fixed server label, never a number
 * and never a correction of model output. */
export const WIRE_VERSION_V5='FACTREF5';
const refNow={type:'string',enum:Object.keys(FACT_PATHS).filter(id=>id.startsWith('C_'))};
const refOrig={type:'string',enum:Object.keys(FACT_PATHS).filter(id=>!id.startsWith('C_'))};
export const V5_SUPPORT_LABEL='모델이 선택한 지지 근거';
export const V5_OPPOSE_LABEL='모델이 선택한 반대 근거';
export const WIRE_OUTPUT_SCHEMA_V5=obj({
 w:{type:'string',enum:[WIRE_VERSION_V5]},c:str(80),h:str(64),d:{type:'string',enum:['PASS','VETO','ABSTAIN']},
 k:{type:'array',minItems:1,maxItems:8,items:obj({i:{type:'string',enum:[...FACTORS,'CURRENT_REACCELERATION']},v:{type:'string',enum:['SUPPORTED','CONTRADICTED','UNKNOWN']},e:{type:'array',maxItems:3,items:ref}})},
 // Evidence lists are split by source so the schema itself keeps current-market facts
 // (C_) and original-model facts (O_/F_) apart; the model cannot put one in the other.
 support_now:{type:'array',maxItems:3,items:refNow},support_orig:{type:'array',maxItems:3,items:refOrig},
 oppose_now:{type:'array',maxItems:3,items:refNow},oppose_orig:{type:'array',maxItems:3,items:refOrig},n:str(60)
});
export function compactInputV5(packet){
 const facts={};
 for(const [id,path] of Object.entries(FACT_PATHS)){const f=evidenceAt(packet,path);facts[id]=[f.value,f.unit,f.formula??null,f.missing_reason??null];}
 const bars=xs=>(xs??[]).map(b=>[b.open_offset_ms,b.open,b.high,b.low,b.close]);
 const o=packet.original_model,cur=packet.current_market;
 const input={w:WIRE_VERSION_V5,c:packet.candidate_id,h:packet.snapshot_hash,as_of_offset_ms:packet.as_of_offset_ms,
  original_model:{proposed_action:o.proposed_action,branch:o.branch,decision_basis:o.decision_basis,arithmetic_check:o.arithmetic_check,
   source_timing:o.source_timing,global_control:o.global_control},
  current_market:{quality:cur.quality,availability:cur.availability,microstructure_availability:cur.microstructure_availability??[],
   bars_1m:{columns:['open_offset_ms','open','high','low','close'],unit:'price_index_latest_close_100',rows:bars(cur.one_minute)},
   bars_5m:{columns:['open_offset_ms','open','high','low','close'],unit:'price_index_latest_close_100',rows:bars(cur.five_minute)}},
  facts:{columns:['value','unit','formula','missing_reason'],rows:facts}};
 ensure(new TextEncoder().encode(JSON.stringify(input)).length<=LIMITS.inputBytes,'INPUT_TOO_LARGE');return input;
}
/** Missing facts are a deterministic property of the immutable snapshot (value === null),
 * so V5 does not ask the model to enumerate them; the canonical answer lists none and data
 * completeness remains enforced by the server-side quality/arithmetic checks. */
export function expandWireV5(wire,packet){
 validateShape(wire,WIRE_OUTPUT_SCHEMA_V5);
 const path=id=>{ensure(Object.hasOwn(FACT_PATHS,id),'EVIDENCE_REFERENCE_INVALID');const p=FACT_PATHS[id];evidenceAt(packet,p);return p;};
 const evidence=label=>id=>{const p=path(id),fact=evidenceAt(packet,p);return {field_path:p,observed_value:fact.value,unit:fact.unit,interpretation:label};};
 return {candidate_id:wire.c,snapshot_hash:wire.h,decision:wire.d,
  assessment:{PASS:'SUPPORTED',VETO:'CONTRADICTED',ABSTAIN:'INSUFFICIENT_EVIDENCE'}[wire.d],
  checked_claims:wire.k.map(x=>({claim_id:x.i,verdict:x.v,evidence_paths:x.e.map(path)})),
  supporting_evidence:[...wire.support_now,...wire.support_orig].map(evidence(V5_SUPPORT_LABEL)),
  opposing_evidence:[...wire.oppose_now,...wire.oppose_orig].map(evidence(V5_OPPOSE_LABEL)),
  missing_fields:[],summary:wire.n};
}
/** Fixture encoder only. */
export function toWireV5(answer,packet){
 const w=toWireV4(answer,packet);
 return {w:WIRE_VERSION_V5,c:w.c,h:w.h,d:w.d,k:w.k.map(x=>({...x,e:x.e.slice(0,3)})),support_now:w.s.map(x=>x.p).filter(id=>id.startsWith('C_')),support_orig:w.s.map(x=>x.p).filter(id=>!id.startsWith('C_')),
  oppose_now:w.o.map(x=>x.p).filter(id=>id.startsWith('C_')),oppose_orig:w.o.map(x=>x.p).filter(id=>!id.startsWith('C_')),n:w.n.slice(0,60)};
}
export const WIRE_PROFILES=Object.freeze({
 V4:Object.freeze({schemaName:'entry_final_review_v4_factref',schema:WIRE_OUTPUT_SCHEMA_V4,input:compactInputV4,expand:expandWireV4}),
 V5:Object.freeze({schemaName:'entry_final_review_v5_factref',schema:WIRE_OUTPUT_SCHEMA_V5,input:compactInputV5,expand:expandWireV5})
});
const wireProfile=name=>{ensure(Object.hasOwn(WIRE_PROFILES,name),'API_PROFILE_UNKNOWN');return WIRE_PROFILES[name];};
export function wireSchema(name){return wireProfile(name).schema;}
export function wireInput(packet,name){return wireProfile(name).input(packet);}
export function parseApiResponseWire(raw,packet,name){return wireProfile(name).expand(parseApiResponse(raw),packet);}
/** Fixture encoder only. It refuses altered source values rather than repairing them. */
export function toWireV4(answer,packet){
 validateAnswer(answer,packet);
 const ids=Object.fromEntries(Object.entries(FACT_PATHS).map(([id,p])=>[p,id]));
 const ref=p=>{ensure(Object.hasOwn(ids,p),'EVIDENCE_REFERENCE_INVALID');return ids[p];};
 return {w:WIRE_VERSION,c:answer.candidate_id,h:answer.snapshot_hash,d:answer.decision,
  k:answer.checked_claims.map(x=>({i:x.claim_id,v:x.verdict,e:x.evidence_paths.map(ref)})),
  s:answer.supporting_evidence.map(e=>({p:ref(e.field_path),n:e.interpretation})),
  o:answer.opposing_evidence.map(e=>({p:ref(e.field_path),n:e.interpretation})),m:answer.missing_fields.map(ref),n:answer.summary};
}
