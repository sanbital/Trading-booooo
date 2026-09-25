/** GPT FINAL RECHECK (FD1-RC1): the pre-dispatch confirmation of an INITIAL GPT BUY.
 *
 * GPT stays the only strategy decision maker. This module adds no strategy gate:
 *  - detectChange() is a CHANGE DETECTOR. It compares the market GPT saw at its initial
 *    BUY with the pre-dispatch market (E1's tape + the dispatch book, both already read)
 *    and only answers "has it changed enough that GPT should look again?".
 *  - When it has, runFinalRecheck() asks GPT once more with INITIAL, CURRENT and DELTA,
 *    and GPT decides BUY / SKIP / ABSTAIN. Only a valid, unexpired BUY lets the order
 *    continue; SKIP, ABSTAIN, timeout, API error, invalid or expired answers place none.
 *  - postRecheckSafety() is deterministic execution safety after the recheck (quote newer
 *    than the answer, no catastrophic spread, no large drift since the answer's snapshot).
 *    The existing order guards (quote age, depth, margin, slots, duplicates, lease/fencing,
 *    circuit, BOO) still run after it, unchanged.
 * Rechecks are bounded by RECHECK_POLICY.maxRechecksPerCandidate and keyed by
 * signal + initial snapshot + IOC-attempt sequence. Replaying the same sequence
 * fails closed; a later IOC attempt may consume the next sequence only.
 *
 * Thresholds (see research/fd1-final-recheck-20260924/README.md):
 *  - price / tape bands are the adverse 20% tail of the change observed over the same
 *    ~10 s horizon after 113 FD1 replay triggers (Binance aggTrades), rounded toward MORE
 *    rechecks, and the same tail of 132 production E1 observations;
 *  - TAPE_FLOW_REVERSED is the FD1 contract's own support directions (return > 0,
 *    taker buy share > 0.5) both reversed on the latest tape;
 *  - book deltas have no historical book, so they are conservative relative moves and are
 *    re-calibrated from the pre-dispatch snapshots this release records. */
import {computeFacts,FACT_DEFS,FACT_KEYS,POSITION_KEYS,bookFacts,modelJudgments} from './facts.mjs';
import {readSources} from './market.mjs';
import {CAPTURE_NOTE,contextForModel} from './capture-context.mjs';
import {CATEGORIES,categoriesFor,riskFlags,SUPPORT_UP,SUPPORT_TEXT,TREND_SUPPORT,validateShape} from './contract.mjs';
import {callDecision,hash,MODEL} from './api.mjs';
export const RECHECK_VERSION='GPT_FINAL_RECHECK_FD1_RC1';
export const RECHECK_TASK='RECHECK';
export const RECHECK_POLICY=Object.freeze({
  version:RECHECK_VERSION,
  maxRechecksPerCandidate:2,
  requestTimeoutMs:4000,     // one API request, never retried
  freshReadMs:1500,          // fresh FD1 facts for the CURRENT section
  answerMaxAgeMs:8000,       // a final BUY is usable this long after its own snapshot
  executionReserveMs:3000,   // same reserve the initial review keeps before trigger expiry
  minTapeTrades:20,          // below this a 10 s tape is noise (p5 of replay trade counts)
  priceAdverse:-0.0025,      // mid since the initial snapshot (replay p20 -0.28%)
  priceChase:0.005,          // entry price ran away from what GPT judged (replay p97)
  tapeReturnAdverse:-0.0025, // latest tape window return (replay p20 -0.26%, E1 p10-p25)
  buyShareLow:0.40,          // latest tape taker-buy quote share (replay p20 0.38, E1 p25 0.39)
  buyShareDrop:-0.15,        // tape share minus the initial 5m share (replay p20 -0.16)
  spreadWidenBps:5,spreadWidenRatio:2,
  depthDropFraction:-0.5,
  imbalanceShift:-0.30,
  slippageWorsenBps:5,
  catastrophicSpreadBps:25,
  // (2026-09-25) An initial BUY this close to (or past) its own 15 s answer validity is
  // re-asked before dispatch instead of expiring on the dispatch check: time alone is not
  // a change in the market, so GPT decides again on fresh data (INITIAL_ANSWER_AGED).
  // 2.5 s covers the dispatch block's parallel reads between this point and the order.
  initialAgeMarginMs:2500,
});
/** Forced (non-market) recheck reasons. */
export const AGED_REASON='INITIAL_ANSWER_AGED';
const num=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?Number(x):null;
const has=(m,...ks)=>ks.every(k=>m[k]!==null&&m[k]!==undefined&&Number.isFinite(m[k]));
function ensure(ok,reason){if(!ok)throw Error(reason);}
/** Gateway ({price,size}) or Binance ([p,q]) levels -> [[p,q]]. */
export function levels(xs){
  return (Array.isArray(xs)?xs:[]).map(l=>Array.isArray(l)?[Number(l[0]),Number(l[1])]:[Number(l?.price),Number(l?.size)])
    .filter(([p,q])=>p>0&&q>=0&&Number.isFinite(p)&&Number.isFinite(q));
}
/** Book reference {bid,ask,mid,spread_bps,..bookFacts} from a raw quote/depth; null if unusable. */
export function bookReference(raw,at=null){
  const bids=levels(raw?.bids),asks=levels(raw?.asks);
  const bid=num(raw?.best_bid)??bids[0]?.[0]??null,ask=num(raw?.best_ask)??asks[0]?.[0]??null;
  if(!(bid>0&&ask>=bid))return null;
  const facts=bids.length&&asks.length?bookFacts({bids,asks}):null;
  return {bid,ask,mid:(bid+ask)/2,at:num(raw?.timing?.received_at_ms)??at,facts};
}
/** The keys of the INITIAL facts carried with the BUY ticket and shown again to GPT. */
export const INITIAL_KEYS=Object.freeze(FACT_KEYS.filter(k=>!POSITION_KEYS.includes(k)));
/** Compact initial context stored in the BUY ticket (coordinator). */
export function initialContext(record,answer){
  const v=record?.packet?.facts?.values??{};
  return {version:RECHECK_VERSION,snapshotAt:num(record?.snapshot_at_ms),completedAt:num(record?.result?.completed_at_ms),
    facts:Object.fromEntries(INITIAL_KEYS.map(k=>[k,num(v[k])])),lastClose:num(record?.packet?.facts?.quality?.last_close),
    executionRef:record?.packet?.execution_ref??null,support:(answer?.support??[]).map(e=>e.key),summary:answer?.summary??null};
}
/** PRE-DISPATCH snapshot from data the executor already holds (no I/O): E1's latest tape
 * observation and the quote E1 decided on. */
