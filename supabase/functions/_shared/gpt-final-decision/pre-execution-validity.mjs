import {callDecision,MODEL} from './api.mjs';
import {entryCaptureSafety,dynamicDelta,HORIZONS} from './dynamic-flow.mjs';
import {bookReference,RECHECK_POLICY} from './recheck.mjs';

export const PRE_EXECUTION_VALIDITY_VERSION='PRE_EXECUTION_VALIDITY_1';
export const VALIDITY_RESULT=Object.freeze({VALID:'VALID',UNCERTAIN:'UNCERTAIN',INVALID:'INVALID'});
const finite=Number.isFinite;
const number=x=>x!==null&&x!==undefined&&x!==''&&finite(Number(x))?Number(x):null;
const rel=(current,base)=>current!==null&&base!==null&&base>0?(current/base-1):null;
const delta=(current,base)=>current!==null&&base!==null?current-base:null;
const unique=xs=>[...new Set(xs)];
const round=x=>x===null||x===undefined?null:Number(Number(x).toPrecision(8));
const last=c=>Array.isArray(c?.trajectory)&&c.trajectory.length?c.trajectory.at(-1):null;
const horizons=c=>Object.fromEntries(HORIZONS.map(s=>['s'+s,c?.dynamics?.horizons?.['s'+s]??null]));

function weakeningAxes(c){
  const h=c?.dynamics?.horizons??{},s5=h.s5,s15=h.s15,axes=[];
  if(s5&&s15&&s5.return<0&&s15.return<0)axes.push('PRICE');
  if(s5&&s15&&s5.net_taker_flow<0&&s15.net_taker_flow<0&&s15.buy_share<.5)axes.push('FLOW');
  if(s15&&s15.bid_liquidity_change<0&&(s15.ask_liquidity_change>0||s15.imbalance<0))axes.push('BOOK');
  if(s15&&s15.high_renewal_slowdown>0&&
    (s15.arrival_rate_slope<0||number(s15.sampled_high_renewals)===0))axes.push('PARTICIPATION');
  return axes;
}

function currentMetrics(c,quote){
  const point=last(c),book=bookReference(quote),h=horizons(c);
  return {mid:book?.mid??number(point?.mid),spread_bps:book?.facts?.spread_bps??number(point?.spread_bps),
    slippage_bps:book?.facts?.est_buy_slippage_bps??number(point?.buy_impact_450_bps),
    bid_depth_25_usdt:book?.facts?.bid_depth_25bps_usdt??number(point?.bid_depth_25_usdt),
    ask_depth_25_usdt:book?.facts?.ask_depth_25bps_usdt??number(point?.ask_depth_25_usdt),
    imbalance:book?.facts?.book_imbalance_25bps??number(point?.imbalance),
    buy_share_5s:number(point?.buy_share_5s),net_taker_flow_5s:number(point?.net_taker_quote_5s),
    trade_count_5s:number(point?.trade_count),arrival_rate_5s:number(point?.arrival_rate),
    btc_return_1m:number(point?.btc_return_1m),horizons:h};
}

/** Pure, deterministic freshness/change classifier. It does not invent an entry score.
 * Existing dynamic-change, quote, spread/slippage and multi-axis failure semantics are
 * combined into VALID / UNCERTAIN / INVALID. A single weak axis or elapsed time is never
 * INVALID. */
