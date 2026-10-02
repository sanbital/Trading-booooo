/** GPT FINAL RECHECK inside the executor's entry path (openBull), between E1 and the final
 * dispatch block. GPT remains the final decision maker; this adapter only
 *  1. builds the PRE-DISPATCH snapshot from data already in hand (E1 tape + E1 quote),
 *  2. runs the change detector against the INITIAL BUY ticket,
 *  3. if (and only if) it triggered, asks GPT once more (journal + shared budget ledger),
 *  4. records the outcome (evidence only; a logging failure never changes a decision).
 * Fail closed: when a recheck is required, only a valid unexpired FINAL BUY continues. */
import {detectChange,preDispatchSnapshot,runFinalRecheck,recheckAllows,postRecheckSafety,initialContext,
  RECHECK_POLICY,RECHECK_VERSION,AGED_REASON} from '../_shared/gpt-final-decision/recheck.mjs';
import {computeFacts} from '../_shared/gpt-final-decision/facts.mjs';
import {readSources} from '../_shared/gpt-final-decision/market.mjs';
import {readCaptureWithRecovery} from '../_shared/gpt-final-decision/capture-context.mjs';
import {entryCaptureSafety,dispatchDynamicSafety,DYNAMIC_VERSION} from '../_shared/gpt-final-decision/dynamic-flow.mjs';
import {SupabaseReviewStore,readReviewControl} from '../_shared/gpt-final-review/supabase-store.mjs';
import {configFromControl} from '../_shared/gpt-final-review/coordinator.mjs';
import {gptRecheckConfig} from './gpt-final-review-adapter.mjs';
import {nilTicket,NIL_E1,NIL_DISPATCH_QUOTE,NIL_SIGNAL,NIL_DISPATCH_AT} from './recheck-nil-fixture.mjs';
import {resumeReviewTimeouts} from '../_shared/gpt-final-decision/timeout-recovery.mjs';
import {isLeader20,leaderIdentity} from '../_shared/leader20/campaign.mjs';
import {CLOCK_FINAL,clockExecutionSafety,clockTicketCheck} from '../_shared/leader20/clock-final.mjs';
import {sameClockCapture} from '../_shared/leader20/clock.mjs';
import {hash} from '../_shared/gpt-final-decision/api.mjs';
import {PRE_EXECUTION_VALIDITY_VERSION,VALIDITY_RESULT,classifyPreExecutionValidity,preExecutionDeltaPacket,
  callPreExecutionDelta} from '../_shared/gpt-final-decision/pre-execution-validity.mjs';
export {RECHECK_VERSION,postRecheckSafety};
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
// The compact clock delta request is intentionally independent of the legacy 4 s
// final-recheck timeout. Production GPT latency commonly exceeds 4 s; starting a
// request without this full budget only manufactures timeouts and burns authority.
const CLOCK_DELTA_TIMEOUT_MS=12000;
const CLOCK_DELTA_EXECUTION_RESERVE_MS=5000;
const clockTraces=new WeakMap();
/** A parsed GPT CANCEL_BUY is a final decision for this immutable BUY generation.
 * The adapter stores `valid=false` because CANCEL grants no order authority, so the
 * positive proof is the parsed answer plus a completed, error-free provider call. */
export function definitiveClockCancel(record){
 const f=record?.final;
 return record?.clock_final_authority!=null&&f?.attempted===true&&f?.error==null&&
  f?.decision==='CANCEL_BUY'&&f?.answer?.decision==='CANCEL_BUY';
}
export function clockExecutionTrace(ticket){
 if(!clockTraces.has(ticket))clockTraces.set(ticket,{gpt_completed_at:ticket.clockFinalAuthority?.completed_at_ms,
  gpt_buy_completed_at:ticket.clockFinalAuthority?.completed_at_ms,
  pre_execution_check_at:null,pre_execution_check_latency_ms:null,decision_age_ms:null,original_snapshot_at:ticket.initial?.snapshotAt??null,
  latest_snapshot_at:null,new_buckets_since_buy:null,price_drift_bps:null,spread_delta_bps:null,
  slippage_delta_bps:null,validity_result:null,validity_reasons:[],gpt_recheck_attempted:false,
  gpt_recheck_result:'NOT_ATTEMPTED',gpt_recheck_latency_ms:null,order_sent_at:null,fill_at:null,
  old_quote_used:false,quote_refresh_attempts:0,quote_requests:0});
 return clockTraces.get(ticket);
}
let testHooks=null;
/** Test-only dependency injection (store, config, apiKey, fetchFn, log). */
export function setRecheckTestHooks(h){testHooks=h;}
function schedule(p){const t=p.catch(e=>console.error('FD1_RECHECK_LOG_FAILED',String(e?.message??e).slice(0,200)));
  if(testHooks?.schedule)testHooks.schedule(t);else if(globalThis.EdgeRuntime?.waitUntil)EdgeRuntime.waitUntil(t);}
