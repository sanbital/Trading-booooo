/** Decision-only contract. Never receives an exchange client, account or DB secret. */
export const VERSION = 'GPT_FINAL_ENTRY_REVIEW_2';
export const BASELINE_COMMIT = 'fea185c089932386d057a8abea14997007713b6d';
export const MODEL = 'gpt-5.4-mini-2026-03-17';
export const LIMITS = Object.freeze({requestMs:8000, executionReserveMs:3000,
  reviewMaxAgeMs:15000, inputBytes:60000, outputTokens:1800, bars1m:12, bars5m:12});
export const FACTORS = Object.freeze(['absorption','volumeTails','fresh15over30','btcAnyUp',
  'buyerShareRise','fresh5over15','recentHourLead']);
export function ensure(ok, reason) { if (!ok) throw Error(reason); }
export function canonical(x) {
  if (x === null || ['string','boolean'].includes(typeof x)) return JSON.stringify(x);
  if (typeof x === 'number') { ensure(Number.isFinite(x),'NONFINITE'); return JSON.stringify(x); }
  if (Array.isArray(x)) return '['+x.map(canonical).join(',')+']';
  ensure(x && typeof x==='object','NOT_JSON');
  return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
export async function hash(x) {
  const b=new TextEncoder().encode(typeof x==='string'?x:canonical(x));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export const finite = x => x!==null && x!==undefined && Number.isFinite(Number(x));
export const numberOrNull = x => finite(x)?Number(x):null;
const tri=x=>x===true||x===false?x:null;
export function metric(value,unit,formula,missingReason='NOT_AVAILABLE') {
  return {value:numberOrNull(value),unit,formula,missing_reason:finite(value)?null:missingReason};
}
export function baselineAllowed(s) {
  const f=s?.features,b=f?.b06133,c=f?.cec0040,t=f?.v17Setup;
  return !!(s?.id && s?.symbol && t?.state==='TRIGGERED' && Number.isSafeInteger(Number(t.triggerAt)) && Number(t.triggerAt)>0 && Number(t.triggerAt)%60000===0 &&
    b?.version==='B06133_ENTRY_SELECTION_1' && b.allowed===true && b.result===true &&
    ['R62','BUYER_SHARE_RESCUE','BOTH'].includes(b.branch) && Number(b.source?.decisionAt)===Number(t.triggerAt) &&
    c?.version==='CEC0040_CAUSAL_EDGE_CONTROLLER_1' && c.targetVersion==='CEC0040_P142_MEAN44_1' && c.ready===true && c.effectiveAllowed===true &&
    Number(c.decisionAt)===Number(t.triggerAt) && ['ADMIT','PROBE','REJECT'].includes(c.action) &&
    (c.enforcementEnabled!==true || ['ADMIT','PROBE'].includes(c.action)) && !['REJECTED','ORDERED'].includes(s.status));
}
/** Only immutable decision fields; never serialize all of features/metadata. */
export function decisionIdentity(s) {
  const f=s?.features??{},b=f.b06133??{},c=f.cec0040??{},t=f.v17Setup??{};
  const prebars=Array.isArray(b.source?.prebars)?b.source.prebars.slice(-3).map(x=>
    Object.fromEntries(['openTime','open','high','low','close','closeTime','quoteVolume','takerBuyQuote'].map(k=>[k,numberOrNull(x[k])]))):[];
  return {signal_id:String(s?.id??''),symbol:String(s?.symbol??'').toUpperCase(),
    trigger_at_ms:numberOrNull(t.triggerAt),reference_close:numberOrNull(f.referenceClose),
    setup_state:t.state??null,selector_version:b.version??null,selector_branch:b.branch??null,
    selector_allowed:b.allowed===true,selector_result:tri(b.result),
    factors:Object.fromEntries(FACTORS.map(k=>[k,tri(b.factors?.[k])])),
    metrics:Object.fromEntries(['volumeRatio','return5m','return15m','return30m','return60m'].map(k=>[k,numberOrNull(b.source?.featureValues?.[k])])),
    prebars,btc:Object.fromEntries(['return30m','return2h','freshnessMs'].map(k=>[k,numberOrNull(b.source?.btc?.[k])])),
    cec:{version:c.version??null,targetVersion:c.targetVersion??null,decisionAt:numberOrNull(c.decisionAt),
      action:c.action??null,ready:c.ready===true,effectiveAllowed:c.effectiveAllowed===true,enforcementEnabled:c.enforcementEnabled===true},
    // Bound locally to prevent changing exit rules after a review. Not sent to the LLM.
    exit_policy:JSON.parse(JSON.stringify(f.exitPolicy??{}))};
}
export function triggerExpiry(s){return Number(s.features.v17Setup.triggerAt)+60000;}
export function arithmeticCheck(identity) {
  const f=identity.metrics,b=identity.prebars,q=identity.btc;
  const expected={volumeTails:finite(f.volumeRatio)?f.volumeRatio<1||f.volumeRatio>=4:null,
    fresh15over30:finite(f.return15m)&&finite(f.return30m)?2*f.return15m>f.return30m:null,
    fresh5over15:finite(f.return5m)&&finite(f.return15m)?3*f.return5m>f.return15m:null,
    recentHourLead:finite(f.return15m)&&finite(f.return60m)&&f.return15m>-1?
      f.return15m>0&&f.return15m>((1+f.return60m)/(1+f.return15m)-1):null,
    btcAnyUp:finite(q.return30m)&&finite(q.return2h)&&finite(q.freshnessMs)&&q.freshnessMs>=0&&q.freshnessMs<900000?q.return30m>0||q.return2h>0:null,
    absorption:null,buyerShareRise:null};
  if(b.length===3 && b.every((x,i)=>[x.quoteVolume,x.takerBuyQuote,x.close,x.open,x.high,x.low].every(finite)&&x.quoteVolume>0 && x.takerBuyQuote>=0 && x.takerBuyQuote<=x.quoteVolume && x.close>0 && x.open>0 && x.high>=Math.max(x.close,x.open)&&x.low<=Math.min(x.close,x.open)&&x.low>0&&x.openTime===identity.trigger_at_ms-(3-i)*60000&&x.closeTime===x.openTime+59999)){
    const buy=b.reduce((s,x)=>s+x.takerBuyQuote,0),quote=b.reduce((s,x)=>s+x.quoteVolume,0),r=b.map(x=>x.takerBuyQuote/x.quoteVolume);
    expected.absorption=quote-buy>=buy && b[2].close>=b[0].open;
    expected.buyerShareRise=r[2]>r[0]&&r[2]>r[1];
  }
  const mismatches=FACTORS.filter(k=>expected[k]!==null && identity.factors[k]!==expected[k]);
  return {consistent:mismatches.length===0,mismatches,unknown_factors:FACTORS.filter(k=>expected[k]===null),expected};
}
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str=(max=200)=>({type:'string',minLength:1,maxLength:max});
const evidence=obj({field_path:str(180),observed_value:{type:['number','boolean','null']},unit:str(40),interpretation:str(180)});
export const OUTPUT_SCHEMA=obj({candidate_id:str(80),snapshot_hash:str(64),
  decision:{type:'string',enum:['PASS','VETO','ABSTAIN']},
  assessment:{type:'string',enum:['SUPPORTED','CONTRADICTED','INSUFFICIENT_EVIDENCE']},
  checked_claims:{type:'array',minItems:1,maxItems:8,items:obj({claim_id:{type:'string',enum:[...FACTORS,'CURRENT_REACCELERATION']},
    verdict:{type:'string',enum:['SUPPORTED','CONTRADICTED','UNKNOWN']},evidence_paths:{type:'array',maxItems:6,items:str(180)}})},
  supporting_evidence:{type:'array',maxItems:6,items:evidence},opposing_evidence:{type:'array',maxItems:6,items:evidence},
  missing_fields:{type:'array',maxItems:24,items:str(180)},summary:str(240)});
export function validateShape(v,s,p='$') {
  const ts=Array.isArray(s.type)?s.type:[s.type],t=v===null?'null':Array.isArray(v)?'array':typeof v;
  ensure(ts.includes(t),`TYPE:${p}`);
  if(s.enum)ensure(s.enum.includes(v),`ENUM:${p}`);
  if(t==='number')ensure(Number.isFinite(v),`NUMBER:${p}`);
  if(t==='string')ensure(v.length>=(s.minLength??0)&&v.length<=(s.maxLength??Infinity),`STRING:${p}`);
  if(t==='object'){
    ensure(Object.keys(v).every(k=>Object.hasOwn(s.properties,k)),`EXTRA:${p}`);
    for(const k of s.required)ensure(Object.hasOwn(v,k),`REQUIRED:${p}/${k}`);
    for(const k of Object.keys(v))validateShape(v[k],s.properties[k],p+'/'+k);
  }
  if(t==='array'){
    ensure(v.length>=(s.minItems??0)&&v.length<=(s.maxItems??Infinity),`ARRAY:${p}`);
    v.forEach((x,i)=>validateShape(x,s.items,p+'/'+i));
  }
}
export function evidenceAt(packet,path) {
  ensure(/^\/(current_market\/metrics|original_model\/metrics|original_model\/factors)\/[A-Za-z0-9_]+$/.test(path),'EVIDENCE_PATH');
  const parts=path.slice(1).split('/');let x=packet;
  for(const p of parts){ensure(Object.hasOwn(x,p),'EVIDENCE_MISSING');x=x[p];}
  ensure(x && Object.hasOwn(x,'value') && typeof x.unit==='string','EVIDENCE_NOT_METRIC');return x;
}
export function parseApiResponse(raw) {
  ensure(raw?.status==='completed'&&!raw.error&&!raw.incomplete_details,'API_INCOMPLETE');
  const chunks=[];
  for(const m of raw.output??[]) {
    ensure(m.type==='message'||m.type==='reasoning','UNEXPECTED_API_TOOL');
    for(const c of m.content??[]){ensure(c.type!=='refusal','API_REFUSAL');if(c.type==='output_text')chunks.push(c.text);}
  }
  ensure(chunks.length===1,'API_OUTPUT_COUNT');return JSON.parse(chunks[0]);
}
export function validateAnswer(answer,packet) {
  validateShape(answer,OUTPUT_SCHEMA);
  ensure(answer.candidate_id===packet.candidate_id && answer.snapshot_hash===packet.snapshot_hash,'IDENTITY_MISMATCH');
  ensure(new Set(answer.checked_claims.map(x=>x.claim_id)).size===answer.checked_claims.length,'DUPLICATE_CLAIM');
  for(const e of [...answer.supporting_evidence,...answer.opposing_evidence]){
    const v=evidenceAt(packet,e.field_path);
    ensure(v.value===e.observed_value && v.unit===e.unit,'EVIDENCE_VALUE_MISMATCH');
    // All numeric observations belong in typed evidence, not invented prose.
    ensure(!/[0-9]/.test(e.interpretation),'NUMERICAL_PROSE');
  }
  ensure(!/[0-9]/.test(answer.summary),'NUMERICAL_SUMMARY');
  for(const c of answer.checked_claims)for(const p of c.evidence_paths)evidenceAt(packet,p);
  for(const p of answer.missing_fields)ensure(evidenceAt(packet,p).value===null,'FALSE_MISSING');
  const pairs={PASS:'SUPPORTED',VETO:'CONTRADICTED',ABSTAIN:'INSUFFICIENT_EVIDENCE'};
  ensure(pairs[answer.decision]===answer.assessment,'ASSESSMENT_CONFLICT');
  if(answer.decision==='PASS'){
    ensure(packet.original_model.arithmetic_check.consistent,'ORIGINAL_CALCULATION_CONTRADICTED');
    ensure(packet.current_market.quality.complete===true,'CURRENT_INPUT_INCOMPLETE');
    const numeric=answer.supporting_evidence.filter(e=>typeof e.observed_value==='number');
    ensure(new Set(numeric.map(e=>e.field_path)).size>=2,'PASS_REQUIRES_TWO_FACTS');
    ensure(numeric.some(e=>e.field_path.startsWith('/current_market/')),'PASS_CANNOT_ECHO_MODEL');
    ensure(answer.checked_claims.some(c=>c.claim_id==='CURRENT_REACCELERATION' && c.verdict==='SUPPORTED' && c.evidence_paths.some(p=>p.startsWith('/current_market/'))),'CURRENT_CLAIM_REQUIRED');
    ensure(answer.checked_claims.every(c=>c.verdict!=='CONTRADICTED'),'PASS_CLAIM_CONTRADICTION');
    const branch=packet.original_model.branch;
    const required=branch==='R62'?['absorption','volumeTails','fresh15over30','btcAnyUp']:
      branch==='BUYER_SHARE_RESCUE'?['buyerShareRise','fresh5over15','recentHourLead']:FACTORS;
    ensure(required.every(id=>!packet.original_model.arithmetic_check.unknown_factors.includes(id)),'ORIGINAL_FACTS_INCOMPLETE');
    for(const id of required)ensure(answer.checked_claims.some(c=>c.claim_id===id&&c.verdict==='SUPPORTED'&&
      c.evidence_paths.some(p=>p.startsWith('/original_model/metrics/')&&evidenceAt(packet,p).value!==null)),
      'ORIGINAL_CLAIM_RECHECK_REQUIRED');
  }
  if(answer.decision==='VETO')ensure(answer.opposing_evidence.some(e=>e.observed_value!==null),'VETO_REQUIRES_FACT');
  return answer;
}