export function classifyPreExecutionValidity({ticket,latestCapture,quote,at=Date.now(),referenceCapture=null,
  executionSafety=null}={}){
  const initial=ticket?.initial??{},original=initial.capture_context,reference=referenceCapture??original,
    originalFacts=initial.facts??{},latestSafety=entryCaptureSafety(latestCapture,at),
    originalSafety=entryCaptureSafety(original,at),referenceSafety=entryCaptureSafety(reference,at),
    originalMetrics=currentMetrics(original,null),current=currentMetrics(latestCapture,quote),
    originalMid=number(initial.executionRef?.mid)??number(originalMetrics.mid),referenceMid=reference===original?
      originalMid:number(last(reference)?.mid),currentMid=number(current.mid),
    originalEnd=number(original?.end_ms),latestEnd=number(latestCapture?.end_ms),
    newest=new Set((latestCapture?.trajectory??[]).map(x=>x?.bucket_ms).filter(Number.isSafeInteger)),
    old=new Set((original?.trajectory??[]).map(x=>x?.bucket_ms).filter(Number.isSafeInteger)),
    newBuckets=[...newest].filter(x=>!old.has(x)).length,
    priceDrift=rel(currentMid,originalMid),validationPriceDrift=rel(currentMid,referenceMid),
    spreadDelta=delta(number(current.spread_bps),number(originalFacts.spread_bps)??number(originalMetrics.spread_bps)),
    slippageDelta=delta(number(current.slippage_bps),number(originalFacts.est_buy_slippage_bps)??number(originalMetrics.slippage_bps)),
    referenceMetrics=currentMetrics(reference,null),
    bidDepthDelta=rel(number(current.bid_depth_25_usdt),number(originalFacts.bid_depth_25bps_usdt)??number(originalMetrics.bid_depth_25_usdt)),
    askDepthDelta=rel(number(current.ask_depth_25_usdt),number(originalFacts.ask_depth_25bps_usdt)??number(originalMetrics.ask_depth_25_usdt)),
    imbalanceDelta=delta(number(current.imbalance),number(originalFacts.book_imbalance_25bps)??number(originalMetrics.imbalance)),
    gateSpreadDelta=reference===original?spreadDelta:delta(number(current.spread_bps),number(referenceMetrics.spread_bps)),
    gateSlippageDelta=reference===original?slippageDelta:delta(number(current.slippage_bps),number(referenceMetrics.slippage_bps)),
    gateBidDepthDelta=reference===original?bidDepthDelta:rel(number(current.bid_depth_25_usdt),number(referenceMetrics.bid_depth_25_usdt)),
    gateAskDepthDelta=reference===original?askDepthDelta:rel(number(current.ask_depth_25_usdt),number(referenceMetrics.ask_depth_25_usdt)),
    gateImbalanceDelta=reference===original?imbalanceDelta:delta(number(current.imbalance),number(referenceMetrics.imbalance)),
    dynamic=dynamicDelta(reference,latestCapture),axes=weakeningAxes(latestCapture),reasons=[];
  let result=VALIDITY_RESULT.VALID;
  const dataProblem=reason=>{result=VALIDITY_RESULT.UNCERTAIN;reasons.push(reason);};
  if(!latestSafety.ok)dataProblem(latestSafety.reason);
  // The clock validator permits its original fixed window until T+120. Execution validity
  // needs the latest rolling window, so an old fixed capture is not accepted as "fresh".
  if(latestEnd===null||at-latestEnd<0||at-latestEnd>=RECHECK_POLICY.answerMaxAgeMs+2000)
    dataProblem('LATEST_TRAJECTORY_NOT_FRESH');
  if(!originalSafety.ok)reasons.push('ORIGINAL_TRAJECTORY_AGED');
  // An approved reference is intentionally historical; only the newly acquired capture
  // must be fresh. Its structural status is retained in telemetry, never used as a pass.
  if(currentMid===null)dataProblem('CURRENT_PRICE_MISSING');
  if(number(current.spread_bps)===null||number(current.slippage_bps)===null||
    number(current.bid_depth_25_usdt)===null||number(current.ask_depth_25_usdt)===null||number(current.imbalance)===null)
    dataProblem('CURRENT_BOOK_METRICS_INCOMPLETE');
  if(executionSafety?.ok===false){result=VALIDITY_RESULT.INVALID;reasons.push(executionSafety.reason);}
  if(number(current.spread_bps)>RECHECK_POLICY.catastrophicSpreadBps){
    result=VALIDITY_RESULT.INVALID;reasons.push('SPREAD_CATASTROPHIC');
  }
  if(result!==VALIDITY_RESULT.INVALID&&latestSafety.ok){
    if(dynamic.review){result=VALIDITY_RESULT.UNCERTAIN;reasons.push(...dynamic.reasons);}
    if(validationPriceDrift!==null&&validationPriceDrift<=RECHECK_POLICY.priceAdverse){result=VALIDITY_RESULT.UNCERTAIN;reasons.push('PRICE_ADVERSE');}
    if(validationPriceDrift!==null&&validationPriceDrift>=RECHECK_POLICY.priceChase){result=VALIDITY_RESULT.UNCERTAIN;reasons.push('PRICE_CHASE');}
    if(gateSpreadDelta!==null&&gateSpreadDelta>=RECHECK_POLICY.spreadWidenBps){result=VALIDITY_RESULT.UNCERTAIN;reasons.push('SPREAD_WIDENED');}
    if(gateSlippageDelta!==null&&gateSlippageDelta>=RECHECK_POLICY.slippageWorsenBps){result=VALIDITY_RESULT.UNCERTAIN;reasons.push('SLIPPAGE_WORSENED');}
    if((gateBidDepthDelta!==null&&gateBidDepthDelta<=RECHECK_POLICY.depthDropFraction)||
      (gateAskDepthDelta!==null&&gateAskDepthDelta<=RECHECK_POLICY.depthDropFraction)){
      result=VALIDITY_RESULT.UNCERTAIN;reasons.push('DEPTH_DROPPED');
    }
    if(gateImbalanceDelta!==null&&gateImbalanceDelta<=RECHECK_POLICY.imbalanceShift){
      result=VALIDITY_RESULT.UNCERTAIN;reasons.push('IMBALANCE_SHIFTED');
    }
    // Clear invalidity reuses the existing early-failure axes. It requires simultaneous
    // PRICE + FLOW failure and either adverse drift or a third independent weak axis.
    // No score is introduced and no single signal can cancel an otherwise live BUY.
    const clearReversal=axes.includes('PRICE')&&axes.includes('FLOW')&&
      ((validationPriceDrift!==null&&validationPriceDrift<=RECHECK_POLICY.priceAdverse)||axes.length>=3);
    if(clearReversal){result=VALIDITY_RESULT.INVALID;reasons.push('CLEAR_MULTI_AXIS_REVERSAL');}
  }
  const triggerDistance=number(originalFacts.distance_trigger_reference),triggerReference=triggerDistance!==null&&originalMid!==null?
    originalMid/(1+triggerDistance):null;
  return {version:PRE_EXECUTION_VALIDITY_VERSION,result,reasons:unique(reasons),checked_at_ms:at,
    original_snapshot_at:initial.snapshotAt??originalEnd??null,latest_snapshot_at:latestEnd,
    gpt_buy_completed_at:initial.completedAt??ticket?.clockFinalAuthority?.completed_at_ms??null,
    decision_age_ms:number(initial.completedAt??ticket?.clockFinalAuthority?.completed_at_ms)===null?null:
      at-number(initial.completedAt??ticket?.clockFinalAuthority?.completed_at_ms),
    new_buckets_since_buy:newBuckets,price_drift_bps:priceDrift===null?null:priceDrift*10000,
    validation_price_drift_bps:validationPriceDrift===null?null:validationPriceDrift*10000,
    spread_delta_bps:spreadDelta,slippage_delta_bps:slippageDelta,
    bid_depth_delta_fraction:bidDepthDelta,ask_depth_delta_fraction:askDepthDelta,imbalance_delta:imbalanceDelta,
    trigger_reference:triggerReference,trigger_reference_maintained:triggerReference===null||currentMid===null?null:currentMid>=triggerReference,
    original_buy:{summary:initial.summary??null,support:initial.support??[],decision_reason:initial.decision_reason??null,
      pressure_state:initial.pressure_state??null,counter_evidence:initial.counter_evidence??[],
      thesis_invalidation:initial.thesis_invalidation??null,next_review_conditions:initial.next_review_conditions??null},
    current:{...current,local_high_renewed:HORIZONS.some(s=>number(current.horizons?.['s'+s]?.sampled_high_renewals)>0),
      high_renewal_slowdown:Object.fromEntries(HORIZONS.map(s=>['s'+s,number(current.horizons?.['s'+s]?.high_renewal_slowdown)]))},
    weakening_axes:axes,dynamic_change:dynamic,latest_capture_hash:latestCapture?.trajectory_hash??null,
    reference_capture_hash:reference?.trajectory_hash??null,latest_capture:latestCapture??null,
    data_safety:{latest:latestSafety,original:originalSafety,reference:referenceSafety},execution_safety:executionSafety??null};
}

