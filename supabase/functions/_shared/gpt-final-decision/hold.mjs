/** Event-driven strategic review. Hard safety is checked before this module.
 * A deterministic soft candidate is review evidence, never protection: only this reviewer's
 * RAISE_PROTECTION (wire name PROTECT) promotes the exact candidate it judged to resident
 * reduce-only protection, and only upward. Strategic exits remain explicitly authorized. */
import {computeFacts,modelJudgments} from './facts.mjs';
import {readSources} from './market.mjs';
import {buildDecisionPacket,callDecision,hash,MODEL} from './api.mjs';
import {FD_VERSION} from './contract.mjs';
import {dualEntryDecision,DUAL_VERSION} from './dual.mjs';
import {DYNAMIC_VERSION,DYNAMIC_POLICY,positionDynamicState,compactDynamic,dynamicDelta} from './dynamic-flow.mjs';
import {emergencyDynamicPacket} from './capture-context.mjs';
import {isReviewTimeout} from './timeout-recovery.mjs';
export const FD1_HOLD_POLICY_VERSION='FD1_HOLD_EXIT_AUTHORITY_2';
export const TIME_REASONS=Object.freeze(['V17_MOMENTUM_STALE','V17_MAX_HOLD']);
export const HOLD_POLICY=Object.freeze({holdTtlMs:15*60_000,minGapMs:5*60_000,deteriorationMinGapMs:60_000,maxReviews:30,
  deteriorationDrawdown:-0.015,priceMove:0.02,timeAnswerWaitMs:25_000,exitMaxAgeMs:25_000,
  softMinGapMs:20_000,protectMs:30_000,softMove:0.003,reviewWindowMs:3600000});
export const MONTHLY_HOLD_POLICY=Object.freeze({...HOLD_POLICY,costProfile:true,
 minGapMs:3600000,deteriorationMinGapMs:300000,softMinGapMs:300000,protectMs:300000,
 periodicReviewMs:21600000,ordinaryGapMs:300000,urgentGapMs:DYNAMIC_POLICY.missingRetryMs,maxReviews:12});