/** Evidence row for every candidate that reached the detector (ordered, skipped or not). */
function logRow(db,s,record,outcome){
  const row={signal_id:String(s.id),symbol:String(s.symbol).toUpperCase(),policy_version:RECHECK_VERSION,
    recheck_sequence:record.recheck_sequence??1,initial_gpt_decision:record.initial_gpt_decision,initial_gpt_at:ms(record.initial_gpt_at),initial_snapshot_at:ms(record.initial_snapshot_at),
    initial_snapshot_hash:record.initial_snapshot_hash??null,initial_context:record.initial_context??null,
    pre_dispatch_at:ms(record.pre_dispatch_at),pre_dispatch_snapshot:record.pre_dispatch_snapshot,
    recheck_triggered:record.recheck_triggered,recheck_reasons:record.recheck_reasons,deltas:record.deltas,
    final_gpt_decision:record.final_gpt_decision,final_gpt_at:ms(record.final_gpt_at),final_error:record.final?.error??null,
    final_job_key:record.final?.job_key??null,final_latency_ms:record.final?.latency_ms??null,final_cost_usd:record.final?.api_cost_usd??null,
    final_answer:{...(record.final?.answer??{}),arbitration:record.final?.arbitration??null,dynamic_audit:record.final?.dynamic_audit??null,
      capture_safety:record.capture_safety??null,decision:record.final_gpt_decision==='BUY'?'BUY_NOW':record.final_gpt_decision},outcome,counterfactual_entry_price:record.pre_dispatch_snapshot?.ask??null};
  if(testHooks?.log){testHooks.log.push(row);return;}
  schedule((async()=>{const r=await db.from('fd1_final_recheck_log').insert(row);if(r.error)throw Error(r.error.message);})());
}
const ms=x=>Number.isFinite(Number(x))&&x!==null?new Date(Number(x)).toISOString():null;
/** Mark a logged candidate's outcome after the post-recheck safety (evidence only). */
export function markRecheckOutcome(db,s,record,outcome){
  if(record?.clock_final_authority)return; // Clock execution is audited on the entry/order path, never as another AI review.
  if(testHooks?.log){const r=testHooks.log.findLast(x=>x.signal_id===String(s.id));if(r)r.outcome=outcome;return;}
  schedule((async()=>{const r=await db.from('fd1_final_recheck_log').update({outcome}).eq('signal_id',String(s.id))
    .eq('initial_snapshot_hash',record.initial_snapshot_hash??'').eq('recheck_sequence',record.recheck_sequence??1);
    if(r.error)throw Error(r.error.message);})());
}
/** Clock BUY must acquire a latest rolling path; legacy execution keeps its existing read. */
export function executionCapture(ticket,symbol,at,options={}){
  return (testHooks?.capture??readCaptureWithRecovery)(symbol,at,
    {...options,...(ticket?.clockFinalAuthority?{requireRollingFresh:true}:{})});
}
export function executionDynamicSafety(s,ticket,record,at){
  if(!ticket?.clockFinalAuthority)return dispatchDynamicSafety({reviewed:record?.final?.capture_context??ticket?.initial?.capture_context,
    latest:record?.dispatch_capture,at});
  const safety=clockExecutionSafety(ticket,leaderIdentity(s),record?.dispatch_quote,at);if(!safety.ok)return safety;
  const v=record?.pre_execution_validity;
  if(!v||v.result===VALIDITY_RESULT.INVALID)return {ok:false,reason:'PRE_EXECUTION_VALIDITY_MISSING_OR_INVALID'};
  if(v.result===VALIDITY_RESULT.UNCERTAIN&&record?.gpt_recheck_result!=='KEEP_BUY')
    return {ok:false,reason:'PRE_EXECUTION_GPT_CONFIRMATION_MISSING'};
  if(v.latest_capture_hash!==record?.dispatch_capture?.trajectory_hash)
    return {ok:false,reason:'PRE_EXECUTION_CAPTURE_MISMATCH'};
  return {...safety,validity_result:v.result,validity_reasons:v.reasons};
}
/** Final venue boundary: intent/lease I/O is already complete. Re-read both the quote and
 * rolling 24-bucket trajectory. An old BUY or earlier local check is never inherited. */
