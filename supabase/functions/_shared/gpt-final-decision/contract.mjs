/** GPT FINAL DECISION (FD1) contract: ENTRY (BUY/SKIP/ABSTAIN) and HOLD (HOLD/EXIT/ABSTAIN).
 *
 * GPT is the final trading judgment; this file is the server-side boundary around it.
 *  - Every reason GPT gives must be a published category whose deterministic band is
 *    actually breached in THIS snapshot, citing only that category's facts. "Already rose",
 *    "volatile", "near a high" and "held a long time" are not categories, so they can never
 *    be a SKIP or EXIT reason.
 *  - BUY / HOLD must cite current facts that actually point up (server-checked direction).
 *  - HARD bands are deterministic: BUY/HOLD is invalid while one is active. An invalid or
 *    missing answer is ABSTAIN: no entry; for a position the deterministic exit engine rules.
 *  - GPT never sees or controls sizing, leverage, slots, the native stop or order safety. */
import {FACT_DEFS,FACT_KEYS,MICRO_KEYS,POSITION_KEYS,HISTORY_KEYS} from './facts.mjs';
import {fatigueAxes,FATIGUE_AXES,FATIGUE_FACTS} from './assessment.mjs';
export const FD_VERSION='GPT_FINAL_DECISION_FD1';
export const CONTRACT_VERSION='FD1_CONTRACT_JUDGMENT_1';
export const ENTRY_TASK='ENTRY',HOLD_TASK='HOLD';
export const DECISIONS=Object.freeze({ENTRY:['BUY','SKIP','ABSTAIN'],HOLD:['HOLD','PROTECT','EXIT','ABSTAIN']});
const f=(m,k)=>m[k];
const has=(m,...ks)=>ks.every(k=>m[k]!==null&&m[k]!==undefined&&Number.isFinite(m[k]));
/** SETUP_POLICY.maxChasePct of leader-pullback-reaccel.mjs (pinned equal by a test). */
export const CHASE_CEILING=0.01;
/** Categories: facts GPT may cite, SOFT band (reason valid), HARD band (deterministic block). */
export const CATEGORIES=Object.freeze({
  MOMENTUM_FADED:{tasks:['ENTRY','HOLD'],facts:['return_5m','return_15m','accel_5m_vs_15m','return_1m'],need:['return_5m','return_15m'],
    soft:m=>f(m,'return_5m')<=0&&f(m,'return_15m')<=0,hard:()=>false,text:'return_5m<=0 AND return_15m<=0'},
  SELL_DOMINANCE:{tasks:['ENTRY','HOLD'],facts:['taker_buy_ratio_5m','taker_buy_ratio_15m','buyer_share_change'],need:['taker_buy_ratio_5m'],
    soft:m=>f(m,'taker_buy_ratio_5m')<=0.44||(has(m,'buyer_share_change')&&f(m,'buyer_share_change')<=-0.08),hard:()=>false,
    text:'taker_buy_ratio_5m<=0.44 OR buyer_share_change<=-0.08'},
  PUMP_REVERSAL:{tasks:['ENTRY','HOLD'],facts:['distance_high_60m','last_upper_wick','return_5m','minutes_since_high_60m'],need:['distance_high_60m','return_5m'],
    soft:m=>(f(m,'distance_high_60m')<=-0.04&&f(m,'return_5m')<0)||(has(m,'last_upper_wick')&&f(m,'last_upper_wick')>=0.012),hard:()=>false,
    text:'(distance_high_60m<=-0.04 AND return_5m<0) OR last_upper_wick>=0.012'},
  SIGNAL_INVALIDATED:{tasks:['ENTRY'],facts:['distance_trigger_reference','return_1m'],need:['distance_trigger_reference'],
    soft:m=>f(m,'distance_trigger_reference')<=0||(has(m,'return_1m')&&f(m,'return_1m')<=-0.006),
    hard:m=>f(m,'distance_trigger_reference')<=-0.01||(has(m,'return_1m')&&f(m,'return_1m')<=-0.02),
    text:'soft: distance_trigger_reference<=0 OR return_1m<=-0.006; HARD: <=-0.01 OR return_1m<=-0.02'},
  TREND_BREAK:{tasks:['HOLD'],facts:['position_drawdown_from_peak','distance_sma20','distance_low_15m','return_15m'],need:['position_drawdown_from_peak','distance_sma20'],
    soft:m=>f(m,'position_drawdown_from_peak')<=-0.015||f(m,'distance_sma20')<=-0.006,hard:()=>false,
    text:'position_drawdown_from_peak<=-0.015 OR distance_sma20<=-0.006'},
  OI_PRICE_DIVERGENCE:{tasks:['ENTRY','HOLD'],facts:['oi_change_5m','return_5m','oi_change_60m'],need:['oi_change_5m','return_5m'],
    soft:m=>Math.abs(f(m,'oi_change_5m'))>=0.02&&f(m,'oi_change_5m')*f(m,'return_5m')<0,hard:()=>false,
    text:'|oi_change_5m|>=0.02 moving against return_5m'},
  FUNDING_EXTREME:{tasks:['ENTRY','HOLD'],facts:['funding_rate'],need:['funding_rate'],
    soft:m=>f(m,'funding_rate')>=0.0008,hard:m=>f(m,'funding_rate')>=0.003,text:'soft>=0.0008, HARD>=0.003'},
  PREMIUM_EXTREME:{tasks:['ENTRY','HOLD'],facts:['premium_index'],need:['premium_index'],
    soft:m=>Math.abs(f(m,'premium_index'))>=0.004,hard:m=>Math.abs(f(m,'premium_index'))>=0.01,text:'|premium_index| soft>=0.004, HARD>=0.01'},
  BTC_DUMP:{tasks:['ENTRY','HOLD'],facts:['btc_return_15m','btc_return_60m'],need:['btc_return_15m'],
    soft:m=>f(m,'btc_return_15m')<=-0.006||(has(m,'btc_return_60m')&&f(m,'btc_return_60m')<=-0.012),hard:()=>false,
    text:'btc_return_15m<=-0.006 OR btc_return_60m<=-0.012'},
  SPREAD_ABNORMAL:{tasks:['ENTRY','HOLD'],facts:['spread_bps'],need:['spread_bps'],
    soft:m=>f(m,'spread_bps')>10,hard:m=>f(m,'spread_bps')>25,text:'soft>10 bps, HARD>25 bps'},
  THIN_LIQUIDITY:{tasks:['ENTRY','HOLD'],facts:['ask_depth_to_order','bid_depth_to_order','ask_depth_25bps_usdt','bid_depth_25bps_usdt'],need:['ask_depth_to_order','bid_depth_to_order'],
    soft:m=>f(m,'ask_depth_to_order')<5||f(m,'bid_depth_to_order')<3,hard:m=>f(m,'ask_depth_to_order')<1.5||f(m,'bid_depth_to_order')<1,
    text:'soft: ask_depth_to_order<5 OR bid_depth_to_order<3; HARD: ask<1.5 OR bid<1 (HIGHER IS SAFER)'},
  SELL_WALL:{tasks:['ENTRY','HOLD'],facts:['book_imbalance_25bps','max_ask_wall_to_order'],need:['book_imbalance_25bps'],
    // A single large ask level is normal on liquid symbols (SOL: >1000x a 600 USDT order), so
    // the band is the V6-validated net imbalance only; the wall size stays citable context.
    soft:m=>f(m,'book_imbalance_25bps')<=-0.45,hard:m=>f(m,'book_imbalance_25bps')<=-0.75,
    text:'soft: book_imbalance_25bps<=-0.45; HARD: <=-0.75 (NEGATIVE = sellers dominate)'},
  FILL_WORSE:{tasks:['ENTRY'],facts:['est_buy_slippage_bps'],need:['est_buy_slippage_bps'],
    soft:m=>f(m,'est_buy_slippage_bps')>=8,hard:m=>f(m,'est_buy_slippage_bps')>=25,text:'soft>=8 bps, HARD>=25 bps'},
  // Late entry (2026-09-25). The V17 setup buys within its 1% chase ceiling of the signal
  // reference (SETUP_POLICY.maxChasePct); above it the reference-anchored stop geometry is
  // worse. A LIVE_MOMENTUM_CHASE candidate is above it by construction, so GPT may always
  // SKIP a chase for lateness while BUY stays possible. It applies only to a packet that
  // carries chase context (when:), so an ordinary trigger's categories are unchanged, and
  // recheck:false keeps the protected FINAL RECHECK category set unchanged.
  CHASE_EXTENDED:{tasks:['ENTRY'],recheck:false,when:p=>!!p?.chase,facts:['distance_trigger_reference','distance_high_60m','return_5m'],need:['distance_trigger_reference'],
    soft:m=>f(m,'distance_trigger_reference')>CHASE_CEILING,hard:()=>false,text:'distance_trigger_reference>0.01 (above the V17 1% chase ceiling)'},
  // (2026-09-26) Propulsion fading while the trend still looks strong: two or more of the
  // independent fatigue axes of assessment.mjs weak at once. SOFT only (a legitimate SKIP
  // reason GPT may cite, never a block): in replay no axis combination lowered per-trade
  // expected value by itself, so it must be weighed, not obeyed. Applies to the FINAL
  // RECHECK too (current facts), where it names propulsion deterioration since the BUY.
  EXHAUSTION:{tasks:['ENTRY'],facts:FATIGUE_FACTS,need:[],soft:m=>fatigueAxes(m).weak.length>=2,hard:()=>false,
    text:'2+ fatigue axes weak: '+Object.entries(FATIGUE_AXES).map(([k,a])=>k+'='+a.text).join('; ')},
  // Same-symbol re-entry within an hour with no new high since the previous exit: the
  // question is whether a NEW impulse exists, not whether the old one "is still alive".
  // Only for a packet that carries trade memory; never part of the FINAL RECHECK set.
  REENTRY_NO_NEW_IMPULSE:{tasks:['ENTRY'],recheck:false,when:p=>has(p?.facts?.values??{},'prev_trade_minutes_since_exit'),
    facts:['prev_trade_minutes_since_exit','prev_trade_return','prev_trade_mfe','price_vs_prev_peak','new_high_since_prev_exit'],
    need:['prev_trade_minutes_since_exit','price_vs_prev_peak'],
    soft:m=>m.prev_trade_minutes_since_exit<=60&&(has(m,'new_high_since_prev_exit')?m.new_high_since_prev_exit===0:m.price_vs_prev_peak<=0),hard:()=>false,
    text:'prev_trade_minutes_since_exit<=60 AND no new high since that exit (new_high_since_prev_exit=0, or price_vs_prev_peak<=0 when unknown)'},
  DATA_INCOMPLETE:{tasks:['ENTRY','HOLD'],facts:[],need:[],soft:()=>false,hard:()=>false,text:'candles (and, live, the order book) must be complete'}
});
export const CATEGORY_IDS=Object.freeze(Object.keys(CATEGORIES));
export const categoriesFor=task=>CATEGORY_IDS.filter(k=>CATEGORIES[k].tasks.includes(task));
/** Facts that may be cited as SUPPORT, with the direction that means "uptrend alive". */
const UP=Object.freeze({
  return_1m:['>',0],return_5m:['>',0],return_15m:['>',0],return_30m:['>',0],return_60m:['>',0],return_4h:['>',0],
  accel_5m_vs_15m:['>',0],accel_15m_vs_60m:['>',0],distance_sma20:['>',0],distance_trigger_reference:['>',0],
  distance_high_60m:['>=',-0.01],distance_low_15m:['>=',0.01],volume_ratio_5m_vs_60m:['>=',1],
  taker_buy_ratio_5m:['>',0.5],taker_buy_ratio_15m:['>',0.5],taker_buy_ratio_60m:['>',0.5],buyer_share_change:['>',0],
  relative_strength_15m:['>',0],relative_strength_60m:['>',0],btc_return_15m:['>=',0],btc_return_60m:['>=',0],
  oi_change_5m:['>',0],oi_change_60m:['>',0],funding_rate:['<',0.0008],
  spread_bps:['<=',10],ask_depth_to_order:['>=',5],bid_depth_to_order:['>=',3],book_imbalance_25bps:['>',0],est_buy_slippage_bps:['<',8],
  position_return:['>',0],position_drawdown_from_peak:['>',-0.01],position_minutes_since_new_high:['<=',15],
  // ENTRY trade memory: a fresh breakout above the previous same-symbol peak is support.
  price_vs_prev_peak:['>',0],new_high_since_prev_exit:['>=',1]
});
const OPS={'>':(v,t)=>v>t,'>=':(v,t)=>v>=t,'<':(v,t)=>v<t,'<=':(v,t)=>v<=t};
/** Facts that may be cited as SUPPORT, with the direction that means "uptrend alive". */
export const SUPPORT_UP=Object.freeze(Object.fromEntries(Object.entries(UP).map(([k,[op,t]])=>[k,v=>OPS[op](v,t)])));
export const SUPPORT_TEXT=Object.freeze(Object.fromEntries(Object.entries(UP).map(([k,[op,t]])=>[k,k+op+t])));
/** Price/flow facts; BUY/HOLD must cite at least one of them on the up side. */
export const TREND_SUPPORT=Object.freeze(['return_1m','return_5m','return_15m','return_30m','return_60m','accel_5m_vs_15m','accel_15m_vs_60m',
  'distance_sma20','distance_trigger_reference','distance_high_60m','taker_buy_ratio_5m','taker_buy_ratio_15m','relative_strength_15m','relative_strength_60m',
  'position_drawdown_from_peak','position_minutes_since_new_high']);
