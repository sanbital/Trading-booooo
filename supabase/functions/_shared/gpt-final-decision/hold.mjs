/** Event-driven strategic review. Hard safety is checked before this module.
 * Soft protection may be promoted to resident reduce-only protection by the host; strategic exits remain explicitly authorized. */
import {computeFacts,modelJudgments} from './facts.mjs';
import {readSources} from './market.mjs';
import {buildDecisionPacket,callDecision,hash,MODEL} from './api.mjs';
import {FD_VERSION} from './contract.mjs';
import {dualEntryDecision,DUAL_VERSION} from './dual.mjs';
export const FD1_HOLD_POLICY_VERSION='FD1_HOLD_EXIT_AUTHORITY_2';
export const TIME_REASONS=Object.freeze(['V17_MOMENTUM_STALE','V17_MAX_HOLD']);
export const HOLD_POLICY=Object.freeze({holdTtlMs:15*60_000,minGapMs:5*60_000,deteriorationMinGapMs:60_000,maxReviews:30,
  deteriorationDrawdown:-0.015,priceMove:0.02,timeAnswerWaitMs:25_000,exitMaxAgeMs:25_000,
  softMinGapMs:20_000,protectMs:30_000,softMove:0.003,reviewWindowMs:3600000});
const MIN=60000;
export function initialHoldState(entryPrice){
 return {version:FD1_HOLD_POLICY_VERSION,reviews:0,lastReviewAt:null,lastReviewPrice:Number(entryPrice),ddArmed:true,
  lastPeak:Number(entryPrice),holdUntil:null,pending:null,last:null,softReceipt:null,protectLevel:null};
}
/** Capture is continuous; only changed evidence spends an AI call. Unchanged soft
 * crossings are consumed, not repeatedly voted on. A recovery rearms the crossing. */