export async function authorizeClockExecution(db,s,ticket,record,readQuote,authorize,{now=Date.now,allowReview=true}={}){
  const sequence=Math.min(2,record?.gpt_recheck_attempted===true?2:record?.recheck_sequence??1),
    step=await clockExecutionStep(db,s,ticket,readQuote,{now,sequence,priorRecord:record,allowReview});
  Object.assign(record,step.record);
  if(!step.proceed)return {allowed:false,reason:step.reason};
  const checked=authorize();
  const safety=record.execution_safety,quote=record.dispatch_quote,at=record.pre_execution_check_at;
  return {...checked,clock_execution_safety:{...safety,checked_at_ms:at,received_at_ms:quote.timing.received_at_ms,
    bid:quote.best_bid,ask:quote.best_ask,slot_ms:ticket.clockFinalAuthority.slot_ms,
    expires_at_ms:ticket.clockFinalAuthority.expires_at_ms,validity_result:record.validity_result,
    validity_reasons:record.validity_reasons,telemetry:{...clockExecutionTrace(ticket)}}};
}
/** Quote refresh is not an order retry: no provider/capture/order call occurs here.
 * Only an actually stale gateway response is refreshed, at most once per boundary. */
export async function readClockExecutionQuote(s,ticket,readQuote,{now=Date.now}={}){
 const t=clockExecutionTrace(ticket);
 const identity=leaderIdentity(s);
 let quote=null,safety,at=now();
 for(let attempt=0;attempt<2;attempt++){
  if(attempt&&t.quote_refresh_attempts>=2)break; // At most two refreshes across this execution attempt.
  at=now();safety=clockTicketCheck(ticket,identity,at);if(!safety.ok)break;
  t.fresh_quote_requested_at=at;t.quote_requests++;if(attempt)t.quote_refresh_attempts++;
  try{quote=await readQuote(Math.max(1,Math.min(3000,ticket.expires-at)));}
  catch{safety={ok:false,reason:'CLOCK_EXECUTION_QUOTE_UNAVAILABLE'};break;}
  at=now();safety=clockExecutionSafety(ticket,identity,quote,at);
  const received=quote?.timing?.received_at_ms;
  t.fresh_quote_received_at=Number.isSafeInteger(received)?received:null;
  t.quote_age_ms=Number.isSafeInteger(received)?at-received:null;
  t.quote_after_gpt_ms=Number.isSafeInteger(received)?received-t.gpt_buy_completed_at:null;
  if(safety.reason!=='CLOCK_EXECUTION_QUOTE_STALE')break;
 }
 if(now()>=ticket.expires)safety={ok:false,reason:'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION'};
 t.clock_safety_result=safety.ok?'PASS':safety.reason;
 if(!safety.ok)t.execution_failure_reason??=safety.reason;
 return {quote,safety,at};
}
function clockDeltaAuthorized(config,apiKey){return config?.mode==='ENFORCE'&&config.modeValid!==false&&
 config.enforceApproved===true&&String(config.approvalRef??'').length>0&&config.apiBudgetUsd>=.1&&
 Number.isInteger(config.maxCalls)&&config.maxCalls>0&&!!apiKey;}