export const DATA_MODES=Object.freeze(['LIVE','REPLAY']);
/** Structured expected-value reasoning on ENTRY (2026-09-25). Written BEFORE the decision
 * (schema order), recorded with the answer, and never used as a gate: confidence and the
 * EV fields cannot block a BUY. Only an ABSTAIN must say which of the four reasons applies. */
export const EV_BIASES=Object.freeze(['POSITIVE','NEUTRAL','NEGATIVE','UNDETERMINED']);
export const ABSTAIN_REASONS=Object.freeze(['NONE','DATA_INSUFFICIENT','EVIDENCE_CONFLICT_SEVERE','EV_UNDETERMINABLE','EXECUTION_UNSAFE']);
/** SKIP by expected value when no risk category is breached. Legitimate only with >=2
 * server-verified bearish facts (>=1 price/flow fact) and GPT's own NEGATIVE EV with
 * downside > upside: the mirror of BUY's >=2 verified up-facts rule. */
export const EV_SKIP='EV_UNFAVORABLE';
/** (2026-09-26, operator principle) Models prepare evidence; they never constrain GPT's
 * strategy judgment. GPT may SKIP (ENTRY/RECHECK) or EXIT (HOLD) on its own judgment,
 * citing any facts that exist in the snapshot, whether or not a deterministic band fired. */