/** No raw buckets are included: only the original thesis and original -> current deltas. */
export function preExecutionDeltaPacket(validity,{signalId,symbol,sequence=1}={}){
  const h=validity?.current?.horizons??{};
  return {version:PRE_EXECUTION_VALIDITY_VERSION,task:'PRE_EXECUTION_DELTA_RECHECK',candidate_id:String(signalId),
    symbol:String(symbol).toUpperCase(),sequence,original_buy:validity.original_buy,
    original_snapshot_at:validity.original_snapshot_at,current_snapshot_at:validity.latest_snapshot_at,
    elapsed_ms:validity.decision_age_ms,new_buckets_since_buy:validity.new_buckets_since_buy,
    delta:{price_drift_bps:round(validity.price_drift_bps),spread_delta_bps:round(validity.spread_delta_bps),
      slippage_delta_bps:round(validity.slippage_delta_bps),bid_depth_delta_fraction:round(validity.bid_depth_delta_fraction),
      ask_depth_delta_fraction:round(validity.ask_depth_delta_fraction),imbalance_delta:round(validity.imbalance_delta)},
    current:{horizons:Object.fromEntries(HORIZONS.map(s=>['s'+s,h['s'+s]??null])),
      buy_share_5s:validity.current?.buy_share_5s??null,net_taker_flow_5s:validity.current?.net_taker_flow_5s??null,
      trade_count_5s:validity.current?.trade_count_5s??null,arrival_rate_5s:validity.current?.arrival_rate_5s??null,
      btc_return_1m:validity.current?.btc_return_1m??null,local_high_renewed:validity.current?.local_high_renewed??null,
      high_renewal_slowdown:validity.current?.high_renewal_slowdown??null,
      trigger_reference_maintained:validity.trigger_reference_maintained},
    local_change_reasons:validity.reasons,weakening_axes:validity.weakening_axes};
}

