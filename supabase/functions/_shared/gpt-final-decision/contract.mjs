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
import {FACT_DEFS,FACT_KEYS,MICRO_KEYS,POSITION_KEYS} from './facts.mjs';
export const FD_VERSION='GPT_FINAL_DECISION_FD1';
export const ENTRY_TASK='ENTRY',HOLD_TASK='HOLD';
export const DECISIONS=Object.freeze({ENTRY:['BUY','SKIP','ABSTAIN'],HOLD:['HOLD','EXIT','ABSTAIN']});
const f=(m,k)=>m[k];
const has=(m,...ks)=>ks.every(k=>m[k]!==null&&m[k]!==undefined&&Number.isFinite(m[k]));
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
  SELL_WALL:{tasks:['ENTRY','HOLD'],facts:['book_imbalance_25bps','max_ask_wall_to_order'],need:['book_imbalance_25bps','max_ask_wall_to_order'],
    soft:m=>f(m,'book_imbalance_25bps')<=-0.45||f(m,'max_ask_wall_to_order')>=10,hard:m=>f(m,'book_imbalance_25bps')<=-0.75,
    text:'soft: book_imbalance_25bps<=-0.45 OR max_ask_wall_to_order>=10; HARD: imbalance<=-0.75'},
  FILL_WORSE:{tasks:['ENTRY'],facts:['est_buy_slippage_bps'],need:['est_buy_slippage_bps'],
    soft:m=>f(m,'est_buy_slippage_bps')>=8,hard:m=>f(m,'est_buy_slippage_bps')>=25,text:'soft>=8 bps, HARD>=25 bps'},
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
  position_return:['>',0],position_drawdown_from_peak:['>',-0.01],position_minutes_since_new_high:['<=',15]
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

/** Deterministic, model-independent risk state of one snapshot. */
export function riskFlags(packet){
  const m=packet.facts.values,task=packet.task,out={};
  for(const id of categoriesFor(task)){
    if(id==='DATA_INCOMPLETE')continue;
    const c=CATEGORIES[id],micro=c.facts.some(k=>MICRO_KEYS.includes(k));
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
const citeable=task=>FACT_KEYS.filter(k=>task==='HOLD'||!POSITION_KEYS.includes(k));
export function wireSchema(task){
  const key={type:'string',enum:citeable(task)};
  return obj({t:{type:'string',enum:[task]},c:{type:'string',minLength:1,maxLength:80},d:{type:'string',enum:DECISIONS[task]},
    reasons:{type:'array',maxItems:4,items:obj({r:{type:'string',enum:categoriesFor(task)},e:{type:'array',maxItems:4,items:key}})},
    support:{type:'array',maxItems:6,items:{type:'string',enum:Object.keys(SUPPORT_UP).filter(k=>task==='HOLD'||!POSITION_KEYS.includes(k))}},n:{type:'string',minLength:1,maxLength:200}});
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
  const task=packet.task;validateShape(wire,wireSchema(task));
  ensure(wire.c===packet.candidate_id,'FD_IDENTITY_MISMATCH');
  ensure(!/[0-9]/.test(wire.n),'FD_NUMERICAL_SUMMARY');
  const m=packet.facts.values,risk=riskFlags(packet),cite=k=>{ensure(has(m,k),'FD_CITED_FACT_MISSING:'+k);return {key:k,value:m[k],unit:FACT_DEFS[k][1]};};
  const reasons=wire.reasons.map(x=>{
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
    ensure(risk.hard.length===0,'FD_'+d+'_WITH_HARD_RISK:'+risk.hard.join(','));
    ensure(reasons.length===0,'FD_'+d+'_WITH_REASON');
    ensure(support.length>=(d==='BUY'?2:1),'FD_'+d+'_REQUIRES_SUPPORT');
    ensure(support.some(e=>TREND_SUPPORT.includes(e.key)),'FD_'+d+'_REQUIRES_TREND_FACT');
  }
  if(d==='SKIP'||d==='EXIT')ensure(reasons.length>0,'FD_'+d+'_REQUIRES_CATEGORY');
  return {version:FD_VERSION,task,decision:d,reasons,support,rejected_support,summary:wire.n,risk_hard:risk.hard,risk_soft:risk.soft};
}
