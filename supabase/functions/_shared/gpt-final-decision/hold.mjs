/** FD1 open-position review: "is the uptrend that made us buy still alive?"
 *
 * Deterministic protection is NEVER delegated: the native stop, R5 risk cut, P142 locks,
 * trailing and every safety close run exactly as before and are never delayed. GPT only
 *  (a) decides a TIME-based exit candidate (V17_MOMENTUM_STALE / V17_MAX_HOLD): a fresh
 *      valid HOLD defers it for HOLD_TTL_MS; EXIT, ABSTAIN, invalid, timeout, budget or
 *      any error falls back to the deterministic time exit;
 *  (b) may EXIT on a meaningful state change (momentum deterioration, significant price
 *      move) naming a breached category or, since 2026-09-26, its own GPT_JUDGMENT on cited facts
 *      (models prepare evidence; they do not constrain GPT's exit judgment).
 * Calls are event-driven, spaced, capped per position and journaled once per key. */
import {computeFacts,modelJudgments} from './facts.mjs';
import {readSources} from './market.mjs';
import {buildDecisionPacket,callDecision,hash,MODEL} from './api.mjs';
import {FD_VERSION} from './contract.mjs';
export const FD1_HOLD_POLICY_VERSION='FD1_HOLD_REVIEW_1';
export const TIME_REASONS=Object.freeze(['V17_MOMENTUM_STALE','V17_MAX_HOLD']);
export const HOLD_POLICY=Object.freeze({holdTtlMs:15*60_000,minGapMs:5*60_000,deteriorationMinGapMs:60_000,maxReviews:30,
  deteriorationDrawdown:-0.015,priceMove:0.02,timeAnswerWaitMs:25_000,exitMaxAgeMs:90_000});
const MIN=60000;
export function initialHoldState(entryPrice){
  return {version:FD1_HOLD_POLICY_VERSION,reviews:0,lastReviewAt:null,lastReviewPrice:Number(entryPrice),ddArmed:true,
    lastPeak:Number(entryPrice),holdUntil:null,pending:null,last:null};
}
/** Pure: which review (if any) this observation starts. Mirrors the validated replay. */
export function nextEvent(st,{now,price,peak,timeCandidate},P=HOLD_POLICY){
  const s={...st};
  if(peak>s.lastPeak){s.lastPeak=peak;s.ddArmed=true;}
  if(s.pending)return {state:s,event:null};
  if(timeCandidate){
    if(s.holdUntil&&now<s.holdUntil)return {state:s,event:null};
    if(s.reviews>=P.maxReviews)return {state:s,event:null,exhausted:true};
    return {state:s,event:'TIME_EXIT_CANDIDATE:'+timeCandidate};
  }
  if(s.reviews>=P.maxReviews)return {state:s,event:null};
  const elapsed=s.lastReviewAt==null?Infinity:now-s.lastReviewAt;
  // A new adverse crossing need not wait for an ordinary positive-move review's 5m gap.
  // Keep a bounded gap, one-shot arming and the existing per-position cap.
  if(s.ddArmed&&peak>0&&price/peak-1<=P.deteriorationDrawdown&&elapsed>=(P.deteriorationMinGapMs??P.minGapMs)){
    s.ddArmed=false;return {state:s,event:'MOMENTUM_DETERIORATION'};}
  if(elapsed<P.minGapMs)return {state:s,event:null};
  if(s.lastReviewPrice>0&&Math.abs(price/s.lastReviewPrice-1)>=P.priceMove)return {state:s,event:'SIGNIFICANT_PRICE_CHANGE'};
  return {state:s,event:null};
}
/**
 * Decide what a time-exit candidate / event means for this tick.
 * @returns {close:boolean, reason, state, start?:{key,event}}  close=false means defer.
 * `answerOf(key)` returns the stored answer {state:'RUNNING'|'DONE', decision, valid, completed_at_ms} or null.
 */
