/** LE-SHADOW-2 ALT GPT contract (ALT_GPT_V2). The question is NOT "is it strong?" (every candidate
 * already is) but "early/mid continuation, or the last acceleration / blow-off?".
 *
 * Server-enforced (anything invalid => ABSTAIN, no retry):
 *   - BUY needs phase EARLY_CONTINUATION or MID_CONTINUATION, overheat_view != OVERHEATED,
 *     expected_move_bps > cost.breakeven_bps, >= 2 cited facts of which >= 1 is NOT a pure
 *     strength fact (returns / day return / rank / relative strength): STRONG != BUY.
 *   - BUY while an advisory model is negative (CEC0040 REJECT, B06133 not allowed, V30 not
 *     admitted) needs override.model naming it and an enumerated override.code with >= 2 cited
 *     facts. "The trend is strong" is not an override code.
 *   - WAIT needs wait.reason, one recheck trigger (param range-checked) and ttl_min in [5, 15].
 *     A WAIT always ends in BUY / SKIP / ABSTAIN: trigger => one GPT re-ask (no WAIT allowed),
 *     TTL or invalidation => deterministic SKIP. Time passing alone never makes a BUY.
 *   - SKIP needs >= 1 reason code with >= 1 cited fact. */
export const ALT2_VERSION='LE_GPT_ALT2_2_MARKET_CONTEXT';
export const MODEL='gpt-5.4-mini-2026-03-17';
export const REQUEST_MS=9000;
export const DECISIONS=Object.freeze(['BUY','WAIT','SKIP','ABSTAIN']);
export const RECHECK_DECISIONS=Object.freeze(['BUY','SKIP','ABSTAIN']);
export const PHASES=Object.freeze(['EARLY_CONTINUATION','MID_CONTINUATION','LATE_ACCELERATION','BLOWOFF_EXHAUSTION','FADING','UNCLEAR']);
export const BUY_PHASES=Object.freeze(['EARLY_CONTINUATION','MID_CONTINUATION']);
export const OVERHEAT_VIEWS=Object.freeze(['NOT_OVERHEATED','OVERHEAT_RISK_ACCEPTABLE','OVERHEATED']);
export const SKIP_REASONS=Object.freeze(['LATE_ACCELERATION','BLOWOFF_VOLUME','EXTREME_RANK_CHASE','ABSORPTION_DISTRIBUTION','FAILED_HIGH',
  'OI_PRICE_DIVERGENCE','EXECUTION_COST','THIN_BOOK','WEAK_FLOW','FADING_STRUCTURE','LEGACY_NEGATIVE_UNRESOLVED','NO_EDGE_OVER_COST']);
export const WAIT_REASONS=Object.freeze(['POST_SPIKE_COOLDOWN','SPREAD_WIDE','ASK_WALL','SLIPPAGE_HIGH','FLOW_UNSTABLE','PULLBACK_NEEDED',
  'BREAKOUT_UNCONFIRMED','VOLUME_BLOWOFF_RISK','RANK_OVERHEAT','OI_UNCONFIRMED']);