export function nextEvent(st,{now,price,peak,timeCandidate,softTrigger,dynamics},P=HOLD_POLICY){
 const s={...st},elapsed=s.lastReviewAt==null?Infinity:now-s.lastReviewAt;
 if(!s.reviewWindowAt)s.reviewWindowAt=now;
 if(now-s.reviewWindowAt>=P.reviewWindowMs){s.reviews=0;s.reviewWindowAt=now;}
 if(peak>s.lastPeak){s.lastPeak=peak;s.ddArmed=true;}
 if(!softTrigger?.active)s.softArmed=true;
 if(s.pending||s.retryAfter&&now<s.retryAfter)return {state:s,event:null};
 if(s.reviews>=P.maxReviews)return {state:s,event:null,exhausted:true};
 if(s.protectUntil&&now>=s.protectUntil){s.protectUntil=null;return {state:s,event:'PROTECTION_REASSESSMENT'};}
 if(softTrigger?.active){
  const receipt=s.softReceipt,factor=s.protectUntil?0.5:1;
  const changed=!receipt||receipt.key!==softTrigger.key||s.softArmed||
   Math.abs(price/receipt.price-1)>=P.softMove*factor||peak>receipt.peak||
   dynamics?.event&&dynamics.evidenceKey!==receipt.evidenceKey;
  if(changed&&elapsed>=P.softMinGapMs){s.softArmed=false;return {state:s,event:'SOFT_PROTECTION_TRIGGER:'+softTrigger.reason};}
 }
 if(dynamics?.event&&elapsed>=(s.protectUntil?P.softMinGapMs:P.deteriorationMinGapMs)&&
   dynamics.evidenceKey!==s.lastDynamicsKey){s.lastDynamicsKey=dynamics.evidenceKey;return {state:s,event:dynamics.event};}
 if(timeCandidate){
  if(s.holdUntil&&now<s.holdUntil)return {state:s,event:null};
  if(elapsed>=P.softMinGapMs)return {state:s,event:'TIME_EXIT_CANDIDATE:'+timeCandidate};
 }
 if(s.ddArmed&&peak>0&&price/peak-1<=P.deteriorationDrawdown*(s.protectUntil?0.5:1)&&elapsed>=P.deteriorationMinGapMs){
  s.ddArmed=false;return {state:s,event:'MOMENTUM_DETERIORATION'};}
 if(elapsed>=P.minGapMs&&s.lastReviewPrice>0&&Math.abs(price/s.lastReviewPrice-1)>=P.priceMove)
  return {state:s,event:'SIGNIFICANT_PRICE_CHANGE'};
 return {state:s,event:null};
}
export async function holdStep(st0,{now,price,peak,timeCandidate,softTrigger,dynamics,positionId,generation,answerOf},P=HOLD_POLICY){
 let st={...(st0??{})};
 if(st.generation&&generation&&st.generation!==generation)st=initialHoldState(price);
 st.generation=generation??st.generation??String(positionId);
 if(st.pending){
  const pending=st.pending,a=await answerOf(pending.key).catch(()=>null),age=now-pending.at;
  if(a?.state==='DONE'||age>P.timeAnswerWaitMs){
   const completed=a?.completed_at_ms,snapshot=a?.snapshot_at_ms??completed;
   const fresh=Number.isSafeInteger(completed)&&completed>=pending.at&&completed<=now&&now-completed<=P.exitMaxAgeMs&&
    completed-pending.at<=P.timeAnswerWaitMs&&Number.isSafeInteger(snapshot)&&snapshot>=pending.at&&snapshot<=now&&now-snapshot<=P.exitMaxAgeMs;
   const decision=a?.valid===true&&fresh&&!a.refresh_error?a.decision:'ABSTAIN',authority=a?.authority??'GPT_FINAL_ONLY';
   st.last={key:pending.key,event:pending.event,decision,authority,at:now};st.pending=null;
   st.softReceipt={key:pending.softKey??softTrigger?.key,price,peak,evidenceKey:dynamics?.evidenceKey??null,at:now};
   if(decision==='EXIT'){
     const emergency=authority==='DEEPSEEK_EMERGENCY_EXIT_ONLY';
     return {close:true,reason:emergency?'FD1_DEEPSEEK_EXIT':'FD1_GPT_EXIT',state:st,approval:{authority,valid:true,decision,
       positionId:String(positionId),generation:st.generation,jobKey:emergency?null:pending.key,
       snapshotHash:a?.snapshot_hash??null,completedAt:completed,snapshotAt:snapshot,refreshError:null}};
   }
   if(decision==='PROTECT'){
    // Internal soft floor only. Never becomes a native stop or changes exposure.
    st.protectLevel=Math.max(st.protectLevel??0,softTrigger?.level??0,price*(1+P.deteriorationDrawdown/2));
    st.protectUntil=now+P.protectMs;st.holdUntil=timeCandidate?st.protectUntil:st.holdUntil;
    st.protection={mode:'ELEVATED',sensitivityMultiplier:2,intervalMs:P.protectMs,exposureIncrease:false};
    return {close:false,reason:'FD1_GPT_PROTECT',state:st};
   }
   if(decision==='HOLD'){
    if(timeCandidate)st.holdUntil=now+P.holdTtlMs;
    return {close:false,reason:'FD1_GPT_HOLD',state:st};
   }
   st.retryAfter=now+P.deteriorationMinGapMs;st.softArmed=true;
   return {close:false,reason:age>P.timeAnswerWaitMs?'FD1_FINAL_TIMEOUT':'FD1_FINAL_UNAVAILABLE',state:st};
  }
  return {close:false,reason:'FD1_AWAITING_GPT',state:st};
 }
 const n=nextEvent(st,{now,price,peak,timeCandidate,softTrigger,dynamics},P);st=n.state;
 if(n.exhausted)return {close:false,reason:'FD1_REVIEW_LIMIT',state:st};
 if(n.event){
  const key=await hash({v:FD1_HOLD_POLICY_VERSION,positionId:String(positionId),generation:st.generation,event:n.event,at:Math.floor(now/1000)});
  st.pending={key,event:n.event,at:now,softKey:softTrigger?.key??null};st.reviews+=1;st.lastReviewAt=now;st.lastReviewPrice=price;
  return {close:false,reason:'FD1_AWAITING_GPT',state:st,start:{key,event:n.event}};
 }
 return {close:false,reason:timeCandidate&&st.holdUntil&&now<st.holdUntil?'FD1_GPT_HOLD':null,state:st};
}
function refreshExitContext(c,book,at){
 if(!c)return null;
 const bid=Number(book?.bids?.[0]?.[0]),entry=Number(c.entry_price),peak=Math.max(Number(c.peak??entry),bid);
 if(!(bid>0&&entry>0))throw Error('LIVE_POSITION_QUOTE_UNAVAILABLE');
 return {...c,snapshot_at_ms:at,current_price:bid,peak,mfe:peak/entry-1,
  mae:Math.min(c.mae??0,bid/entry-1),mfe_giveback:peak>entry?(peak-bid)/(peak-entry):0,drawdown:bid/peak-1,
  hard_hit:bid<=c.hard_floor,soft_trigger:c.soft_trigger?{...c.soft_trigger,
   distance:c.soft_trigger.level?bid/c.soft_trigger.level-1:null,crossed:c.soft_trigger.level?bid<=c.soft_trigger.level:false}:null};
}
/** Build and ask one HOLD review from live public data. Never throws. */
export async function runHoldReview({position,event,timeCandidate,stopStage,exitContext=null,apiKey,deepseekKey,fetchFn=fetch,now=Date.now,onPacket}){
  try{
    const asOf=now(),{src,errors}=await readSources(String(position.symbol).toUpperCase(),asOf,{mode:'LIVE',fetchFn,ms:2500,now,positionId:position.capturePositionId??null});
    const f=position.entryFeatures??{},snapshotAt=now();
    const facts=computeFacts(src,{asOf:snapshotAt,referenceClose:f.referenceClose,dayReturn:f.dayReturn,rank:f.rank,
      position:{entryPrice:position.entryPrice,peakPrice:position.peakPrice,entryAt:position.entryAt,lastHighAt:position.lastHighAt,
        stopPrice:position.stopPrice,requireLiveQuote:true}});
    if(!Number.isFinite(facts.values.position_return))throw Error('LIVE_POSITION_QUOTE_UNAVAILABLE');
    const packet=await buildDecisionPacket({task:'HOLD',subjectId:String(position.id)+':'+event+':'+asOf,symbol:position.symbol,dataMode:'LIVE',
      facts,judgments:modelJudgments(f),position:{event,positionId:position.id,generation:position.generation,exitContext:refreshExitContext(exitContext,src.book,snapshotAt),deterministicExitCandidate:timeCandidate??null,stopStage:stopStage??null,
        valuation:{basis:'EXECUTABLE_BID',snapshot_at_ms:snapshotAt,quote_at_ms:Number(src.book.T??src.book.E),
          candle_close_at_ms:facts.quality.last_close_at_ms}}});
    // Observers are detached: no observer rejection or latency changes the GPT decision.
    if(onPacket)Promise.resolve().then(()=>onPacket(packet,snapshotAt)).catch(()=>{});
    const result=await dualEntryDecision(packet,{apiKey,deepseekKey,fetchFn,now,deadlineMs:asOf+HOLD_POLICY.timeAnswerWaitMs-1000,snapshotAtMs:snapshotAt,
      refreshPacket:async ms=>{
        const at=now(),fresh=await readSources(String(position.symbol).toUpperCase(),at,{mode:'LIVE',fetchFn,ms,now,positionId:position.capturePositionId??null}),captured=now();
        const nextFacts=computeFacts(fresh.src,{asOf:captured,referenceClose:f.referenceClose,dayReturn:f.dayReturn,rank:f.rank,position:{entryPrice:position.entryPrice,peakPrice:position.peakPrice,entryAt:position.entryAt,lastHighAt:position.lastHighAt,stopPrice:position.stopPrice,requireLiveQuote:true}});
        if(!Number.isFinite(nextFacts.values.position_return))throw Error('LATEST_QUOTE_UNAVAILABLE');
        const next={...packet,facts:nextFacts,position:{...packet.position,exit_context:exitContext?{...refreshExitContext(exitContext,fresh.src.book,captured),latest_refresh:true}:null,valuation:{...packet.position.valuation,snapshot_at_ms:captured,quote_at_ms:Number(fresh.src.book?.T??fresh.src.book?.E)}}};
        next.snapshot_hash=await hash({...next,snapshot_hash:''});return {packet:next,captured};
      }});
    return {packet:result.final_packet??packet,result:{...result,source_errors:errors,model:MODEL,contract:FD_VERSION}};
  }catch(e){
    return {packet:null,result:{decision:'ABSTAIN',valid:false,attempted:false,api_cost_usd:0,error:'FD_HOLD_PREP:'+String(e?.message??e).slice(0,80),completed_at_ms:now()}};
  }
}
export const _test={MIN};