export const JUDGMENT='GPT_JUDGMENT';
/** The only HARD bands that still refuse a BUY: order/execution safety, which GPT never controls.
 * Strategy bands (SIGNAL_INVALIDATED, FUNDING/PREMIUM_EXTREME, SELL_WALL) are evidence. */
export const EXECUTION_SAFETY=Object.freeze(['SPREAD_ABNORMAL','THIN_LIQUIDITY','FILL_WORSE','DATA_INCOMPLETE']);
/** A HOLD is refused only when the snapshot cannot be judged at all. */
export const HOLD_BLOCKING=Object.freeze(['DATA_INCOMPLETE']);
/** A fact is bearish evidence exactly when it fails its published SUPPORT_UP direction (the
 * complement), so no new threshold is introduced and "already rose / near a high /
 * volatile" can never be cited: a rising return is not bearish. */
export const BEARISH=Object.freeze(Object.fromEntries(Object.keys(SUPPORT_UP).filter(k=>!POSITION_KEYS.includes(k))
  .map(k=>[k,v=>SUPPORT_UP[k](v)===false])));
export const BEARISH_TEXT=Object.freeze(Object.fromEntries(Object.entries(UP).filter(([k])=>!POSITION_KEYS.includes(k))
  .map(([k,[op,t]])=>[k,k+({'>':'<=','>=':'<','<':'>=','<=':'>'}[op])+t])));