export function preDispatchSnapshot({at,rawQuote,e1=null}){
  const book=bookReference(rawQuote,at),obs=Array.isArray(e1?.observations)?e1.observations.at(-1):null;
  const tape=obs&&num(obs.return)!==null&&num(obs.buyShare)!==null?{source:'E1',startAt:num(obs.startAt),endAt:num(obs.endAt),
    windowMs:num(obs.endAt)!==null&&num(obs.startAt)!==null?obs.endAt-obs.startAt:null,return:num(obs.return),buyShare:num(obs.buyShare),
    tradeCount:num(obs.tradeCount)}:null;
  return {at,bid:book?.bid??null,ask:book?.ask??null,mid:book?.mid??null,quoteAt:book?.at??null,book:book?.facts??null,tape,
    e1State:e1?.confirmationState??null,e1Reasons:e1?.reasonCodes??null,expectedCostBps:num(e1?.expectedCostBps),
    expectedEntryVWAP:num(e1?.expectedEntryVWAP)};
}
const BOOK_CATS=['SPREAD_ABNORMAL','THIN_LIQUIDITY','SELL_WALL','FILL_WORSE'];
function bookLevel(id,m){
  const c=CATEGORIES[id];if(!m||!c.need.every(k=>has(m,k)))return 'UNKNOWN';
  return c.hard(m)?'HARD':c.soft(m)?'SOFT':'CLEAR';
}
const RANK={CLEAR:0,SOFT:1,HARD:2};
/** Pure. The change detector: triggered => GPT FINAL RECHECK is required before an order.
 * `force` adds non-market reasons (only AGED_REASON) decided by the caller. */