async function runClockDeltaRecheck(db,s,ticket,validity,{now=Date.now,sequence=1,purpose='PRODUCTION'}={}){
 const apiKey=testHooks?.apiKey??getenv('OPENAI_API_KEY'),config=testHooks?.config??gptRecheckConfig(db),
  store=testHooks?.store??new SupabaseReviewStore(db),deadline=ticket.expires-CLOCK_DELTA_EXECUTION_RESERVE_MS,
  base={decision:'CANCEL_BUY',valid:false,error:null,attempted:false,latency_ms:null,job_key:null,
   completed_at_ms:now(),valid_until_ms:null,capture_context:validity.latest_capture,current_ref:{mid:validity.current?.mid??null,at:validity.checked_at_ms}};
 if(!clockDeltaAuthorized(config,apiKey))return {...base,error:'RC_NOT_AUTHORIZED'};
 if(!Number.isInteger(sequence)||sequence<1||sequence>RECHECK_POLICY.maxRechecksPerCandidate)
  return {...base,error:'RC_LIMIT_REACHED'};
 const available=deadline-now();
 if(available<CLOCK_DELTA_TIMEOUT_MS)return {...base,error:'EXECUTION_WINDOW_INSUFFICIENT'};
 const identity={signal_id:String(s.id),symbol:String(s.symbol).toUpperCase(),kind:'FD1_FINAL_RECHECK',
  recheck_sequence:sequence,initial_snapshot_hash:String(ticket.snapshotHash),latest_capture_hash:validity.latest_capture_hash,
  trigger_at_ms:Number(s.features?.v17Setup?.triggerAt??s.features?.leader20?.entry_window?.slot_ms)};
 const key=await hash({version:PRE_EXECUTION_VALIDITY_VERSION,identity,purpose}),packet=preExecutionDeltaPacket(validity,
  {signalId:s.id,symbol:s.symbol,sequence}),record={version:PRE_EXECUTION_VALIDITY_VERSION,kind:'FD1_FINAL_RECHECK',purpose,
   recheck_sequence:sequence,api_approval_ref:config.approvalRef,reserved_usd:.1,expires_at_ms:deadline,
   source_commit:PRE_EXECUTION_VALIDITY_VERSION,identity,packet,result:null};
 let claimed,owner;
 try{claimed=await store.claim(key,record,config);if(!claimed.created){const prior=claimed.row?.record?.result;
   if(claimed.row?.state==='DONE'&&prior?.valid===true&&prior?.decision==='KEEP_BUY')return {...base,...prior,
    job_key:key,capture_context:validity.latest_capture,current_ref:base.current_ref};
   return {...base,error:'RC_LIMIT_REACHED',job_key:key};}owner=claimed.row.owner;
   if(store.snapshot)await store.snapshot(key,owner,record);
 }catch(error){return {...base,error:/API_BUDGET_EXHAUSTED/.test(String(error?.message??error))?
   'RC_BUDGET_EXHAUSTED':'RC_CLAIM_FAILED',job_key:key};}
 let result;
 try{const paidFetch=store.transport?await store.transport(key,record,testHooks?.fetchFn??fetch):testHooks?.fetchFn??fetch,
   remaining=Math.min(CLOCK_DELTA_TIMEOUT_MS,deadline-now());
  result=await callPreExecutionDelta(packet,{apiKey,fetchFn:paidFetch,now,timeoutMs:remaining});
 }catch{result={valid:false,decision:'CANCEL_BUY',error:'RC_ADAPTER_ERROR',attempted:false,api_cost_usd:0,
   completed_at_ms:now(),latency_ms:0};}
 const completed=result.completed_at_ms??now(),valid=result.valid===true&&result.decision==='KEEP_BUY'&&completed<deadline,
  stored={...result,decision:result.valid===true?result.decision:'CANCEL_BUY',valid,valid_until_ms:valid?
   Math.min(deadline,completed+RECHECK_POLICY.answerMaxAgeMs):null,job_key:key};record.result=stored;
 try{await store.complete(key,owner,record);}catch{return {...base,...stored,valid:false,decision:'CANCEL_BUY',error:'RC_RECORD_FAILED'};}
 return {...base,...stored,capture_context:validity.latest_capture,current_ref:base.current_ref};
}
/** Latest quote + rolling 24-bucket validity check. GPT is called only for UNCERTAIN
 * market change, never for VALID and never to rescue incomplete/non-causal data. */