const ENTRY_FACTS=FACT_KEYS.filter(k=>!POSITION_KEYS.includes(k));

/** Deterministic, model-independent risk state of one snapshot. */
export function riskFlags(packet){
  const m=packet.facts.values,task=packet.task,out={};
  for(const id of categoriesFor(task)){
    if(id==='DATA_INCOMPLETE')continue;
    const c=CATEGORIES[id],micro=c.facts.some(k=>MICRO_KEYS.includes(k));
    if(c.when&&!c.when(packet))continue;
    let level;
    if(!c.need.every(k=>has(m,k)))level='UNKNOWN';
    else{try{level=c.hard(m)===true?'HARD':c.soft(m)===true?'SOFT':'CLEAR';}catch{level='UNKNOWN';}}
    out[id]={level,micro};
  }
  const q=packet.facts.quality,incomplete=q.candles_complete!==true||(packet.data_mode==='LIVE'&&q.micro_complete!==true);
  out.DATA_INCOMPLETE={level:incomplete?'HARD':'CLEAR',micro:false};
  const list=l=>Object.entries(out).filter(([,x])=>x.level===l).map(([k])=>k);
  return {flags:out,hard:list('HARD'),soft:list('SOFT')};
}

const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const citeable=task=>FACT_KEYS.filter(k=>task==='HOLD'?!HISTORY_KEYS.includes(k):!POSITION_KEYS.includes(k));
/** Output schema. With a packet, the choices are narrowed to THIS snapshot: only categories
 * whose band is breached now can be a reason, only facts that currently point up can be
 * support, and SKIP/EXIT is not offered when no category is breached. The server still
 * re-validates every answer against the same packet. */