/** recheck triggers; param = null or [lo, hi] */
export const TRIGGERS=Object.freeze({
  SPREAD_IMPROVE:{param:null},        // spread <= min(8 bps, initial/2)
  SLIPPAGE_DROP:{param:null},         // est. slippage <= max(3, initial * 0.6)
  ASK_DEPTH_IMPROVE:{param:null},     // ask_depth_to_order >= max(5, initial*1.5) and max_ask_wall_to_order < 10
  BID_SUPPORT_UP:{param:null},        // book_imbalance_25bps >= max(0.1, initial + 0.2)
  TAKER_BUY_RETURN:{param:null},      // last 3 completed 1m taker-buy share >= 0.55 and 3m return > 0
  PULLBACK_REACCEL:{param:[15,80]},   // low touched mid*(1-param bps), then a completed 1m close back above mid
  NEW_HIGH_BREAK:{param:[5,50]},      // completed 1m close > max(60m high, mid*(1+param bps)) with taker-buy > 0.5
  RANK_HOLD:{param:null},             // next 5m rank snapshot: rank held or improved
  OI_CONFIRM:{param:null},            // next 5m OI bucket up while price >= snapshot mid
});
export const TRIGGER_IDS=Object.freeze(Object.keys(TRIGGERS));
export const TTL_MIN=Object.freeze([5,15]);
export const WAIT_INVALIDATION=Object.freeze({priceDown:.012,priceUp:.02,rankDrop:10});
export const OVERRIDE_MODELS=Object.freeze(['NONE','CEC0040','B06133','V30','MULTIPLE']);
export const OVERRIDE_CODES=Object.freeze(['NONE','NEGATIVE_EVIDENCE_RESOLVED_IN_SNAPSHOT','ORDER_BOOK_IMPROVED','PULLBACK_REACCEL_CONFIRMED',
  'TAKER_FLOW_RECOVERED','OI_STRUCTURE_IMPROVED']);
/** facts that only restate strength; a BUY must cite at least one fact outside this set */
export const STRENGTH_ONLY=Object.freeze(new Set(['return_1m','return_5m','return_15m','return_30m','return_60m','return_4h','day_return',
  'signal_rank','relative_strength_15m','relative_strength_60m']));

const str=x=>({type:'string',maxLength:x});
/** strict number: null / undefined / '' are unknown (Number(null) would be 0) */
const strictNum=x=>typeof x==='number'?(Number.isFinite(x)?x:null):typeof x==='string'&&x.trim()!==''&&Number.isFinite(Number(x))?Number(x):null;
export function wireSchema({recheck=false}={}){
  const keys={type:'array',maxItems:6,items:str(40)};
  return {type:'object',additionalProperties:false,required:['d','phase','overheat_view','reasons','support','expected_move_bps','override','wait','n'],properties:{
    d:{type:'string',enum:[...(recheck?RECHECK_DECISIONS:DECISIONS)]},
    phase:{type:'string',enum:[...PHASES]},
    overheat_view:{type:'string',enum:[...OVERHEAT_VIEWS]},
    reasons:{type:'array',maxItems:4,items:{type:'object',additionalProperties:false,required:['c','e'],properties:{c:{type:'string',enum:[...SKIP_REASONS]},e:keys}}},
    support:keys,
    expected_move_bps:{type:['number','null']},
    override:{type:'object',additionalProperties:false,required:['model','code','e'],properties:{
      model:{type:'string',enum:[...OVERRIDE_MODELS]},code:{type:'string',enum:[...OVERRIDE_CODES]},e:keys}},
    wait:{type:'object',additionalProperties:false,required:['reason','trigger','param','ttl_min'],properties:{
      reason:{type:'string',enum:['NONE',...(recheck?[]:WAIT_REASONS)]},
      trigger:{type:'string',enum:['NONE',...(recheck?[]:TRIGGER_IDS)]},
      param:{type:['number','null']},ttl_min:{type:['number','null']}}},
    n:str(240)}};
}

function shape(v,s,p='$'){
  const types=Array.isArray(s.type)?s.type:[s.type];
  const is=t=>t==='null'?v===null:t==='array'?Array.isArray(v):t==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v)
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

/** Advisory models that are negative in this packet (the override obligation). */
export function legacyNegatives(legacy){
  const out=[];
  if(legacy?.cec0040?.action==='REJECT')out.push('CEC0040');
  if(legacy?.b06133&&legacy.b06133.allowed===false)out.push('B06133');
  if(legacy?.v30&&legacy.v30.admitted===false)out.push('V30');
  return out;
}