export async function clockExecutionStep(db,s,ticket,readQuote,{now=Date.now,sequence=1,priorRecord=null,
  quote:providedQuote=null,capture:providedCapture=null,purpose='PRODUCTION',allowReview=true}={}){
 const checkedAt=now(),identity=leaderIdentity(s),ticketSafety=clockTicketCheck(ticket,identity,checkedAt);
 if(!ticketSafety.ok){const record=clockExecutionRecord(ticket,null,ticketSafety,checkedAt,sequence,null,null);
  return {proceed:false,decision:'WAIT',reason:ticketSafety.reason,record};}
 let quote,capture,quoteSafety=null;
 try{const [quoteResult,latest]=await Promise.all([providedQuote?Promise.resolve({quote:providedQuote,safety:null,at:checkedAt}):
   readClockExecutionQuote(s,ticket,readQuote,{now}),
   providedCapture?Promise.resolve(providedCapture):executionCapture(ticket,s.symbol,checkedAt,{now})]);
  quote=quoteResult.quote;quoteSafety=quoteResult.safety;capture=latest;}
 catch(error){const failed={ok:false,reason:'PRE_EXECUTION_DATA_READ_FAILED',error:String(error?.message??error).slice(0,120)},
   record=clockExecutionRecord(ticket,quote??null,failed,now(),sequence,null,null);
  return {proceed:false,decision:'WAIT',reason:failed.reason,record};}
 const at=now(),safety=quoteSafety??clockExecutionSafety(ticket,identity,quote,at),reference=priorRecord?.gpt_recheck_result==='KEEP_BUY'?
  priorRecord?.final?.capture_context:null,validity=classifyPreExecutionValidity({ticket,latestCapture:capture,quote,at,
   referenceCapture:reference,executionSafety:safety});
 let final=null,gptResult='NOT_ATTEMPTED',proceed=false,reason;
 const dataUnsafe=!validity.data_safety.latest.ok||validity.reasons.some(x=>['LATEST_TRAJECTORY_NOT_FRESH',
  'CURRENT_PRICE_MISSING','CURRENT_BOOK_METRICS_INCOMPLETE'].includes(x));
 if(validity.result===VALIDITY_RESULT.VALID){proceed=true;reason='PRE_EXECUTION_VALID';}
 else if(validity.result===VALIDITY_RESULT.INVALID){reason=safety?.ok===false?safety.reason:
   'PRE_EXECUTION_INVALID:'+validity.reasons.join(',');}
 else if(dataUnsafe){reason='PRE_EXECUTION_UNCERTAIN_DATA_UNSAFE';gptResult='NOT_ATTEMPTED_DATA_UNSAFE';}
 else if(!allowReview){reason='PRE_EXECUTION_REVIEW_REQUIRED';gptResult='DEFERRED_OUTSIDE_ACCOUNT_WRITER';}
 else{final=await runClockDeltaRecheck(db,s,ticket,validity,{now,sequence,purpose});
  gptResult=final.valid===true&&final.decision==='KEEP_BUY'?'KEEP_BUY':final.error??final.decision??'CANCEL_BUY';
  proceed=final.valid===true&&final.decision==='KEEP_BUY'&&now()<final.valid_until_ms;
  reason=proceed?'PRE_EXECUTION_GPT_KEEP_BUY':'PRE_EXECUTION_GPT_CANCEL_OR_ERROR:'+gptResult;}
 const record=clockExecutionRecord(ticket,quote,safety,at,sequence,validity,final),trace=clockExecutionTrace(ticket);
 Object.assign(trace,{pre_execution_check_at:at,pre_execution_check_latency_ms:at-checkedAt,decision_age_ms:validity.decision_age_ms,
  original_snapshot_at:validity.original_snapshot_at,latest_snapshot_at:validity.latest_snapshot_at,
  new_buckets_since_buy:validity.new_buckets_since_buy,price_drift_bps:validity.price_drift_bps,
  spread_delta_bps:validity.spread_delta_bps,slippage_delta_bps:validity.slippage_delta_bps,
  validity_result:validity.result,validity_reasons:validity.reasons,gpt_recheck_attempted:final?.attempted===true,
  gpt_recheck_result:gptResult,gpt_recheck_latency_ms:final?.latency_ms??null});
 record.clock_execution_telemetry={...trace};record.gpt_recheck_result=gptResult;
 return {proceed,decision:proceed?'BUY_NOW':'WAIT',reason,record};
}
function clockExecutionRecord(ticket,rawQuote,safety,at,sequence,validity=null,final=null){
 return {version:CLOCK_FINAL,clock_final_authority:ticket.clockFinalAuthority,recheck_sequence:sequence,
  initial_gpt_decision:'BUY',initial_gpt_at:ticket.initial.completedAt,initial_snapshot_at:ticket.initial.snapshotAt,
  initial_snapshot_hash:ticket.snapshotHash,initial_context:ticket.initial,pre_dispatch_at:at,
  pre_dispatch_snapshot:preDispatchSnapshot({at,rawQuote}),dispatch_quote:rawQuote,
  dispatch_capture:validity?.latest_capture??null,dynamic_policy:DYNAMIC_VERSION,
  pre_execution_check_at:at,pre_execution_validity:validity,validity_result:validity?.result??null,
  validity_reasons:validity?.reasons??[],recheck_triggered:validity?.result===VALIDITY_RESULT.UNCERTAIN,
  recheck_reasons:validity?.reasons??[],deltas:validity??{},final,
  final_gpt_decision:final?.decision==='KEEP_BUY'?'BUY':final?'ABSTAIN':'BUY',
  final_gpt_at:final?.completed_at_ms??ticket.initial.completedAt,max_rechecks:RECHECK_POLICY.maxRechecksPerCandidate,
  gpt_recheck_attempted:final?.attempted===true,gpt_recheck_latency_ms:final?.latency_ms??null,execution_safety:safety,
  clock_execution_telemetry:clockTraces.get(ticket)??null};
}
/**
 * @returns {proceed:boolean, reason:string, record:object}
 *   proceed=true  -> no meaningful change (initial BUY stands) or a valid FINAL BUY;
 *   proceed=false -> FINAL SKIP / ABSTAIN / timeout / error / invalid / expired / limit: no order.
 */
