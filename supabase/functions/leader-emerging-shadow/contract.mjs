/** LE-SHADOW-1 GPT ALT1 contract: BUY / WAIT / SKIP / ABSTAIN.
 *
 * Differences from production FD1 (deliberate, see the audit F8):
 *   - SKIP and WAIT are ALWAYS in the schema enum. SKIP is never removed because no risk
 *     category fired: NO_EDGE_OVER_COST is always citable.
 *   - SOFT categories (VOLUME_OVERHEATED, EXTENDED_LEADER, RANK_FADING, COST_EXCEEDS_EDGE) may be
 *     cited only while the server computed them true (band check); they are evidence, not blocks.
 *   - WAIT names exactly one enumerated trigger with a server-range-checked parameter; the TTL is
 *     fixed at 10 minutes, at most one re-ask follows, and the re-ask cannot answer WAIT.
 *   - BUY must state expected_move_bps above the explicit breakeven cost.
 * Anything invalid is ABSTAIN. There is no retry. */
export const ALT1_VERSION='LE_GPT_ALT1_1';
export const MODEL='gpt-5.4-mini-2026-03-17';
export const REQUEST_MS=8000;
export const DECISIONS=Object.freeze(['BUY','WAIT','SKIP','ABSTAIN']);
export const RECHECK_DECISIONS=Object.freeze(['BUY','SKIP','ABSTAIN']);
export const SOFT=Object.freeze(['VOLUME_OVERHEATED','EXTENDED_LEADER','RANK_FADING','COST_EXCEEDS_EDGE']);
export const ALWAYS_SKIP_REASON='NO_EDGE_OVER_COST';
export const SKIP_REASONS=Object.freeze([...SOFT,ALWAYS_SKIP_REASON]);
export const WAIT_TTL_MS=10*60_000;
export const WAIT_TRIGGERS=Object.freeze({
  PULLBACK_HOLD:{param:[15,60]},
  BREAKOUT_CONFIRM:{param:[10,50]},
  SPREAD_NORMALIZE:{param:null},
  BOOK_IMPROVE:{param:null},
  FLOW_TURN:{param:null},
  RANK_CONFIRM:{param:null},
});
export const WAIT_TRIGGER_IDS=Object.freeze(Object.keys(WAIT_TRIGGERS));
export const WAIT_INVALIDATION=Object.freeze({priceBand:.01,rankDrop:10});

const str=n=>({type:'string',maxLength:n});
/** Strict JSON schema. `recheck` removes WAIT only (WAIT -> WAIT is impossible); SKIP stays. */
export function wireSchema({recheck=false,factKeys=[]}={}){
  const ev={type:'array',maxItems:6,items:factKeys.length?{type:'string',enum:[...factKeys]}:str(60)};
  return {type:'object',additionalProperties:false,required:['d','reasons','support','expected_move_bps','wait','n'],properties:{
    d:{type:'string',enum:[...(recheck?RECHECK_DECISIONS:DECISIONS)]},
    reasons:{type:'array',maxItems:4,items:{type:'object',additionalProperties:false,required:['c','e'],properties:{
      c:{type:'string',enum:[...SKIP_REASONS]},e:ev}}},
    support:{...ev},
    expected_move_bps:{type:['number','null']},
    wait:{type:'object',additionalProperties:false,required:['trigger','param'],properties:{
      trigger:{type:'string',enum:['NONE',...(recheck?[]:WAIT_TRIGGER_IDS)]},param:{type:['number','null']}}},
    n:str(200)}};
}

function shape(v,s,p='$'){
  const types=Array.isArray(s.type)?s.type:[s.type];
  const is=(t)=>t==='null'?v===null:t==='array'?Array.isArray(v):t==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v)
    :t==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===t;
  if(!types.some(is))throw Error('TYPE:'+p);
  if(s.enum&&!s.enum.includes(v))throw Error('ENUM:'+p);
  if(typeof v==='string'&&s.maxLength&&v.length>s.maxLength)throw Error('STRING:'+p);
  if(Array.isArray(v)){if(s.maxItems!==undefined&&v.length>s.maxItems)throw Error('ARRAY:'+p);v.forEach((x,i)=>shape(x,s.items,p+'['+i+']'));}
  else if(v&&typeof v==='object'){
    for(const k of s.required??[])if(!Object.hasOwn(v,k))throw Error('REQUIRED:'+p+'.'+k);
    for(const k of Object.keys(v))if(!s.properties?.[k])throw Error('EXTRA:'+p+'.'+k);
    for(const [k,x] of Object.entries(v))shape(x,s.properties[k],p+'.'+k);
  }
}

/**
 * Server validation of one wire answer against the packet it was asked on.
 * @returns {{decision, valid:true, reasons, support, expected_move_bps, wait}} or throws.
 */
export function validateAnswer(wire,packet){
  const recheck=packet.attempt===2;
  const keys=Object.keys(packet.facts??{}).filter(k=>packet.facts[k]!==null);
  shape(wire,wireSchema({recheck,factKeys:[]}));
  const known=new Set(keys),cite=e=>e.filter(k=>known.has(k));
  const reasons=wire.reasons.map(r=>({c:r.c,e:cite(r.e)}));
  const support=cite(wire.support);
  if(wire.d==='SKIP'){
    if(!reasons.length)throw Error('ALT_SKIP_NEEDS_REASON');
    for(const r of reasons){
      if(r.c!==ALWAYS_SKIP_REASON&&packet.soft?.[r.c]!==true)throw Error('ALT_SOFT_NOT_ACTIVE:'+r.c);
      if(!r.e.length)throw Error('ALT_REASON_NEEDS_FACT:'+r.c);
    }
  }
  if(wire.d==='BUY'){
    if(support.length<2)throw Error('ALT_BUY_NEEDS_TWO_FACTS');
    const be=Number(packet.cost?.breakeven_bps);
    if(!(Number.isFinite(wire.expected_move_bps)&&Number.isFinite(be)&&wire.expected_move_bps>be))throw Error('ALT_BUY_BELOW_BREAKEVEN');
  }
  let wait=null;
  if(wire.d==='WAIT'){
    if(recheck)throw Error('ALT_WAIT_AFTER_WAIT');
    const t=WAIT_TRIGGERS[wire.wait.trigger];
    if(!t)throw Error('ALT_WAIT_TRIGGER');
    if(t.param){const [lo,hi]=t.param;if(!(Number.isFinite(wire.wait.param)&&wire.wait.param>=lo&&wire.wait.param<=hi))throw Error('ALT_WAIT_PARAM_RANGE');}
    else if(wire.wait.param!==null)throw Error('ALT_WAIT_PARAM_FORBIDDEN');
    wait={trigger:wire.wait.trigger,param:wire.wait.param,ttl_ms:WAIT_TTL_MS};
  }else if(wire.wait.trigger!=='NONE')throw Error('ALT_WAIT_TRIGGER_WITHOUT_WAIT');
  return {decision:wire.d,valid:true,reasons,support,expected_move_bps:wire.expected_move_bps,wait,note:wire.n};
}