/** Server validation of one wire answer against the packet it answered. Throws on violation. */
export function validateAnswer(wire,packet){
  const recheck=packet.attempt===2;
  shape(wire,wireSchema({recheck}));
  const known=new Set(Object.keys(packet.facts??{}).filter(k=>packet.facts[k]!==null&&packet.facts[k]!==undefined));
  const cite=e=>[...new Set(e)].filter(k=>known.has(k));
  const reasons=wire.reasons.map(r=>({c:r.c,e:cite(r.e)}));
  const support=cite(wire.support);
  const override={model:wire.override.model,code:wire.override.code,e:cite(wire.override.e)};
  const negatives=legacyNegatives(packet.legacy);
  if(wire.d==='BUY'){
    if(!BUY_PHASES.includes(wire.phase))throw Error('ALT2_BUY_PHASE:'+wire.phase);
    if(wire.overheat_view==='OVERHEATED')throw Error('ALT2_BUY_OVERHEATED');
    if(support.length<2)throw Error('ALT2_BUY_NEEDS_TWO_FACTS');
    if(!support.some(k=>!STRENGTH_ONLY.has(k)))throw Error('ALT2_BUY_STRENGTH_ONLY');
    if(Array.isArray(packet.hard_safety)&&packet.hard_safety.length)throw Error('ALT2_BUY_HARD_SAFETY');
    const be=strictNum(packet.cost?.breakeven_bps);
    if(!(Number.isFinite(wire.expected_move_bps)&&be!==null&&wire.expected_move_bps>be))throw Error('ALT2_BUY_BELOW_BREAKEVEN');
    if(negatives.length){
      const want=negatives.length>1?'MULTIPLE':negatives[0];
      if(override.model!==want)throw Error('ALT2_OVERRIDE_MODEL:'+want);
      if(override.code==='NONE')throw Error('ALT2_OVERRIDE_CODE_REQUIRED');
      if(override.e.length<2)throw Error('ALT2_OVERRIDE_NEEDS_TWO_FACTS');
    }
  }else if(override.code!=='NONE'||override.model!=='NONE')throw Error('ALT2_OVERRIDE_WITHOUT_BUY');
  if(wire.d==='SKIP'){
    if(!reasons.length)throw Error('ALT2_SKIP_NEEDS_REASON');
    for(const r of reasons)if(!r.e.length)throw Error('ALT2_REASON_NEEDS_FACT:'+r.c);
  }
  let wait=null;
  if(wire.d==='WAIT'){
    if(recheck)throw Error('ALT2_WAIT_AFTER_WAIT');
    const t=TRIGGERS[wire.wait.trigger];
    if(!t)throw Error('ALT2_WAIT_TRIGGER');
    if(wire.wait.reason==='NONE')throw Error('ALT2_WAIT_REASON');
    if(t.param){const [lo,hi]=t.param;if(!(Number.isFinite(wire.wait.param)&&wire.wait.param>=lo&&wire.wait.param<=hi))throw Error('ALT2_WAIT_PARAM_RANGE');}
    else if(wire.wait.param!==null)throw Error('ALT2_WAIT_PARAM_FORBIDDEN');
    const ttl=wire.wait.ttl_min;
    if(!(Number.isFinite(ttl)&&ttl>=TTL_MIN[0]&&ttl<=TTL_MIN[1]))throw Error('ALT2_WAIT_TTL_RANGE');
    if(wire.wait.trigger==='RANK_HOLD'&&strictNum(packet.rank_context?.rank)===null)throw Error('ALT2_WAIT_RANK_UNKNOWN');
    wait={reason:wire.wait.reason,trigger:wire.wait.trigger,param:wire.wait.param,ttl_min:Math.round(ttl)};
  }else if(wire.wait.trigger!=='NONE'||wire.wait.reason!=='NONE')throw Error('ALT2_WAIT_FIELDS_WITHOUT_WAIT');
  return {decision:wire.d,valid:true,phase:wire.phase,overheat_view:wire.overheat_view,reasons,support,
    expected_move_bps:wire.expected_move_bps,override:wire.d==='BUY'&&negatives.length?override:null,legacy_negatives:negatives,wait,note:wire.n};
}