export async function finalRecheckStep(db,s,{ticket,e1,rawQuote,now=Date.now,purpose='PRODUCTION',config=null,apiKey=null,
  dataMode='LIVE',asOf=null,sequence=1,fetchFn=null}){
  if(ticket?.clockFinalAuthority){
    return clockExecutionStep(db,s,ticket,async()=>rawQuote,{now,sequence,quote:rawQuote,purpose});
  }
  // A clock signal without a validated FINAL capability may not fall back to the legacy AI route.
  if(s?.features?.leader20?.entry_window)return {proceed:false,decision:'WAIT',reason:'CLOCK_FINAL_AUTHORITY_INVALID',record:{recheck_triggered:false}};
  // A historical fixture (asOf) is judged at its own dispatch instant, never at the wall clock.
  // Sequence 1 only: an initial BUY that is aged, or would age before dispatch, is re-asked
  // (INITIAL_ANSWER_AGED) instead of being dispatched on or expiring at the dispatch check.
  const captured=asOf??now(),live=purpose==='PRODUCTION'&&dataMode==='LIVE';
  const capture=live?await (testHooks?.capture??readCaptureWithRecovery)(s.symbol,captured,{now}):null;
  const at=asOf??now(),snapshot=preDispatchSnapshot({at,rawQuote,e1,capture});
  const aged=sequence===1&&(ticket?.aged===true||(Number.isFinite(ticket?.validUntil)&&at>=ticket.validUntil-RECHECK_POLICY.initialAgeMarginMs));
  const detection=detectChange(ticket?.initial,snapshot,RECHECK_POLICY,{force:[...(aged?[AGED_REASON]:[]),...(isLeader20(s)?['LEADER20_FINAL_RECHECK']:[])]});
  const record={version:RECHECK_VERSION,recheck_sequence:sequence,initial_gpt_decision:ticket?.decision??null,initial_gpt_at:ticket?.initial?.completedAt??null,
    initial_snapshot_at:ticket?.initial?.snapshotAt??null,initial_snapshot_hash:ticket?.snapshotHash??null,
    initial_context:ticket?.initial??null,pre_dispatch_snapshot:snapshot,pre_dispatch_at:at,
    recheck_triggered:detection.triggered,recheck_reasons:detection.reasons,deltas:detection.deltas,
    final:null,final_gpt_decision:null,final_gpt_at:null,max_rechecks:RECHECK_POLICY.maxRechecksPerCandidate};
  if(live){
    record.dynamic_policy=DYNAMIC_VERSION;record.capture_safety=entryCaptureSafety(capture,at);
    if(!record.capture_safety.ok){record.outcome='WAIT';record.final_gpt_decision='WAIT';
      logRow(db,s,record,'NO_ORDER_WAIT:'+record.capture_safety.reason);
      return {proceed:false,decision:'WAIT',reason:record.capture_safety.reason,record};}
  }
  if(!detection.triggered){
    if(purpose==='PRODUCTION')logRow(db,s,record,'NO_RECHECK_INITIAL_BUY_STANDS');
    return {proceed:true,decision:'BUY_NOW',reason:'GPT_FINAL_RECHECK_NOT_REQUIRED',record};
  }
  let final;
  try{
    final=await runFinalRecheck({signal:s,ticket,detection,preDispatch:snapshot,purpose,dataMode,asOf,sequence,
      store:testHooks?.store??new SupabaseReviewStore(db),config:config??testHooks?.config??gptRecheckConfig(db),
      apiKey:apiKey??testHooks?.apiKey??getenv('OPENAI_API_KEY'),deepseekKey:testHooks?.deepseekKey??getenv('deepseek api'),fetchFn:fetchFn??testHooks?.fetchFn??fetch,now,readFresh:testHooks?.readFresh});
  }catch(e){final={decision:'ABSTAIN',valid:false,error:'RC_ADAPTER_ERROR',completed_at_ms:now()};}
  record.final=final;record.final_gpt_decision=final.valid===true||final.decision==='WAIT'?final.decision:'ABSTAIN';record.final_gpt_at=final.completed_at_ms??null;
  const proceed=recheckAllows(final,now());
  const reason=proceed?'GPT_FINAL_RECHECK_BUY':`GPT_FINAL_RECHECK_${record.final_gpt_decision}${final.error?':'+final.error:''}`;
  if(purpose==='PRODUCTION')logRow(db,s,record,proceed?'FINAL_BUY_TO_ORDER_CHECKS':'NO_ORDER_'+record.final_gpt_decision);
  return {proceed,decision:proceed?'BUY_NOW':record.final_gpt_decision==='SKIP'?'SKIP':'WAIT',reason,record,
    reviewRetryPending:final.retryable===true};
}
/** Wall-clock decision latency from the initial GPT answer to the order intent. */
export function withOrderTiming(record,at=Date.now()){
  if(!record)return null;
  return {...record,order_intent_at:at,decision_to_order_ms:Number.isFinite(record.initial_gpt_at)?at-record.initial_gpt_at:null};
}