export function detectChange(initial,current,policy=RECHECK_POLICY,{force=[]}={}){
  const reasons=[...force.filter(r=>r===AGED_REASON)],I=initial?.facts??{},B=current?.book??{};
  const initMid=num(initial?.executionRef?.mid)??num(initial?.lastClose),initRefKind=num(initial?.executionRef?.mid)!==null?'BOOK_MID':
    num(initial?.lastClose)!==null?'LAST_CLOSE':null;
  const d=(a,b)=>a!==null&&b!==null?a-b:null,rel=(a,b)=>a!==null&&b>0?a/b-1:null;
  const t=current?.tape;
  const deltas={
    elapsed_since_initial_ms:num(initial?.snapshotAt)!==null&&num(current?.at)!==null?current.at-initial.snapshotAt:null,
    price_change_since_initial:rel(num(current?.mid),initMid),
    tape_return:num(t?.return),tape_buy_share:num(t?.buyShare),tape_trade_count:num(t?.tradeCount),tape_window_ms:num(t?.windowMs),
    buy_share_change_since_initial:d(num(t?.buyShare),num(I.taker_buy_ratio_5m)),
    spread_change_bps:d(num(B.spread_bps),num(I.spread_bps)),
    ask_depth_change:rel(num(B.ask_depth_to_order),num(I.ask_depth_to_order)),
    bid_depth_change:rel(num(B.bid_depth_to_order),num(I.bid_depth_to_order)),
    imbalance_change:d(num(B.book_imbalance_25bps),num(I.book_imbalance_25bps)),
    slippage_change_bps:d(num(B.est_buy_slippage_bps),num(I.est_buy_slippage_bps)),
    initial_reference:initRefKind};
  // Missing comparison data is not a pass: without it the change cannot be ruled out.
  if(!initial||initMid===null)reasons.push('INITIAL_REFERENCE_MISSING');
  if(num(current?.mid)===null)reasons.push('PRE_DISPATCH_QUOTE_MISSING');
  const tapeOk=t&&deltas.tape_return!==null&&deltas.tape_buy_share!==null&&(deltas.tape_trade_count??0)>=policy.minTapeTrades;
  if(!t)reasons.push('PRE_DISPATCH_TAPE_MISSING');
  const p=deltas.price_change_since_initial;
  if(p!==null&&p<=policy.priceAdverse)reasons.push('PRICE_ADVERSE');
  if(p!==null&&p>=policy.priceChase)reasons.push('PRICE_CHASE');
  if(tapeOk){
    if(deltas.tape_return<0&&deltas.tape_buy_share<0.5)reasons.push('TAPE_FLOW_REVERSED');
    if(deltas.tape_return<=policy.tapeReturnAdverse)reasons.push('TAPE_RETURN_ADVERSE');
    if(deltas.tape_buy_share<=policy.buyShareLow)reasons.push('BUY_SHARE_LOW');
    if(deltas.buy_share_change_since_initial!==null&&deltas.buy_share_change_since_initial<=policy.buyShareDrop)reasons.push('BUY_SHARE_DROP');
  }
  if(deltas.spread_change_bps!==null&&deltas.spread_change_bps>=policy.spreadWidenBps&&
    num(B.spread_bps)>=policy.spreadWidenRatio*Math.max(num(I.spread_bps),0))reasons.push('SPREAD_WIDENED');
  if((deltas.ask_depth_change!==null&&deltas.ask_depth_change<=policy.depthDropFraction)||
    (deltas.bid_depth_change!==null&&deltas.bid_depth_change<=policy.depthDropFraction))reasons.push('DEPTH_DROPPED');
  if(deltas.imbalance_change!==null&&deltas.imbalance_change<=policy.imbalanceShift)reasons.push('IMBALANCE_SHIFTED');
  if(deltas.slippage_change_bps!==null&&deltas.slippage_change_bps>=policy.slippageWorsenBps)reasons.push('SLIPPAGE_WORSENED');
  // FD1's own published book bands: a category that got worse since the initial BUY.
  for(const id of BOOK_CATS){const a=bookLevel(id,I),b=bookLevel(id,B);
    if(b!=='UNKNOWN'&&(a==='UNKNOWN'?RANK[b]>0:RANK[b]>RANK[a]))reasons.push('BOOK_BAND:'+id);}
  return {version:RECHECK_VERSION,triggered:reasons.length>0,reasons,deltas};
}

// ---------------------------------------------------------------- RECHECK contract
/** DELTA facts GPT may cite (units/definitions shown in the prompt). */
export const CHANGE_DEFS=Object.freeze({
  price_change_since_initial:['change','fraction','current mid / price at the initial BUY snapshot - 1'],
  tape_return:['change','fraction','latest pre-dispatch tape window (E1, ~10 s) last trade / first trade - 1'],
  tape_buy_share:['change','ratio','latest tape taker-buy quote / total quote (0.5 = balanced)'],
  tape_trade_count:['change','count','aggregate trades in the latest tape window'],
  buy_share_change_since_initial:['change','fraction_difference','tape_buy_share - initial taker_buy_ratio_5m'],
  spread_change_bps:['change','bps','current spread_bps - initial spread_bps'],
  ask_depth_change:['change','fraction','current ask_depth_to_order / initial - 1'],
  bid_depth_change:['change','fraction','current bid_depth_to_order / initial - 1'],
  imbalance_change:['change','fraction_difference','current book_imbalance_25bps - initial (negative = toward sellers)'],
  slippage_change_bps:['change','bps','current est_buy_slippage_bps - initial'],
  elapsed_since_initial_s:['change','seconds','seconds since the initial BUY snapshot'],
});
const CHANGE_KEYS=Object.keys(CHANGE_DEFS);
const P=RECHECK_POLICY;
/** Change categories: SOFT exactly when the detector's matching trigger fired. Never HARD:
 * a change is a question for GPT, not a deterministic block. */