const URGENT_COST_EVENTS=new Set(['POST_FILL_THESIS_REVIEW','ENTRY_FAILURE_MULTI_AXIS','BTC_SHOCK','NATIVE_HARD_STOP_PROXIMITY','BID_DEPTH_COLLAPSE','SPREAD_BLOWOUT','TREND_BREAK','RAPID_MFE_GIVEBACK']);
export const urgentHoldEvent=event=>URGENT_COST_EVENTS.has(event);
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
 if(s.pending)return {state:s,event:null};
 if(P.costProfile){
  const urgent=URGENT_COST_EVENTS.has(dynamics?.event);
  const gap=urgent?P.urgentGapMs:P.ordinaryGapMs;
  if(elapsed<gap||!urgent&&(s.reviews>=P.maxReviews||s.retryAfter&&now<s.retryAfter))return {state:s,event:null};
  if(urgent)s.retryAfter=null;
 }
 if(dynamics?.event&&
    (elapsed>=DYNAMIC_POLICY.missingRetryMs||dynamics.event==='TRAJECTORY_RECOVERED')&&dynamics.evidenceKey!==s.lastDynamicsKey){
  s.lastDynamicsKey=dynamics.evidenceKey;return {state:s,event:dynamics.event};
 }
 if(s.retryAfter&&now<s.retryAfter)return {state:s,event:null};
 if(s.reviews>=P.maxReviews)return {state:s,event:null,exhausted:true};
 if(s.timeoutRetryEvent){const event=s.timeoutRetryEvent;s.timeoutRetryEvent=null;return {state:s,event};}
 if(dynamics?.observation&&elapsed>=(P.periodicReviewMs??DYNAMIC_POLICY.periodicReviewMs))return {state:s,event:'DYNAMIC_PERIODIC_REVIEW'};
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
export async function holdStep(st0,{now,price,peak,timeCandidate,softTrigger,dynamics,positionId,generation,answerOf,clock=()=>now},P=HOLD_POLICY){
 let st={...(st0??{})};
 if(st.generation&&generation&&st.generation!==generation)st=initialHoldState(price);
 st.generation=generation??st.generation??String(positionId);
 if(st.pending){
  const pending=st.pending,a=await answerOf(pending.key).catch(()=>null);now=clock();const age=now-pending.at;
  if(a?.state==='DONE'||age>P.timeAnswerWaitMs){
   const completed=a?.completed_at_ms,snapshot=a?.snapshot_at_ms??completed;
   const fresh=Number.isSafeInteger(completed)&&completed>=pending.at&&completed<=now&&now-completed<=P.exitMaxAgeMs&&
    completed-pending.at<=P.timeAnswerWaitMs&&Number.isSafeInteger(snapshot)&&snapshot>=pending.at&&snapshot<=now&&now-snapshot<=P.exitMaxAgeMs;
   const decision=a?.valid===true&&fresh&&!a.refresh_error?a.decision:'ABSTAIN',authority=a?.authority??'GPT_FINAL_ONLY';
   const unapplied=a?.valid===true&&a?.decision&&(!fresh||a.refresh_error);
   const ignored=unapplied?(!fresh?'LATE_RESULT_NOT_APPLIED':'SNAPSHOT_REFRESH_FAILED'):decision==='ABSTAIN'?'INVALID_OR_UNAVAILABLE':null;
   st.technicalFailure=ignored?{at:now,error:a?.error??ignored,jobKey:pending.key,event:pending.event}:null;
   st.last={dynamic_action:a?.dynamic_action??null,failure_detected_at:pending.failure_detected_at??pending.at,failure_to_decision_ms:completed==null?null:completed-(pending.failure_detected_at??pending.at),failure_to_action_ms:ignored?null:now-(pending.failure_detected_at??pending.at),key:pending.key,event:pending.event,decision:unapplied?a.decision:decision,authority,at:now,
     requested_at:pending.at,api_started_at:a?.started_at_ms??null,api_completed_at:completed??null,
     consumer_deadline:pending.at+P.timeAnswerWaitMs,consumer_received:now,applied_at:ignored?null:now,
     expired:!fresh,ignored_reason:ignored,applied_decision:ignored?null:decision};st.pending=null;
   st.softReceipt={key:pending.softKey??softTrigger?.key,price,peak,evidenceKey:dynamics?.evidenceKey??null,at:now};
   if(decision==='EXIT'){
     const emergency=authority==='DEEPSEEK_EMERGENCY_EXIT_ONLY';
     return {close:true,reason:emergency?'FD1_DEEPSEEK_EXIT':'FD1_GPT_EXIT',state:st,approval:{authority,valid:true,decision,
       positionId:String(positionId),generation:st.generation,jobKey:emergency?null:pending.key,
       snapshotHash:a?.snapshot_hash??null,completedAt:completed,snapshotAt:snapshot,refreshError:null}};
   }
   if(decision==='PROTECT'){
    // RAISE_PROTECTION. The reviewer approves the deterministic candidate it actually judged
    // and nothing else: no model-supplied price can become protection, and an approved level
    // can only ever rise. Without a candidate to approve, protection stays exactly as it was.
    const reviewed=Number(pending.softLevel),prior=Number(st.protectLevel)||0,
      approvable=Number.isFinite(reviewed)&&reviewed>0?reviewed:null;
    let approval=null;
    // Only GPT FINAL approves a raise. DeepSeek's emergency authority covers EXIT and HOLD, so
    // when it answers PROTECT the mandated fallback applies: keep the last approved protection.
    if(authority!=='GPT_FINAL_ONLY'){
     approval={verdict:'KEEP_LAST_APPROVED_PROTECTION',provider:'deepseek',authority,
       requested:approvable,standing:prior||null,candidateKey:pending.softKey??null,at:now};
     st.protectDeclined=approval;
    }else if(approvable!==null&&approvable>prior){
     st.protectLevel=approvable;st.protectReason=pending.softReason??softTrigger?.reason??null;
     st.protectApprovedAt=now;st.protectDeclined=null;
     approval={verdict:'APPROVED',level:approvable,reason:st.protectReason,candidateKey:pending.softKey??null,at:now};
    }else{
     approval={verdict:approvable===null?'NO_DETERMINISTIC_CANDIDATE':'NOT_ABOVE_APPROVED',
       requested:approvable,standing:prior||null,candidateKey:pending.softKey??null,at:now};
     st.protectDeclined=approval;
    }
    st.protectUntil=now+P.protectMs;st.holdUntil=timeCandidate?st.protectUntil:st.holdUntil;
    st.protection={mode:'ELEVATED',sensitivityMultiplier:2,intervalMs:P.protectMs,exposureIncrease:false};
    return {close:false,reason:'FD1_GPT_PROTECT',state:st,protectApproval:approval};
   }
   if(decision==='HOLD'){
    if(st.dynamicTracker?.status==='DATA_DEGRADED'||a?.dynamic_state==='DATA_DEGRADED'){
      st.holdUntil=null;st.retryAfter=now+DYNAMIC_POLICY.missingRetryMs;st.softArmed=true;
      return {close:false,reason:'FD1_DATA_DEGRADED_REVIEWED',state:st,
        protectApproval:{verdict:'KEEP_LAST_APPROVED_PROTECTION',standing:Number(st.protectLevel)||null,at:now}};
    }
    // HOLD consumes the candidate. Protection is not raised, and never lowered either.
    if(timeCandidate)st.holdUntil=now+P.holdTtlMs;
    return {close:false,reason:'FD1_GPT_HOLD',state:st,
      protectApproval:{verdict:'HELD',standing:Number(st.protectLevel)||null,
        candidate:Number(pending.softLevel)||null,candidateKey:pending.softKey??null,at:now}};
   }
   // No usable answer (timeout, invalid, ABSTAIN, budget or provider outage): protection is
   // neither raised nor lowered. Hard safety is unaffected and keeps executing on its own.
   const lateCompletion=Number.isSafeInteger(completed)&&completed>=pending.at&&completed<=now&&
     completed-pending.at>P.timeAnswerWaitMs;
   const timeout=isReviewTimeout(a)||lateCompletion||a?.state!=='DONE'&&age>P.timeAnswerWaitMs;
   st.timeoutRetryEvent=timeout?pending.event:null;
   st.retryAfter=now+(timeout||st.dynamicTracker?DYNAMIC_POLICY.missingRetryMs:P.deteriorationMinGapMs);st.softArmed=true;
   return {close:false,reason:unapplied?ignored:age>P.timeAnswerWaitMs?'FD1_FINAL_TIMEOUT':'FD1_FINAL_UNAVAILABLE',state:st,
     protectApproval:{verdict:'KEEP_LAST_APPROVED_PROTECTION',standing:Number(st.protectLevel)||null,
       candidate:Number(pending.softLevel)||null,candidateKey:pending.softKey??null,at:now}};
  }
  return {close:false,reason:'FD1_AWAITING_GPT',state:st};
 }
 const n=nextEvent(st,{now,price,peak,timeCandidate,softTrigger,dynamics},P);st=n.state;
 if(n.exhausted)return {close:false,reason:'FD1_REVIEW_LIMIT',state:st};
 if(n.event){
  st.timeoutRetryEvent=null;
  const key=await hash({v:FD1_HOLD_POLICY_VERSION,positionId:String(positionId),generation:st.generation,event:n.event,at:Math.floor(now/1000)});
  // The exact candidate offered to this review is bound to the claim, so a later PROTECT can
  // only approve the level that was actually judged.
  st.pending={key,event:n.event,at:now,failure_detected_at:dynamics?.failure_detected_at??now,consumer_deadline:now+P.timeAnswerWaitMs,softKey:softTrigger?.key??null,
    softLevel:Number(softTrigger?.level)>0?Number(softTrigger.level):null,softReason:softTrigger?.reason??null};
  st.reviews+=1;st.lastReviewAt=now;st.lastReviewPrice=price;
  return {close:false,reason:'FD1_AWAITING_GPT',state:st,start:{key,event:n.event}};
 }
 return {close:false,reason:st.dynamicTracker?.status==='DATA_DEGRADED'?'FD1_DATA_DEGRADED_PENDING_REVIEW':timeCandidate&&st.holdUntil&&now<st.holdUntil?'FD1_GPT_HOLD':null,state:st};
}
export function refreshExitContext(c,book,at){
 if(!c)return null;
 const bid=Number(book?.bids?.[0]?.[0]),entry=Number(c.entry_price),peak=Math.max(Number(c.peak??entry),bid);
 if(!(bid>0&&entry>0))throw Error('LIVE_POSITION_QUOTE_UNAVAILABLE');
 const crossed=level=>Number.isFinite(Number(level))&&Number(level)>0&&bid<=Number(level);
 return {...c,snapshot_at_ms:at,current_price:bid,peak,mfe:peak/entry-1,
  mae:Math.min(c.mae??0,bid/entry-1),mfe_giveback:peak>entry?(peak-bid)/(peak-entry):0,drawdown:bid/peak-1,
  ...(c.protection?{protection:{...c.protection,
   approved_crossed:crossed(c.protection.approved_soft_stop),
   candidate_crossed:crossed(c.protection.candidate_soft_stop)}}:{}),
  hard_hit:bid<=c.hard_floor,soft_trigger:c.soft_trigger?{...c.soft_trigger,
   distance:c.soft_trigger.level?bid/c.soft_trigger.level-1:null,crossed:crossed(c.soft_trigger.level)}:null};
}
/** Build and ask one HOLD review from live public data. Never throws. */
export async function runHoldReview({position,event,timeCandidate,stopStage,exitContext=null,apiKey,deepseekKey,fetchFn=fetch,now=Date.now,onPacket,dynamicState=null}){
  try{
    const asOf=now(),{src,errors}=await readSources(String(position.symbol).toUpperCase(),asOf,{mode:'LIVE',fetchFn,ms:2500,now,positionId:position.capturePositionId??null,deadlineMs:asOf+8000});
    const f=position.entryFeatures??{},snapshotAt=now();
    const facts=computeFacts(src,{asOf:snapshotAt,referenceClose:f.referenceClose,dayReturn:f.dayReturn,rank:f.rank,
      position:{entryPrice:position.entryPrice,peakPrice:position.peakPrice,entryAt:position.entryAt,lastHighAt:position.lastHighAt,
        stopPrice:position.stopPrice,requireLiveQuote:true}});
    if(!Number.isFinite(facts.values.position_return))throw Error('LIVE_POSITION_QUOTE_UNAVAILABLE');
    const packet=await buildDecisionPacket({task:'HOLD',subjectId:String(position.id)+':'+event+':'+asOf,symbol:position.symbol,dataMode:'LIVE',
      facts,judgments:modelJudgments(f),position:{event,positionId:position.id,generation:position.generation,exitContext:refreshExitContext(exitContext,src.book,snapshotAt),deterministicExitCandidate:timeCandidate??null,stopStage:stopStage??null,
        valuation:{basis:'EXECUTABLE_BID',snapshot_at_ms:snapshotAt,quote_at_ms:Number(src.book.T??src.book.E),
          candle_close_at_ms:facts.quality.last_close_at_ms}}});
    packet.dynamic_policy=DYNAMIC_VERSION;packet.dynamic_as_of_ms=snapshotAt;
    if(f.leader20||position.leader20)packet.leader20=structuredClone(f.leader20??position.leader20);
    packet.position.dynamic_continuity={historical_reference_only:true,
      entry:compactDynamic(position.entryCapture,{fullPath:true}),final_recheck:compactDynamic(position.finalCapture,{fullPath:true}),
      entry_to_current:dynamicDelta(position.entryCapture,facts.capture_context),
      final_to_current:dynamicDelta(position.finalCapture,facts.capture_context)};
    let tracker=positionDynamicState(dynamicState,facts.capture_context,{at:snapshotAt,bid:Number(src.book?.bids?.[0]?.[0]),
      entry:position.entryPrice,generation:position.generation,positionId:position.id,emergency:dynamicState?.emergency_packet});
    if(tracker.status==='DATA_DEGRADED')tracker={...tracker,emergency_packet:await emergencyDynamicPacket(position.symbol,{fetchFn,now})};
    packet.dynamic_data_state={status:tracker.status,confidence:tracker.confidence,
      last_valid_age_ms:tracker.last_valid_age_ms,drift_from_last_valid:tracker.drift_from_last_valid,
      emergency_packet:tracker.emergency_packet,exposure_increase_allowed:false};
    packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
    // Observers are detached: no observer rejection or latency changes the GPT decision.
    if(onPacket)Promise.resolve().then(()=>onPacket(packet,snapshotAt)).catch(()=>{});
    const fast=!['DYNAMIC_PERIODIC_REVIEW','PROTECTION_REASSESSMENT'].includes(event)&&!event.startsWith('TIME_EXIT_CANDIDATE:');
    const result=await dualEntryDecision(packet,{apiKey,deepseekKey,fetchFn,now,reviewTier:fast?'FAST':'FULL',
      deadlineMs:Math.min(asOf+HOLD_POLICY.timeAnswerWaitMs-1000,snapshotAt+(fast?DYNAMIC_POLICY.fastReviewMs:HOLD_POLICY.timeAnswerWaitMs-1000)),snapshotAtMs:snapshotAt,
      refreshPacket:fast?null:async ms=>{
        const at=now(),fresh=await readSources(String(position.symbol).toUpperCase(),at,{mode:'LIVE',fetchFn,ms,now,positionId:position.capturePositionId??null}),captured=now();
        const nextFacts=computeFacts(fresh.src,{asOf:captured,referenceClose:f.referenceClose,dayReturn:f.dayReturn,rank:f.rank,position:{entryPrice:position.entryPrice,peakPrice:position.peakPrice,entryAt:position.entryAt,lastHighAt:position.lastHighAt,stopPrice:position.stopPrice,requireLiveQuote:true}});
        if(!Number.isFinite(nextFacts.values.position_return))throw Error('LATEST_QUOTE_UNAVAILABLE');
        const next={...packet,facts:nextFacts,dynamic_as_of_ms:captured,position:{...packet.position,exit_context:exitContext?{...refreshExitContext(exitContext,fresh.src.book,captured),latest_refresh:true}:null,valuation:{...packet.position.valuation,snapshot_at_ms:captured,quote_at_ms:Number(fresh.src.book?.T??fresh.src.book?.E)}}};
        next.snapshot_hash=await hash({...next,snapshot_hash:''});return {packet:next,captured};
      }});
    return {packet:result.final_packet??packet,result:{...result,source_errors:errors,model:MODEL,contract:FD_VERSION}};
  }catch(e){
    return {packet:null,result:{decision:'ABSTAIN',valid:false,attempted:false,api_cost_usd:0,error:'FD_HOLD_PREP:'+String(e?.message??e).slice(0,80),completed_at_ms:now()}};
  }
}
export const _test={MIN};