const deltaSchema={type:'object',properties:{decision:{type:'string',enum:['KEEP_BUY','CANCEL_BUY']},
  reason:{type:'string',minLength:1,maxLength:180}},required:['decision','reason'],additionalProperties:false};
export function preExecutionDeltaPayload(packet){
  return {model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',prompt_cache_key:'boo-pre-execution-delta',
    reasoning:{effort:'none'},max_output_tokens:160,input:[{role:'system',content:`You are the final strategic reviewer for Trading Boo, a long-only Binance USDT perpetual-futures system.
The original GPT BUY was conditional on its snapshot. Review only the supplied original thesis and original-to-current delta. No raw 24-bucket path is repeated.
Return KEEP_BUY only when the original upside thesis still survives in the latest price, 5/15/30/60/120-second flow, book, participation, BTC context, trigger position and high-renewal evidence. Return CANCEL_BUY when it no longer survives or the evidence cannot safely confirm it.
Elapsed time, one weak bucket, a high return, or volatility alone is not a cancellation reason. Multiple independent weakening axes, an explicit thesis invalidation, reversal, flow collapse, or material execution deterioration may cancel. Do not change entry strategy, sizing, leverage, slots, stops, or risk parameters. GPT alone makes this final delta decision.`},
      {role:'user',content:JSON.stringify(packet)}],
    text:{verbosity:'low',format:{type:'json_schema',name:'pre_execution_delta_recheck',strict:true,schema:deltaSchema}}};
}
export function validatePreExecutionDelta(wire,packet){
  if(!wire||!['KEEP_BUY','CANCEL_BUY'].includes(wire.decision)||typeof wire.reason!=='string'||
    !wire.reason.trim()||wire.reason.length>180)throw Error('FD_PRE_EXECUTION_DELTA_INVALID');
  return {version:PRE_EXECUTION_VALIDITY_VERSION,decision:wire.decision,reason:wire.reason.trim(),
    packet_version:packet.version};
}
export async function callPreExecutionDelta(packet,options={}){
  return callDecision(packet,{...options,payloadFn:preExecutionDeltaPayload,validate:validatePreExecutionDelta});
}