export const CHANGE_CATEGORIES=Object.freeze({
  PRICE_SLIPPED:{facts:['price_change_since_initial','tape_return'],need:['price_change_since_initial'],
    soft:m=>m.price_change_since_initial<=P.priceAdverse,text:`price_change_since_initial<=${P.priceAdverse} (cannot be the ONLY SKIP reason)`},
  TAPE_SELLING:{facts:['tape_return','tape_buy_share','tape_trade_count'],need:['tape_return','tape_buy_share','tape_trade_count'],
    soft:m=>m.tape_trade_count>=P.minTapeTrades&&((m.tape_return<0&&m.tape_buy_share<0.5)||m.tape_return<=P.tapeReturnAdverse),
    text:`tape_trade_count>=${P.minTapeTrades} AND ((tape_return<0 AND tape_buy_share<0.5) OR tape_return<=${P.tapeReturnAdverse})`},
  BUYER_RETREAT:{facts:['tape_buy_share','buy_share_change_since_initial','tape_trade_count'],need:['tape_buy_share','tape_trade_count'],
    soft:m=>m.tape_trade_count>=P.minTapeTrades&&(m.tape_buy_share<=P.buyShareLow||(has(m,'buy_share_change_since_initial')&&m.buy_share_change_since_initial<=P.buyShareDrop)),
    text:`tape_trade_count>=${P.minTapeTrades} AND (tape_buy_share<=${P.buyShareLow} OR buy_share_change_since_initial<=${P.buyShareDrop})`},
  BOOK_DETERIORATED:{facts:['spread_change_bps','ask_depth_change','bid_depth_change','imbalance_change','slippage_change_bps'],need:[],
    soft:m=>(has(m,'spread_change_bps')&&m.spread_change_bps>=P.spreadWidenBps)||(has(m,'ask_depth_change')&&m.ask_depth_change<=P.depthDropFraction)||
      (has(m,'bid_depth_change')&&m.bid_depth_change<=P.depthDropFraction)||(has(m,'imbalance_change')&&m.imbalance_change<=P.imbalanceShift)||
      (has(m,'slippage_change_bps')&&m.slippage_change_bps>=P.slippageWorsenBps),
    text:`spread_change_bps>=${P.spreadWidenBps} OR ask/bid_depth_change<=${P.depthDropFraction} OR imbalance_change<=${P.imbalanceShift} OR slippage_change_bps>=${P.slippageWorsenBps}`},
});
const CHANGE_UP=Object.freeze({tape_return:['>',0],tape_buy_share:['>',0.5],buy_share_change_since_initial:['>=',0],price_change_since_initial:['>',0]});
const OPS={'>':(v,t)=>v>t,'>=':(v,t)=>v>=t};
const CHANGE_SUPPORT=Object.fromEntries(Object.entries(CHANGE_UP).map(([k,[o,t]])=>[k,v=>OPS[o](v,t)]));
const RECHECK_TREND=Object.freeze([...TREND_SUPPORT,'tape_return','tape_buy_share','price_change_since_initial']);
// recheck:false categories (CHASE_EXTENDED) belong to the initial ENTRY question only; the
// FINAL RECHECK category set is unchanged.
const ENTRY_CATS=categoriesFor('ENTRY').filter(k=>CATEGORIES[k].recheck!==false),CHANGE_CAT_IDS=Object.keys(CHANGE_CATEGORIES);
const FACT_OK=FACT_KEYS.filter(k=>!POSITION_KEYS.includes(k));
const allSupport=()=>[...Object.keys(SUPPORT_UP).filter(k=>!POSITION_KEYS.includes(k)),...Object.keys(CHANGE_SUPPORT)];
/** Deterministic flags: FD1 ENTRY categories on the CURRENT facts + change categories. */
export function recheckFlags(packet){
  const fd=riskFlags({task:'ENTRY',data_mode:packet.data_mode,facts:packet.facts});
  const m=packet.change.values,flags=Object.fromEntries(Object.entries(fd.flags).filter(([k])=>k==='DATA_INCOMPLETE'||ENTRY_CATS.includes(k)));
  for(const id of CHANGE_CAT_IDS){const c=CHANGE_CATEGORIES[id];let level;
    if(!c.need.every(k=>has(m,k)))level='UNKNOWN';else{try{level=c.soft(m)===true?'SOFT':'CLEAR';}catch{level='UNKNOWN';}}
    flags[id]={level,micro:id==='BOOK_DETERIORATED'};}
  const list=l=>Object.entries(flags).filter(([,x])=>x.level===l).map(([k])=>k);
  return {flags,hard:list('HARD'),soft:list('SOFT')};
}
const catFactsOf=id=>CATEGORIES[id]?.facts??CHANGE_CATEGORIES[id].facts;
const valueOf=(packet,k)=>Object.hasOwn(CHANGE_DEFS,k)?packet.change.values[k]:packet.facts.values[k];
const upOf=k=>SUPPORT_UP[k]??CHANGE_SUPPORT[k];
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export function recheckSchema(packet=null){
  const risk=packet?recheckFlags(packet):null;
  const allCats=[...ENTRY_CATS,...CHANGE_CAT_IDS];
  const cats=risk?allCats.filter(k=>['SOFT','HARD'].includes(risk.flags[k]?.level)):allCats;
  const known=k=>{const v=packet?valueOf(packet,k):0;return v!==null&&v!==undefined&&Number.isFinite(v);};
  const catFacts=[...new Set(cats.flatMap(catFactsOf))].filter(k=>!packet||known(k));
  const up=allSupport().filter(k=>!packet||(known(k)&&upOf(k)(valueOf(packet,k))===true));
  const decisions=cats.length?['BUY','SKIP','ABSTAIN']:['BUY','ABSTAIN'];
  const reasonItem=obj({r:{type:'string',enum:cats.length?cats:['DATA_INCOMPLETE']},e:{type:'array',maxItems:4,items:{type:'string',enum:catFacts.length?catFacts:['return_5m']}}});
  return obj({t:{type:'string',enum:[RECHECK_TASK]},c:{type:'string',minLength:1,maxLength:80},d:{type:'string',enum:decisions},
    reasons:{type:'array',maxItems:cats.length?4:0,items:reasonItem},
    support:{type:'array',maxItems:6,items:{type:'string',enum:up.length?up:['return_5m']}},n:{type:'string',minLength:1,maxLength:200}});
}
/** Server-side validation of a RECHECK answer. Throws RC_* / FD_* reasons (=> ABSTAIN). */
export function validateRecheck(wire,packet){
  validateShape(wire,recheckSchema());
  ensure(wire.c===packet.candidate_id,'FD_IDENTITY_MISMATCH');
  ensure(!/[0-9]/.test(wire.n),'FD_NUMERICAL_SUMMARY');
  const risk=recheckFlags(packet);
  const cite=k=>{const v=valueOf(packet,k);ensure(v!==null&&v!==undefined&&Number.isFinite(v),'FD_CITED_FACT_MISSING:'+k);
    return {key:k,value:v,unit:(FACT_DEFS[k]??CHANGE_DEFS[k])[1]};};
  const reasons=wire.reasons.map(x=>{
    const flag=risk.flags[x.r];ensure(flag&&(flag.level==='SOFT'||flag.level==='HARD'),'FD_REASON_NOT_PRESENT:'+x.r);
    if(x.r!=='DATA_INCOMPLETE')ensure(x.e.length>0&&x.e.every(k=>catFactsOf(x.r).includes(k)),'FD_REASON_EVIDENCE_OUTSIDE:'+x.r);
    return {category:x.r,level:flag.level,evidence:x.e.map(cite)};
  });
  ensure(new Set(wire.support).size===wire.support.length,'FD_DUPLICATE_SUPPORT');
  const support=[],rejected_support=[];
  for(const k of wire.support){const up=upOf(k);ensure(up,'FD_SUPPORT_NOT_ALLOWED:'+k);
    const v=valueOf(packet,k);if(v!==null&&v!==undefined&&Number.isFinite(v)&&up(v)===true)support.push(cite(k));else rejected_support.push(k);}
  const d=wire.d;
  if(d==='BUY'){
    ensure(risk.hard.length===0,'FD_BUY_WITH_HARD_RISK:'+risk.hard.join(','));
    ensure(reasons.length===0,'FD_BUY_WITH_REASON');
    ensure(support.length>=2,'FD_BUY_REQUIRES_SUPPORT');
    ensure(support.some(e=>RECHECK_TREND.includes(e.key)),'FD_BUY_REQUIRES_TREND_FACT');
  }
  if(d==='SKIP'){
    ensure(reasons.length>0,'FD_SKIP_REQUIRES_CATEGORY');
    // A lower price alone is not a reason to abandon a BUY (strategy buys strong movers).
    ensure(reasons.some(r=>r.category!=='PRICE_SLIPPED'),'RC_SKIP_PRICE_ONLY');
  }
  return {version:RECHECK_VERSION,task:RECHECK_TASK,decision:d,reasons,support,rejected_support,summary:wire.n,risk_hard:risk.hard,risk_soft:risk.soft};
}
const dict=Object.entries({...Object.fromEntries(FACT_OK.map(k=>[k,FACT_DEFS[k]])),...CHANGE_DEFS}).map(([k,[s,u,d]])=>`- ${k} [${s}, ${u}]: ${d}`).join('\n');
const catText=[...ENTRY_CATS.map(k=>`- ${k}: ${CATEGORIES[k].text}; cite only: ${CATEGORIES[k].facts.join(', ')||'(none)'}`),
  ...CHANGE_CAT_IDS.map(k=>`- ${k}: ${CHANGE_CATEGORIES[k].text}; cite only: ${CHANGE_CATEGORIES[k].facts.join(', ')}`)].join('\n');
