/** Evidence selection transport. The model chooses a named fact; source values are
 * attached locally, never generated, rounded, or corrected from model text.
 * The canonical validator still checks identity, freshness at the caller, claims,
 * numeric evidence requirements, completeness, and unsupported prose. */
import {FACTORS,LIMITS,ensure,evidenceAt,validateShape,parseApiResponse,validateAnswer} from './contract.mjs';
export const WIRE_VERSION='FACTREF4';
const original=['volumeRatio','return5m','return15m','return30m','return60m','btc_return30m','btc_return2h','source_buy_share_3m','source_price_change_3m','source_buy_share_first','source_buy_share_previous','source_buy_share_latest'];
const current=['return_5m','return_15m','return_30m','return_60m','volume_ratio_3m','taker_buy_ratio_3m','relative_strength_btc_15m','distance_recent_high_15m','distance_sma20','distance_trigger_reference','last_body','last_upper_wick','last_lower_wick','last_close_change','day_return','spread','depth','funding'];
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