export async function holdStep(st0,{now,price,peak,timeCandidate,positionId,answerOf},P=HOLD_POLICY){
  let st={...(st0??{})};
  // 1. consume a pending review
  if(st.pending){
    const a=await answerOf(st.pending.key).catch(()=>null),age=now-st.pending.at,isTime=st.pending.event.startsWith('TIME_');
    if(a?.state==='DONE'){
      const completed=a.completed_at_ms;
      const fresh=Number.isSafeInteger(completed)&&Number.isSafeInteger(st.pending.at)&&
        completed>=st.pending.at&&completed<=now&&now-completed<=P.exitMaxAgeMs&&
        completed-st.pending.at<=P.timeAnswerWaitMs;
      const decision=a.valid===true&&fresh?a.decision:'ABSTAIN';
      st.last={key:st.pending.key,event:st.pending.event,decision,at:now};st.pending=null;
      if(isTime){
        if(decision==='HOLD'&&timeCandidate){st.holdUntil=now+P.holdTtlMs;return {close:false,reason:'FD1_GPT_HOLD',state:st};}
        if(timeCandidate)return {close:true,reason:decision==='EXIT'?'FD1_GPT_EXIT':null,fallback:decision!=='EXIT',state:st};
        return {close:false,reason:null,state:st}; // the time condition already cleared (new high)
      }
      if(decision==='EXIT'&&fresh)return {close:true,reason:'FD1_GPT_EXIT',state:st};
    }else if(age>P.timeAnswerWaitMs){
      st.last={key:st.pending.key,event:st.pending.event,decision:'TIMEOUT',at:now};st.pending=null;
      if(isTime&&timeCandidate)return {close:true,reason:null,fallback:true,state:st};
    }else if(isTime&&timeCandidate)return {close:false,reason:'FD1_AWAITING_GPT',state:st};
  }
  // 2. start a new review on a meaningful change
  const n=nextEvent(st,{now,price,peak,timeCandidate},P);st=n.state;
  if(n.exhausted)return {close:true,reason:null,fallback:true,state:st};
  if(n.event){
    const key=await hash({v:FD1_HOLD_POLICY_VERSION,positionId:String(positionId),event:n.event,at:Math.floor(now/1000)});
    st.pending={key,event:n.event,at:now};st.reviews+=1;st.lastReviewAt=now;st.lastReviewPrice=price;
    return {close:false,reason:timeCandidate?'FD1_AWAITING_GPT':null,state:st,start:{key,event:n.event}};
  }
  if(timeCandidate&&st.holdUntil&&now<st.holdUntil)return {close:false,reason:'FD1_GPT_HOLD',state:st};
  return {close:false,reason:null,state:st};
}
/** Build and ask one HOLD review from live public data. Never throws. */
export async function runHoldReview({position,event,timeCandidate,stopStage,apiKey,fetchFn=fetch,now=Date.now,onPacket}){
  try{
    const asOf=now(),{src,errors}=await readSources(String(position.symbol).toUpperCase(),asOf,{mode:'LIVE',fetchFn,ms:2500,now});
    const f=position.entryFeatures??{},snapshotAt=now();
    const facts=computeFacts(src,{asOf:snapshotAt,referenceClose:f.referenceClose,dayReturn:f.dayReturn,rank:f.rank,
      position:{entryPrice:position.entryPrice,peakPrice:position.peakPrice,entryAt:position.entryAt,lastHighAt:position.lastHighAt,
        stopPrice:position.stopPrice,requireLiveQuote:true}});
    if(!Number.isFinite(facts.values.position_return))throw Error('LIVE_POSITION_QUOTE_UNAVAILABLE');
    const packet=await buildDecisionPacket({task:'HOLD',subjectId:String(position.id)+':'+event+':'+asOf,symbol:position.symbol,dataMode:'LIVE',
      facts,judgments:modelJudgments(f),position:{event,deterministicExitCandidate:timeCandidate??null,stopStage:stopStage??null,
        valuation:{basis:'EXECUTABLE_BID',snapshot_at_ms:snapshotAt,quote_at_ms:Number(src.book.T??src.book.E),
          candle_close_at_ms:facts.quality.last_close_at_ms}}});
    // Observers are detached: no observer rejection or latency changes the GPT decision.
    if(onPacket)Promise.resolve().then(()=>onPacket(packet,snapshotAt)).catch(()=>{});
    const result=await callDecision(packet,{apiKey,fetchFn,now});
    return {packet,result:{...result,source_errors:errors,model:MODEL,contract:FD_VERSION}};
  }catch(e){
    return {packet:null,result:{decision:'ABSTAIN',valid:false,attempted:false,api_cost_usd:0,error:'FD_HOLD_PREP:'+String(e?.message??e).slice(0,80),completed_at_ms:now()}};
  }
}
export const _test={MIN};