// ------------------------------------------------------------------ ORDER-FREE probe
/** ORDER-FREE production probe of the whole path: INITIAL BUY fixture -> deterioration ->
 * change detector -> real GPT FINAL RECHECK (DRYRUN journal row) -> post-recheck safety on a
 * live book. No lease, no signal/order/position write, no order.
 *  fixture='LIVE': the initial BUY context is built from a live FD1 read of `symbol`, then a
 *    fixture tape with sellers dominating is applied as the pre-dispatch state.
 *  fixture='NIL': the stored NILUSDT production records; CURRENT facts are read at NIL's
 *    dispatch instant (REPLAY: history published before it, no historical book). */
export async function finalRecheckProbe(db,{symbol='BTCUSDT',fixture='LIVE',apiKey,runId,fetchFn=fetch,store=new SupabaseReviewStore(db),config=null,simulateFinalTimeout=false}){
  const cfg0=config??configFromControl(await readReviewControl(db).catch(()=>null),getenv);
  // The run ID already isolates the synthetic signal; authorization stays bound to the live control.
  const cfg={...cfg0};
  const t0=Date.now();
  let s,ticket,e1,rawQuote,dataMode='LIVE',asOf=null;
  if(fixture==='NIL'){
    s={...NIL_SIGNAL,id:NIL_SIGNAL.id+':probe:'+String(runId).slice(0,20)};ticket={...nilTicket({expires:Date.now()+60000})};
    e1=NIL_E1;rawQuote=NIL_DISPATCH_QUOTE;dataMode='REPLAY';asOf=NIL_DISPATCH_AT;
  }else{
    const now=Date.now(),{src}=await readSources(symbol,now,{mode:'LIVE',fetchFn,ms:2500});
    const facts=computeFacts(src,{asOf:now,referenceClose:null,dayReturn:null,rank:null});
    const bid=Number(src.book?.bids?.[0]?.[0]),ask=Number(src.book?.asks?.[0]?.[0]);
    if(!(bid>0&&ask>=bid))throw Error('PROBE_BOOK');
    const mid=(bid+ask)/2;
    // Fixture INITIAL BUY judged 10 s ago at a price 0.4% above the current mid, with buyers dominating.
    const initial=initialContext({snapshot_at_ms:now-10000,result:{completed_at_ms:now-8000},
      packet:{facts:{...facts,values:{...facts.values,taker_buy_ratio_5m:0.56}},execution_ref:{bid:mid*1.004,ask:mid*1.004,mid:mid*1.004,at:now-10000}}},
      {support:[{key:'return_5m'},{key:'taker_buy_ratio_5m'}],summary:'fixture initial buy'});
    s={id:'fd1-recheck-probe-'+symbol+'-'+now+'-'+String(runId).slice(0,20),symbol,features:{strategy:'LEADER_MOMENTUM_V17',
      referenceClose:facts.quality.last_close,dayReturn:null,rank:null,v17Setup:{state:'TRIGGERED',triggerAt:Math.floor(now/60000)*60000}}};
    ticket={decision:'BUY',expires:now+60000,snapshotHash:'probe-'+now,identityJson:JSON.stringify({judgments:null}),initial};
    e1={confirmationState:'BASELINE_ELIGIBLE',reasonCodes:['FIXTURE'],observations:[{startAt:now-10000,endAt:now,return:-0.003,buyShare:0.35,tradeCount:200}]};
    rawQuote={best_bid:bid,best_ask:ask,bids:src.book.bids,asks:src.book.asks,timing:{received_at_ms:now}};
  }
  const attempts=[];let injected=false;
  const probeFetch=async(url,init)=>{
    if(simulateFinalTimeout&&!injected&&String(url).startsWith('https://api.openai.com/')){
      const input=JSON.parse(JSON.parse(init.body).input[1].content);
      if(input.independent_reviews){injected=true;throw Error('API_TIMEOUT');}
    }
    return fetchFn(url,init);
  };
  const probe=await resumeReviewTimeouts(async()=>{
    if(attempts.length){
      // Production re-enters through protection/E1/book checks in a fresh lease.
      // This isolated fixture has no account or lease; refresh its public book
      // and restamp only the explicitly synthetic adverse tape observation.
      const r=await fetchFn('https://fapi.binance.com/fapi/v1/depth?limit=100&symbol='+encodeURIComponent(symbol),
        {signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error('PROBE_RETRY_QUOTE');
      const book=await r.json(),at=Date.now();rawQuote={best_bid:Number(book.bids?.[0]?.[0]),best_ask:Number(book.asks?.[0]?.[0]),
        bids:book.bids,asks:book.asks,timing:{received_at_ms:at}};
      e1={...e1,observations:e1.observations.map(o=>({...o,startAt:at-10000,endAt:at}))};
    }
    const step=await finalRecheckStep(db,s,{ticket,e1,rawQuote,purpose:'DRYRUN',config:cfg,apiKey,dataMode,asOf,fetchFn:probeFetch});
    const f=step.record.final;
    attempts.push({job_key:f?.job_key??null,valid:f?.valid??false,decision:f?.decision??step.decision,error:f?.error??null,
      latency_ms:f?.latency_ms??null,retryable:step.reviewRetryPending===true,capture_end:f?.capture_context?.end_ms??null});
    return {ok:true,entry:{reviewRetryPending:step.reviewRetryPending===true},step};
  },{enabled:()=>fixture==='LIVE'});
  const step=probe.step;
  let safety=null;
  if(step.proceed&&step.record.recheck_triggered){
    // Deterministic post-recheck safety on a NEW live book read (as the order path would).
    const at=Date.now(),{src}=await readSources(fixture==='NIL'?'NILUSDT':symbol,at,{mode:'LIVE',fetchFn,ms:2500});
    const b=Number(src.book?.bids?.[0]?.[0]),a=Number(src.book?.asks?.[0]?.[0]);
    const quote={best_bid:b,best_ask:a,timing:{received_at_ms:Date.now()}};
    safety=fixture==='NIL'?{skipped:'NIL is historical: its dispatch quote cannot be re-read'}:postRecheckSafety({recheck:step.record.final,quote,at:Date.now()});
  }
  const f=step.record.final;
  return {fixture,symbol:s.symbol,triggered:step.record.recheck_triggered,reasons:step.record.recheck_reasons,deltas:step.record.deltas,
    final:f?{decision:f.decision,valid:f.valid,error:f.error,latencyMs:f.latency_ms,costUsd:f.api_cost_usd,jobKey:f.job_key,
      answer:f.answer?{decision:f.answer.decision,reasons:f.answer.reasons?.map(r=>r.category),support:f.answer.support?.map(x=>x.key),summary:f.answer.summary}:null}:null,
    proceed:step.proceed,reason:step.reason,postSafety:safety,elapsedMs:Date.now()-t0,attempts,timeoutFixture:simulateFinalTimeout,injected,
    wouldOrder:step.proceed&&(safety?.ok!==false)?'NEXT_STEP_IS_EXISTING_ORDER_GUARDS (not executed: probe)':'NO_ORDER',orderCalls:0};
}