export function wireSchema(task,packet=null){
  const risk=packet?riskFlags(packet):null,m=packet?.facts?.values,entry=task==='ENTRY';
  const cats=risk?categoriesFor(task).filter(k=>['SOFT','HARD'].includes(risk.flags[k]?.level)):categoriesFor(task);
  // ENTRY only: the facts that fail their up-direction now, and whether EV_UNFAVORABLE can be cited.
  const bear=entry?Object.keys(BEARISH).filter(k=>!m||(has(m,k)&&BEARISH[k](m[k])===true)):[];
  const evSkip=entry&&(!m||bear.length>=1);
  const reasonIds=[...cats,...(evSkip?[EV_SKIP]:[]),JUDGMENT];
  // GPT_JUDGMENT may cite any fact present in this snapshot.
  const judgeFacts=citeable(task).filter(k=>!m||has(m,k));
  const catFacts=[...new Set([...cats.flatMap(k=>CATEGORIES[k].facts),...(evSkip?bear:[]),...judgeFacts])].filter(k=>!m||has(m,k));
  const up=Object.keys(SUPPORT_UP).filter(k=>(task==='HOLD'?!HISTORY_KEYS.includes(k):!POSITION_KEYS.includes(k))&&(!m||(has(m,k)&&SUPPORT_UP[k](m[k])===true)));
  const decisions=DECISIONS[task];
  const reasonItem=obj({r:{type:'string',enum:reasonIds.length?reasonIds:['DATA_INCOMPLETE']},e:{type:'array',maxItems:4,items:{type:'string',enum:catFacts.length?catFacts:['return_5m']}}});
  const t={type:'string',enum:[task]},c={type:'string',minLength:1,maxLength:80},d={type:'string',enum:decisions},
    reasons={type:'array',maxItems:reasonIds.length?4:0,items:reasonItem},
    support={type:'array',maxItems:6,items:{type:'string',enum:up.length?up:['return_5m']}},n={type:'string',minLength:1,maxLength:200};
  if(!entry)return obj({t,c,d,reasons,support,n});
  // Evidence first, decision after: the property order is the generation order.
  return obj({t,c,support,bearish:{type:'array',maxItems:6,items:{type:'string',enum:bear.length?bear:['return_5m']}},
    invalidation:{type:'array',maxItems:3,items:obj({fact:{type:'string',enum:ENTRY_FACTS},op:{type:'string',enum:['BELOW','ABOVE']},value:{type:'number'}})},
    upside_pct:{type:'number'},downside_pct:{type:'number'},ev:{type:'string',enum:EV_BIASES},confidence:{type:'number'},
    d,abstain_reason:{type:'string',enum:ABSTAIN_REASONS},reasons,n});
}
function ensure(ok,reason){if(!ok)throw Error(reason);}
export function validateShape(v,s,p='$'){
  const t=v===null?'null':Array.isArray(v)?'array':typeof v,ts=Array.isArray(s.type)?s.type:[s.type];
  ensure(ts.includes(t),'TYPE:'+p);if(s.enum)ensure(s.enum.includes(v),'ENUM:'+p);
  if(t==='string')ensure(v.length>=(s.minLength??0)&&v.length<=(s.maxLength??Infinity),'STRING:'+p);
  if(t==='object'){ensure(Object.keys(v).every(k=>Object.hasOwn(s.properties,k)),'EXTRA:'+p);
    for(const k of s.required)ensure(Object.hasOwn(v,k),'REQUIRED:'+p+'/'+k);for(const k of Object.keys(v))validateShape(v[k],s.properties[k],p+'/'+k);}
  if(t==='array'){ensure(v.length<=(s.maxItems??Infinity),'ARRAY:'+p);v.forEach((x,i)=>validateShape(x,s.items,p+'/'+i));}
}
/** Server-side validation. Returns the canonical answer or throws FD_* reasons. */
export function validateDecision(wire,packet){
  const task=packet.task,entry=task==='ENTRY';validateShape(wire,wireSchema(task));
  ensure(wire.c===packet.candidate_id,'FD_IDENTITY_MISMATCH');
  ensure(!/[0-9]/.test(wire.n),'FD_NUMERICAL_SUMMARY');
  const m=packet.facts.values,risk=riskFlags(packet),cite=k=>{ensure(has(m,k),'FD_CITED_FACT_MISSING:'+k);return {key:k,value:m[k],unit:FACT_DEFS[k][1]};};
  const isBear=k=>Object.hasOwn(BEARISH,k)&&has(m,k)&&BEARISH[k](m[k])===true;
  const reasons=wire.reasons.map(x=>{
    if(x.r===JUDGMENT){
      // Integrity only: the cited facts must exist in this snapshot. No band is required.
      ensure(new Set(x.e).size===x.e.length&&x.e.length>=1&&x.e.every(k=>citeable(task).includes(k)),'FD_JUDGMENT_REQUIRES_FACTS');
      return {category:JUDGMENT,level:'JUDGMENT',evidence:x.e.map(cite)};
    }
    if(entry&&x.r===EV_SKIP){
      // Integrity only: every cited fact must actually point down now.
      ensure(new Set(x.e).size===x.e.length&&x.e.length>=1&&x.e.every(isBear),'FD_EV_SKIP_REQUIRES_BEARISH_FACTS');
      return {category:EV_SKIP,level:'EV',evidence:x.e.map(cite)};
    }
    const c=CATEGORIES[x.r],flag=risk.flags[x.r];
    ensure(flag&&(flag.level==='SOFT'||flag.level==='HARD'),'FD_REASON_NOT_PRESENT:'+x.r);
    if(x.r!=='DATA_INCOMPLETE'){ensure(x.e.length>0&&x.e.every(k=>c.facts.includes(k)),'FD_REASON_EVIDENCE_OUTSIDE:'+x.r);}
    return {category:x.r,level:flag.level,evidence:x.e.map(cite)};
  });
  ensure(new Set(wire.support).size===wire.support.length,'FD_DUPLICATE_SUPPORT');
  // A support cite is only counted when the server confirms its direction; a misdirected
  // or unavailable cite is dropped and recorded, never counted toward BUY/HOLD.
  const support=[],rejected_support=[];
  for(const k of wire.support){ensure(Object.hasOwn(SUPPORT_UP,k),'FD_SUPPORT_NOT_ALLOWED:'+k);
    if(has(m,k)&&SUPPORT_UP[k](m[k])===true)support.push(cite(k));else rejected_support.push(k);}
  const d=wire.d;
  if(d==='BUY'||d==='HOLD'){
    const blocking=risk.hard.filter(k=>(d==='BUY'?EXECUTION_SAFETY:HOLD_BLOCKING).includes(k));
    ensure(blocking.length===0,'FD_'+d+'_WITH_HARD_RISK:'+blocking.join(','));
    // (2026-09-26) A BUY/HOLD that also names concerns is still GPT's decision: the concerns
    // are recorded (noted_risks), never a reason to void the answer.
    // Integrity only: at least one cited fact must really point up now.
    ensure(support.length>=1,'FD_'+d+'_REQUIRES_SUPPORT');
  }
  if(d==='PROTECT')ensure(reasons.length>0||support.length>0,'FD_PROTECT_REQUIRES_EVIDENCE');
  if(d==='SKIP'||d==='EXIT')ensure(reasons.length>0,'FD_'+d+'_REQUIRES_CATEGORY');
  const buyLike=d==='BUY'||d==='HOLD';
  const out={version:FD_VERSION,task,decision:d,reasons:buyLike?[]:reasons,...(buyLike&&reasons.length?{noted_risks:reasons}:{}),
    support,rejected_support,summary:wire.n,risk_hard:risk.hard,risk_soft:risk.soft};
  if(!entry)return out;
  // EV evidence. Recorded, never a gate: an inconsistency on BUY is flagged, not refused.
  ensure(new Set(wire.bearish).size===wire.bearish.length,'FD_DUPLICATE_BEARISH');
  const bearish=[],rejected_bearish=[];
  for(const k of wire.bearish){ensure(Object.hasOwn(BEARISH,k),'FD_BEARISH_NOT_ALLOWED:'+k);if(isBear(k))bearish.push(cite(k));else rejected_bearish.push(k);}
  const up=wire.upside_pct,down=wire.downside_pct,conf=wire.confidence,ev=wire.ev,flags=[];
  if(!(up>=0&&up<=100))flags.push('UPSIDE_OUT_OF_RANGE');if(!(down>=0&&down<=100))flags.push('DOWNSIDE_OUT_OF_RANGE');
  if(!(conf>=0&&conf<=1))flags.push('CONFIDENCE_OUT_OF_RANGE');
  if(d==='BUY'&&ev==='NEGATIVE')flags.push('BUY_WITH_NEGATIVE_EV');
  if(d==='BUY'&&down>up)flags.push('BUY_WITH_DOWNSIDE_ABOVE_UPSIDE');
  if(d==='SKIP'&&ev==='POSITIVE')flags.push('SKIP_WITH_POSITIVE_EV');
  if(d!=='ABSTAIN'&&wire.abstain_reason!=='NONE')flags.push('ABSTAIN_REASON_ON_'+d);
  if(d==='ABSTAIN')ensure(wire.abstain_reason!=='NONE','FD_ABSTAIN_REQUIRES_REASON');
  if(d==='SKIP'&&ev==='NEGATIVE'&&!(down>up))flags.push('SKIP_NEGATIVE_EV_WITHOUT_DOWNSIDE_EDGE');
  return {...out,bullish_evidence:support.map(e=>e.key),bearish_evidence:bearish,rejected_bearish,
    invalidation_conditions:wire.invalidation.map(x=>({fact:x.fact,op:x.op,value:x.value})),
    expected_upside_pct:up,expected_downside_pct:down,expected_value_bias:ev,confidence:conf,
    abstain_reason:d==='ABSTAIN'?wire.abstain_reason:'NONE',consistency_flags:flags};
}