const supText=[...Object.entries(SUPPORT_TEXT).filter(([k])=>!POSITION_KEYS.includes(k)).map(([,t])=>t),
  ...Object.entries(CHANGE_UP).map(([k,[o,t]])=>k+o+t)].join(', ');
export const RECHECK_PROMPT=CAPTURE_NOTE+'\n'+`너는 바이낸스 USDT 무기한 선물 롱 전용 자동매매 '트레이딩 부우'의 최종 매매 판단자다.
너는 조금 전 이 후보를 BUY했다. 그 이후 실제 주문 직전까지 시장 상태가 의미 있게 변했다(trigger_reasons).
질문: 이 변화까지 반영했을 때, 지금 이 순간에도 신규 LONG 진입 근거가 충분한가?

판단 원칙:
- 핵심은 "처음 BUY하게 만든 근거(initial.support)가 지금도 살아 있는가"이다. initial과 current, change를 비교하라.
- 이 재확인은 처음 BUY를 자동 승인하는 절차가 아니다. 근거가 약해졌으면 SKIP하라.
- 동시에 단순 가격 하락만으로 SKIP하지 마라(PRICE_SLIPPED 하나만으로는 SKIP 사유가 될 수 없다). "이미 많이 올랐다", "변동성이 크다"도 SKIP 사유가 아니다. 이 전략은 원래 강하게 상승하는 종목을 산다.
- 알고리즘 판단(V17, V30, B06133, CEC0040)은 model_judgments에 참고용으로만 있다. CEC0040 REJECT를 따를 의무도, 무시할 의무도 없다. 사실을 우선하라.
- 10초 테이프(tape_*)는 짧은 창이라 잡음이 있다. tape_trade_count와 다른 사실을 함께 보라.
- trigger_reasons의 ${AGED_REASON}은 시장 변화가 아니라 처음 BUY 답의 유효시간이 주문 전에 끝나 다시 묻는 것이다. 시간이 지났다는 사실 자체는 SKIP 사유가 아니다. current와 change로 판단하라.
- 너는 주문 크기, 레버리지, 슬롯, 손절, 주문 안전검사를 바꿀 수 없다. 그것들은 항상 작동한다.

결정:
- BUY: 현재 데이터에서도 상승 근거가 유지된다. support에 지금 실제로 만족하는 상승 사실 2개 이상(가격/체결 흐름 사실 1개 이상). reasons는 비운다. HARD 플래그가 있으면 BUY 불가.
- SKIP: 최초 BUY 이후 시장이 의미 있게 악화됐거나 현재 진입 근거가 충분하지 않다. risk_flags에 SOFT/HARD로 표시된 카테고리만 사유가 될 수 있다.
- ABSTAIN: 데이터 부족/모순으로 판단 불가. ABSTAIN이면 주문하지 않는다.

출력 규칙(서버가 검증하며, 어기면 무효 = ABSTAIN = 주문 없음):
- t는 RECHECK, c에는 입력의 candidate_id를 그대로 적는다.
- reasons의 각 r은 risk_flags에 SOFT 또는 HARD로 표시된 카테고리만, e에는 그 카테고리가 허용한 사실 키만.
- support에는 아래 지지 조건을 지금 실제로 만족하는 키만. 지지 조건: ${supText}
- n은 한국어 한두 문장 요약이며 숫자를 쓰지 않는다.

카테고리:
${catText}

사실 사전:
${dict}
`;
const round=v=>v===null||v===undefined?null:Number(Number(v).toPrecision(5));
/** What GPT sees for the recheck: INITIAL, CURRENT, CHANGE, trigger reasons, flags, judgments. */
export function recheckModelInput(packet){
  const sections={},v=packet.facts.values;
  for(const k of FACT_OK){if(v[k]===null||v[k]===undefined)continue;(sections[FACT_DEFS[k][0]]??={})[k]=round(v[k]);}
  const risk=recheckFlags(packet);
  return {t:RECHECK_TASK,candidate_id:packet.candidate_id,symbol:packet.symbol,data_mode:packet.data_mode,
    initial:{decision:packet.initial.decision,summary:packet.initial.summary,support:packet.initial.support,
      facts:Object.fromEntries(Object.entries(packet.initial.facts).filter(([,x])=>x!==null).map(([k,x])=>[k,round(x)]))},
    current:{facts:sections,unavailable:FACT_OK.filter(k=>v[k]===null),...(packet.facts.capture_context?{capture_context:contextForModel(packet.facts.capture_context)}:{})},
    change:Object.fromEntries(Object.entries(packet.change.values).filter(([,x])=>x!==null).map(([k,x])=>[k,round(x)])),
    trigger_reasons:packet.trigger_reasons,
    risk_flags:Object.fromEntries(Object.entries(risk.flags).filter(([,x])=>x.level!=='CLEAR').map(([k,x])=>[k,x.level])),
    model_judgments:packet.model_judgments};
}
export function recheckPayload(packet){
  return {model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',prompt_cache_key:'boo-fd1-recheck',
    reasoning:{effort:'none'},max_output_tokens:600,
    input:[{role:'system',content:RECHECK_PROMPT},{role:'user',content:JSON.stringify(recheckModelInput(packet))}],
    text:{verbosity:'low',format:{type:'json_schema',name:'fd1_recheck',strict:true,schema:recheckSchema(packet)}}};
}
/** Change values carried in the packet (the ones GPT may cite). */
export function changeValues(detection){
  const x=detection.deltas;
  return {price_change_since_initial:x.price_change_since_initial,tape_return:x.tape_return,tape_buy_share:x.tape_buy_share,
    tape_trade_count:x.tape_trade_count,buy_share_change_since_initial:x.buy_share_change_since_initial,spread_change_bps:x.spread_change_bps,
    ask_depth_change:x.ask_depth_change,bid_depth_change:x.bid_depth_change,imbalance_change:x.imbalance_change,
    slippage_change_bps:x.slippage_change_bps,elapsed_since_initial_s:x.elapsed_since_initial_ms===null?null:x.elapsed_since_initial_ms/1000};
}
export async function buildRecheckPacket({signalId,symbol,dataMode='LIVE',facts,initial,detection,judgments,currentRef=null,preDispatch=null}){
  ensure(detection,'RC_PACKET_INPUT');initial=initial??{facts:{},support:[]};
  const packet={version:RECHECK_VERSION,task:RECHECK_TASK,candidate_id:'r_'+(await hash(String(signalId)+':RECHECK')).slice(0,24),
    symbol:String(symbol).toUpperCase(),data_mode:dataMode,facts,
    change:{values:changeValues(detection)},trigger_reasons:[...detection.reasons],
    initial:{decision:'BUY',summary:initial.summary??null,support:(initial.support??[]).map(k=>({key:k,value:round(initial.facts?.[k]??null)})),
      facts:{...(initial.facts??{})},snapshot_at_ms:initial.snapshotAt??null,execution_ref:initial.executionRef??null},
    model_judgments:judgments??null,current_ref:currentRef,pre_dispatch:preDispatch,snapshot_hash:''};
  packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
  return packet;
}
function authorized(c,apiKey){return c?.mode==='ENFORCE'&&c.modeValid!==false&&c.enforceApproved===true&&String(c.approvalRef??'').length>0&&
  c.apiBudgetUsd>=0.10&&Number.isInteger(c.maxCalls)&&c.maxCalls>0&&!!apiKey;}
