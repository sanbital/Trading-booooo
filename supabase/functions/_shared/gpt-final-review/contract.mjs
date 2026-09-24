/** Decision-only contract. Never receives an exchange client, account or DB secret. */
export const VERSION = 'GPT_FINAL_ENTRY_REVIEW_4_FACTREF';
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
    exit_policy:JSON.parse(JSON.stringify(f.exitPolicy??{})),
    // Present ONLY for candidates admitted by an alternative front-end policy (V30 shadow).
    // Production rows never carry v30Front, so their identity is byte-identical to before.
    ...(f.v30Front?{front_policy:frontPolicyIdentity(f.v30Front)}:{})};
}
/* V30 front-end score policy (SHADOW observation only, 2026-09-24).
 * B06133's two most stable factors on the production candidate stream (split-half
 * consistent, 2026-09-08..09-24) point the OPPOSITE way to its branches: recent
 * acceleration (fresh5over15=true) is the better side, extreme volume (volumeTails=true)
 * the worse. V30 admits on those two, keeps every other B06133 factor as reference,
 * and never rewrites the B06133 stamp: a candidate B06133 rejected stays rejected there. */
export const V30_FRONT_VERSION='V30_FRONT_SCORE_SHADOW_1';
export const V30_REQUIRED=Object.freeze({fresh5over15:true,volumeTails:false});
export function v30FrontDecision(b06133){
  const f=b06133?.factors??{},failed=[],unknown=[];
  for(const [k,want] of Object.entries(V30_REQUIRED)){const v=tri(f[k]);if(v===null)unknown.push(k);else if(v!==want)failed.push(k);}
  return {version:V30_FRONT_VERSION,required:{...V30_REQUIRED},factors:Object.fromEntries(FACTORS.map(k=>[k,tri(f[k])])),
    admitted:failed.length===0&&unknown.length===0,failed,unknown,
    b06133:{version:b06133?.version??null,allowed:b06133?.allowed===true,result:tri(b06133?.result),branch:b06133?.branch??null,reason:b06133?.reason??null}};
}
function frontPolicyIdentity(v){
  return {version:v.version??null,admitted:v.admitted===true,failed:[...(v.failed??[])],unknown:[...(v.unknown??[])],
    b06133_allowed:v.b06133?.allowed===true,b06133_reason:v.b06133?.reason??null};
}
/** Baseline for the V30 shadow: the SAME trigger and B06133 evidence, a different admission rule. */
export function baselineAllowedV30(s){
  const f=s?.features,b=f?.b06133,t=f?.v17Setup,v=f?.v30Front;
  if(!(s?.id&&s?.symbol&&t?.state&&Number.isSafeInteger(Number(t.triggerAt))&&Number(t.triggerAt)>0&&Number(t.triggerAt)%60000===0))return false;
  if(b?.version!=='B06133_ENTRY_SELECTION_1'||Number(b.source?.decisionAt)!==Number(t.triggerAt))return false;
  if(v?.version!==V30_FRONT_VERSION||v.admitted!==true)return false;
  // The stamp must be what the policy computes from the unmodified B06133 factors.
  const again=v30FrontDecision(b);
  return again.admitted===true&&JSON.stringify(again.factors)===JSON.stringify(v.factors)&&v.b06133?.allowed===(b.allowed===true);
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

/** Short transport keys and numeric evidence references only reduce serialization.
 * Expand back into the original strict contract before ANY verdict can be used. */
const refSchema={type:'integer',minimum:0,maximum:255};
const compactEvidence=obj({p:refSchema,v:{type:['number','boolean','null']},u:str(40),n:str(80)});
export const WIRE_OUTPUT_SCHEMA=obj({c:str(80),h:str(64),
  d:{type:'string',enum:['PASS','VETO','ABSTAIN']},
  a:{type:'string',enum:['SUPPORTED','CONTRADICTED','INSUFFICIENT_EVIDENCE']},
  k:{type:'array',minItems:1,maxItems:8,items:obj({i:{type:'string',enum:[...FACTORS,'CURRENT_REACCELERATION']},
    v:{type:'string',enum:['SUPPORTED','CONTRADICTED','UNKNOWN']},e:{type:'array',maxItems:6,items:refSchema}})},
  s:{type:'array',maxItems:3,items:compactEvidence},o:{type:'array',maxItems:3,items:compactEvidence},
  m:{type:'array',maxItems:24,items:refSchema},n:str(120)});
export function evidenceReferences(packet){
  const paths=[];
  for(const root of ['original_model/metrics','original_model/factors','current_market/metrics']){
    const [a,b]=root.split('/');
    for(const key of Object.keys(packet?.[a]?.[b]??{}).sort()){
      const path='/'+root+'/'+key;evidenceAt(packet,path);paths.push(path);
    }
  }
  ensure(paths.length>0&&paths.length<=256,'EVIDENCE_REFERENCE_COUNT');return paths;
}
export function compactInput(packet){
  const input={...packet,evidence_refs:evidenceReferences(packet)};
  ensure(new TextEncoder().encode(JSON.stringify(input)).length<=LIMITS.inputBytes,'INPUT_TOO_LARGE');return input;
}
export function toWireAnswer(answer,packet){
  const refs=evidenceReferences(packet),ref=p=>{const i=refs.indexOf(p);ensure(i>=0,'EVIDENCE_REFERENCE_UNKNOWN');return i;};
  const ev=e=>({p:ref(e.field_path),v:e.observed_value,u:e.unit,n:e.interpretation});
  return {c:answer.candidate_id,h:answer.snapshot_hash,d:answer.decision,a:answer.assessment,
    k:answer.checked_claims.map(c=>({i:c.claim_id,v:c.verdict,e:c.evidence_paths.map(ref)})),
    s:answer.supporting_evidence.map(ev),o:answer.opposing_evidence.map(ev),m:answer.missing_fields.map(ref),n:answer.summary};
}
export function expandWireAnswer(wire,packet){
  validateShape(wire,WIRE_OUTPUT_SCHEMA);const refs=evidenceReferences(packet);
  const path=i=>{ensure(Number.isSafeInteger(i)&&i>=0&&i<refs.length,'EVIDENCE_REFERENCE_INVALID');return refs[i];};
  const ev=e=>({field_path:path(e.p),observed_value:e.v,unit:e.u,interpretation:e.n});
  return {candidate_id:wire.c,snapshot_hash:wire.h,decision:wire.d,assessment:wire.a,
    checked_claims:wire.k.map(c=>({claim_id:c.i,verdict:c.v,evidence_paths:c.e.map(path)})),
    supporting_evidence:wire.s.map(ev),opposing_evidence:wire.o.map(ev),missing_fields:wire.m.map(path),summary:wire.n};
}

export function validateShape(v,s,p='$') {
  const ts=Array.isArray(s.type)?s.type:[s.type],t=v===null?'null':Array.isArray(v)?'array':typeof v;
  ensure(ts.includes(t)||(t==='number'&&ts.includes('integer')&&Number.isSafeInteger(v)),`TYPE:${p}`);
  if(t==='number'){ensure(v>=(s.minimum??-Infinity)&&v<=(s.maximum??Infinity),`NUMBER:${p}`);}
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
export function parseApiResponse(raw,packet=null) {
  ensure(raw?.status==='completed'&&!raw.error&&!raw.incomplete_details,'API_INCOMPLETE');
  const chunks=[];
  for(const m of raw.output??[]) {
    ensure(m.type==='message'||m.type==='reasoning','UNEXPECTED_API_TOOL');
    for(const c of m.content??[]){ensure(c.type!=='refusal','API_REFUSAL');if(c.type==='output_text')chunks.push(c.text);}
  }
  ensure(chunks.length===1,'API_OUTPUT_COUNT');const parsed=JSON.parse(chunks[0]);
  return packet?expandWireAnswer(parsed,packet):parsed;
}
export function validateAnswer(answer,packet) {
  if(answer?.review_contract===REVIEW_CONTRACT_V6)return validateAnswerV6(answer,packet);
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

/* ---------------------------------------------------------------------------
 * V6: REAL-TIME RISK REVIEW (role separation, 2026-09-24)
 *
 * Measured on production data (09-08..09-24): every V17 stage is decided by a
 * deterministic machine model (V17 selection + pullback/re-acceleration timing,
 * B06133 selection, CEC0040 causal edge). V4/V5 asked the LLM to re-audit those
 * same B06133 booleans before it was even allowed to PASS -- a fourth evaluation of
 * the same information -- and let it VETO on free-text readings of market numbers.
 * The one production VETO (NILUSDT 2026-09-23 23:32) cited "ask depth / 600 USDT
 * slot = 36x" as OPPOSING evidence, i.e. the direction of the ratio was misread.
 *
 * V6 gives the reviewer exactly one job: is there a NEW real-time execution risk,
 * visible in the seconds-old snapshot, that the machine models could not see?
 *  - It no longer re-verifies B06133/CEC/V17. Their decisions are context, not claims.
 *  - A VETO must name a risk category and cite a current-market fact that actually
 *    lies on the RISK SIDE of that category's published threshold (server-checked).
 *    "Already rose" / "volatile" is not a category, so it cannot be a VETO basis.
 *  - HARD risks and incomplete data are deterministic: PASS is impossible while one
 *    is active, whatever the model says. Nothing here can turn a machine REJECT into
 *    an entry; GPT only ever sees candidates the machine models already admitted.
 * ------------------------------------------------------------------------- */
export const REVIEW_CONTRACT_V6='REALTIME_RISK_V6';
const M='/current_market/metrics/';
/** Each rule: facts it may cite, a HARD band (deterministic block) and a SOFT band
 * (the reviewer may VETO; below it a VETO in this category is invalid). */
export const RISK_RULES=Object.freeze({
  SPREAD_ABNORMAL:Object.freeze({facts:['spread'],hard:m=>m.spread>25,soft:m=>m.spread>10,
    text:'spread bps: soft>10, hard>25 (executor order guard is 25)'}),
  THIN_ASK_LIQUIDITY:Object.freeze({facts:['ask_depth_to_slot_notional','depth'],hard:m=>m.ask_depth_to_slot_notional<1.5,soft:m=>m.ask_depth_to_slot_notional<5,
    text:'ask notional within 25bp / 600 USDT order: soft<5, hard<1.5 (HIGHER IS SAFER)'}),
  SELL_WALL_IMBALANCE:Object.freeze({facts:['book_imbalance_25bps','bid_depth_25bps'],hard:m=>m.book_imbalance_25bps<=-0.75,soft:m=>m.book_imbalance_25bps<=-0.45,
    text:'(bid-ask)/(bid+ask) within 25bp: soft<=-0.45, hard<=-0.75 (NEGATIVE = sellers dominate)'}),
  FUNDING_EXTREME:Object.freeze({facts:['funding'],hard:m=>m.funding>=0.003,soft:m=>m.funding>=0.0008,
    text:'funding per interval: soft>=0.0008, hard>=0.003 (crowded longs)'}),
  PREMIUM_EXTREME:Object.freeze({facts:['mark_index_premium'],hard:m=>Math.abs(m.mark_index_premium)>=0.01,soft:m=>Math.abs(m.mark_index_premium)>=0.004,
    text:'|mark/index-1|: soft>=0.004, hard>=0.01'}),
  OI_PRICE_DIVERGENCE:Object.freeze({facts:['oi_change_5m','return_5m','oi_change_60m'],hard:()=>false,
    soft:m=>Math.abs(m.oi_change_5m)>=0.02&&m.oi_change_5m*m.return_5m<0,
    text:'|OI 5m change|>=0.02 moving AGAINST the 5m price move (soft only)'}),
  PRICE_COLLAPSE:Object.freeze({facts:['distance_trigger_reference','last_close_change','last_body'],
    hard:m=>m.distance_trigger_reference<=-0.01||m.last_close_change<=-0.02,
    soft:m=>m.distance_trigger_reference<=0||m.last_close_change<=-0.006,
    text:'price vs original signal reference: soft<=0 (re-acceleration fully reversed), hard<=-0.01; or last 1m close change soft<=-0.006, hard<=-0.02'}),
});
export const RISK_CATEGORIES=Object.freeze([...Object.keys(RISK_RULES),'DATA_INCOMPLETE']);
const val=(packet,k)=>packet?.current_market?.metrics?.[k]?.value;
function metricsOf(packet){const m={};for(const r of Object.values(RISK_RULES))for(const k of r.facts)m[k]=val(packet,k);return m;}
const rule3=(fn,m)=>{try{const r=fn(m);return r===true;}catch{return false;}};
/** Deterministic, model-independent risk state of one immutable snapshot. */
export function riskAssessment(packet){
  const m=metricsOf(packet),q=packet?.current_market?.quality??{},out={};
  for(const [id,r] of Object.entries(RISK_RULES)){
    const missing=r.facts.slice(0,id==='OI_PRICE_DIVERGENCE'?2:1).some(k=>!finite(m[k]));
    out[id]={level:missing?'UNKNOWN':rule3(r.hard,m)?'HARD':rule3(r.soft,m)?'SOFT':'CLEAR',rule:r.text,facts:r.facts.map(k=>'C_'+k)};
  }
  const incomplete=q.complete!==true||q.microstructure_complete!==true;
  out.DATA_INCOMPLETE={level:incomplete?'HARD':'CLEAR',rule:'candles and seconds-old book/funding/OI must all be present',facts:[]};
  const hard=Object.entries(out).filter(([,x])=>x.level==='HARD').map(([k])=>k);
  return {flags:out,hard,soft:Object.entries(out).filter(([,x])=>x.level==='SOFT').map(([k])=>k)};
}
export function validateAnswerV6(answer,packet){
  ensure(answer&&answer.review_contract===REVIEW_CONTRACT_V6,'V6_CONTRACT');
  ensure(answer.candidate_id===packet.candidate_id&&answer.snapshot_hash===packet.snapshot_hash,'IDENTITY_MISMATCH');
  ensure(['PASS','VETO','ABSTAIN'].includes(answer.decision),'ENUM:decision');
  ensure(typeof answer.summary==='string'&&answer.summary.length>0&&!/[0-9]/.test(answer.summary),'NUMERICAL_SUMMARY');
  const risk=riskAssessment(packet);
  for(const e of [...answer.supporting_evidence,...answer.opposing_evidence]){
    ensure(e.field_path.startsWith(M),'EVIDENCE_NOT_CURRENT');const v=evidenceAt(packet,e.field_path);
    ensure(v.value===e.observed_value&&v.unit===e.unit,'EVIDENCE_VALUE_MISMATCH');
  }
  if(answer.decision==='PASS'){
    // Integrity of the stamped selector factors is a data check, not a judgment.
    ensure(packet.original_model.arithmetic_check.consistent,'ORIGINAL_CALCULATION_CONTRADICTED');
    ensure(risk.hard.length===0,'PASS_WITH_HARD_RISK:'+risk.hard.join(','));
    ensure(answer.risks.length===0,'PASS_WITH_NAMED_RISK');
    ensure(answer.supporting_evidence.some(e=>typeof e.observed_value==='number'),'PASS_REQUIRES_CURRENT_FACT');
  }
  if(answer.decision==='VETO'){
    ensure(answer.risks.length>0,'VETO_REQUIRES_RISK');
    for(const r of answer.risks){
      ensure(RISK_CATEGORIES.includes(r.risk_id),'ENUM:risk');
      const f=risk.flags[r.risk_id];
      // The category must actually be at risk in THIS snapshot; a misread direction
      // (e.g. deep ask liquidity cited as thin) is rejected here, not trusted.
      ensure(f.level==='SOFT'||f.level==='HARD','VETO_RISK_NOT_PRESENT:'+r.risk_id);
      if(r.risk_id!=='DATA_INCOMPLETE'){
        const allowed=RISK_RULES[r.risk_id].facts.map(k=>M+k);
        ensure(r.evidence.length>0&&r.evidence.every(e=>allowed.includes(e.field_path)),'VETO_EVIDENCE_OUTSIDE_RISK:'+r.risk_id);
        ensure(r.evidence.some(e=>typeof e.observed_value==='number'),'VETO_REQUIRES_FACT');
      }
    }
  }
  return answer;
}