/**
 * One GPT FINAL RECHECK. Never throws; every failure is ABSTAIN (no order).
 * @returns {decision,valid,error,answer,latency_ms,api_cost_usd,snapshot_at_ms,completed_at_ms,valid_until_ms,job_key,attempted}
 */
export async function runFinalRecheck({signal,ticket,detection,preDispatch,store,config,apiKey,fetchFn=fetch,now=Date.now,
  purpose='PRODUCTION',readFresh=readSources,dataMode='LIVE',asOf=null,sequence=1,policy=RECHECK_POLICY}){
  const started=now();
  const out=(o)=>({version:RECHECK_VERSION,decision:'ABSTAIN',valid:false,error:null,answer:null,latency_ms:null,api_cost_usd:null,
    snapshot_at_ms:null,completed_at_ms:now(),valid_until_ms:null,job_key:null,attempted:false,started_at_ms:started,...o});
  if(!authorized(config,apiKey))return out({error:'RC_NOT_AUTHORIZED'});
  if(!Number.isInteger(sequence)||sequence<1||sequence>policy.maxRechecksPerCandidate)return out({error:'RC_LIMIT_REACHED'});
  const f=signal?.features??{},initial=ticket?.initial;
  const expires=num(ticket?.expires),deadline=expires===null?started+policy.requestTimeoutMs:expires-policy.executionReserveMs;
  if(started>=deadline)return out({error:'RC_TRIGGER_EXPIRED'});
  let key,owner,record;
  try{
    const identity={signal_id:String(signal.id),symbol:String(signal.symbol).toUpperCase(),kind:'FD1_FINAL_RECHECK',
      recheck_sequence:sequence,initial_snapshot_hash:String(ticket?.snapshotHash??''),trigger_at_ms:num(f.v17Setup?.triggerAt)};
    key=await hash({version:RECHECK_VERSION,identity,purpose});
    record={version:RECHECK_VERSION,kind:'FD1_FINAL_RECHECK',purpose,recheck_sequence:sequence,api_approval_ref:config.approvalRef,identity,reserved_usd:0.10,
      source_commit:RECHECK_VERSION,prompt_hash:await hash(RECHECK_PROMPT),detection,packet:null,result:null};
    let claimed;
    try{claimed=await store.claim(key,record,config);}
    catch(e){return out({error:/API_BUDGET_EXHAUSTED/.test(String(e?.message??e))?'RC_BUDGET_EXHAUSTED':'RC_CLAIM_FAILED',job_key:key});}
    // The durable per-candidate cap: an existing recheck for this BUY is never repeated or reused.
    if(!claimed.created)return out({error:'RC_LIMIT_REACHED',job_key:key});
    owner=claimed.row.owner;
  }catch{return out({error:'RC_CLAIM_FAILED',job_key:key??null});}
  let result;
  try{
    const at=asOf??now();
    const {src,errors}=await readFresh(String(signal.symbol).toUpperCase(),at,{mode:dataMode,fetchFn,ms:policy.freshReadMs});
    const captured=asOf??now();
    const facts=computeFacts(src,{asOf:captured,referenceClose:f.referenceClose,dayReturn:f.dayReturn,rank:f.rank});
    const judgments=(()=>{try{return JSON.parse(ticket.identityJson).judgments;}catch{return modelJudgments(f);}})();
    const currentRef=src.book?bookReference(src.book,captured):null;
    record.packet=await buildRecheckPacket({signalId:signal.id,symbol:signal.symbol,dataMode,facts,initial,detection,judgments,
      currentRef:currentRef?{bid:currentRef.bid,ask:currentRef.ask,mid:currentRef.mid,at:captured}:null,preDispatch});
    record.packet.source_errors=errors;
    record.snapshot_at_ms=asOf===null?captured:now();
    const remaining=deadline-now();
    if(remaining<=0)throw Error('RC_TRIGGER_EXPIRED');
    result=await callDecision(record.packet,{apiKey,fetchFn,now,timeoutMs:Math.max(1,Math.min(policy.requestTimeoutMs,remaining)),
      payloadFn:recheckPayload,validate:validateRecheck});
    result={...result,model_requested:MODEL,wire_profile:RECHECK_VERSION};
  }catch(e){
    result={origin:'LOCAL_DATA_ERROR',valid:false,decision:'ABSTAIN',error:/^RC_/.test(e?.message??'')?e.message:'RC_PREPARATION_FAILED',
      attempted:false,api_cost_usd:0,completed_at_ms:now(),model_requested:MODEL,wire_profile:RECHECK_VERSION};
  }
  record.result=result;
  const snap=record.snapshot_at_ms??null;
  const validUntil=snap===null?null:Math.min(snap+policy.answerMaxAgeMs,deadline);
  try{await store.complete(key,owner,record);}
  catch{return out({error:'RC_RECORD_FAILED',job_key:key,attempted:result.attempted===true,api_cost_usd:result.api_cost_usd??null,
    latency_ms:result.latency_ms??null,snapshot_at_ms:snap});}
  const common={job_key:key,attempted:result.attempted===true,api_cost_usd:result.api_cost_usd??null,latency_ms:result.latency_ms??null,
    snapshot_at_ms:snap,completed_at_ms:result.completed_at_ms??now(),valid_until_ms:validUntil,answer:result.answer??null,
    current_ref:record.packet?.current_ref??null,request_id:result.request_id??null};
  if(!result.valid)return out({...common,error:result.error??'RC_INVALID'});
  if(validUntil===null||now()>=validUntil)return out({...common,error:'RC_EXPIRED'});
  return out({...common,decision:result.decision,valid:true});
}
/** Pure: may the order path continue after a recheck? Only a valid, unexpired BUY. */
export function recheckAllows(r,at){
  return r?.valid===true&&r.decision==='BUY'&&Number.isFinite(r.valid_until_ms)&&at<r.valid_until_ms;
}
/** Pure deterministic execution safety after a FINAL BUY, on the dispatch quote.
 * This is execution safety only: the quote must be newer than the answer, readable
 * and not catastrophically wide. Price drift is evidence, never a second strategy veto;
 * meaningful drift belongs in detectChange() -> GPT FINAL RECHECK. */
export function postRecheckSafety({recheck,quote,at,policy=RECHECK_POLICY}){
  const ref=num(recheck?.current_ref?.mid),bid=num(quote?.best_bid),ask=num(quote?.best_ask),recv=num(quote?.timing?.received_at_ms);
  if(!recheckAllows(recheck,at))return {ok:false,reason:'RC_FINAL_NOT_BUY_OR_EXPIRED'};
  if(!(bid>0&&ask>=bid))return {ok:false,reason:'RC_POST_QUOTE_INVALID'};
  if(recv===null||recv<num(recheck.completed_at_ms))return {ok:false,reason:'RC_POST_QUOTE_NOT_AFTER_ANSWER'};
  const mid=(bid+ask)/2,spreadBps=(ask-bid)/mid*1e4;
  if(spreadBps>policy.catastrophicSpreadBps)return {ok:false,reason:'RC_POST_SPREAD_CATASTROPHIC',spreadBps};
  if(ref===null)return {ok:false,reason:'RC_POST_REFERENCE_MISSING'};
  const drift=mid/ref-1;
  return {ok:true,reason:null,drift,spreadBps};
}
