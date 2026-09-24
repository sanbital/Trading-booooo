/** GPT FINAL RECHECK inside the executor's entry path (openBull), between E1 and the final
 * dispatch block. GPT remains the final decision maker; this adapter only
 *  1. builds the PRE-DISPATCH snapshot from data already in hand (E1 tape + E1 quote),
 *  2. runs the change detector against the INITIAL BUY ticket,
 *  3. if (and only if) it triggered, asks GPT once more (journal + shared budget ledger),
 *  4. records the outcome (evidence only; a logging failure never changes a decision).
 * Fail closed: when a recheck is required, only a valid unexpired FINAL BUY continues. */
import {detectChange,preDispatchSnapshot,runFinalRecheck,recheckAllows,postRecheckSafety,initialContext,
  RECHECK_POLICY,RECHECK_VERSION} from '../_shared/gpt-final-decision/recheck.mjs';
import {computeFacts} from '../_shared/gpt-final-decision/facts.mjs';
import {readSources} from '../_shared/gpt-final-decision/market.mjs';
import {SupabaseReviewStore,readReviewControl} from '../_shared/gpt-final-review/supabase-store.mjs';
import {configFromControl} from '../_shared/gpt-final-review/coordinator.mjs';
import {gptRecheckConfig} from './gpt-final-review-adapter.mjs';
import {nilTicket,NIL_E1,NIL_DISPATCH_QUOTE,NIL_SIGNAL,NIL_DISPATCH_AT} from './recheck-nil-fixture.mjs';
export {RECHECK_VERSION,postRecheckSafety};
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
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
    final_answer:record.final?.answer??null,outcome,counterfactual_entry_price:record.pre_dispatch_snapshot?.ask??null};
  if(testHooks?.log){testHooks.log.push(row);return;}
  schedule((async()=>{const r=await db.from('fd1_final_recheck_log').insert(row);if(r.error)throw Error(r.error.message);})());
}
const ms=x=>Number.isFinite(Number(x))&&x!==null?new Date(Number(x)).toISOString():null;
/** Mark a logged candidate's outcome after the post-recheck safety (evidence only). */
export function markRecheckOutcome(db,s,record,outcome){
  if(testHooks?.log){const r=testHooks.log.findLast(x=>x.signal_id===String(s.id));if(r)r.outcome=outcome;return;}
  schedule((async()=>{const r=await db.from('fd1_final_recheck_log').update({outcome}).eq('signal_id',String(s.id))
    .eq('initial_snapshot_hash',record.initial_snapshot_hash??'').eq('recheck_sequence',record.recheck_sequence??1);
    if(r.error)throw Error(r.error.message);})());
}
/**
 * @returns {proceed:boolean, reason:string, record:object}
 *   proceed=true  -> no meaningful change (initial BUY stands) or a valid FINAL BUY;
 *   proceed=false -> FINAL SKIP / ABSTAIN / timeout / error / invalid / expired / limit: no order.
 */
export async function finalRecheckStep(db,s,{ticket,e1,rawQuote,now=Date.now,purpose='PRODUCTION',config=null,apiKey=null,
  dataMode='LIVE',asOf=null,sequence=1}){
  // A historical fixture (asOf) is judged at its own dispatch instant, never at the wall clock.
  const at=asOf??now(),snapshot=preDispatchSnapshot({at,rawQuote,e1}),detection=detectChange(ticket?.initial,snapshot);
  const record={version:RECHECK_VERSION,recheck_sequence:sequence,initial_gpt_decision:ticket?.decision??null,initial_gpt_at:ticket?.initial?.completedAt??null,
    initial_snapshot_at:ticket?.initial?.snapshotAt??null,initial_snapshot_hash:ticket?.snapshotHash??null,
    initial_context:ticket?.initial??null,pre_dispatch_snapshot:snapshot,pre_dispatch_at:at,
    recheck_triggered:detection.triggered,recheck_reasons:detection.reasons,deltas:detection.deltas,
    final:null,final_gpt_decision:null,final_gpt_at:null,max_rechecks:RECHECK_POLICY.maxRechecksPerCandidate};
  if(!detection.triggered){
    if(purpose==='PRODUCTION')logRow(db,s,record,'NO_RECHECK_INITIAL_BUY_STANDS');
    return {proceed:true,reason:'GPT_FINAL_RECHECK_NOT_REQUIRED',record};
  }
  let final;
  try{
    final=await runFinalRecheck({signal:s,ticket,detection,preDispatch:snapshot,purpose,dataMode,asOf,sequence,
      store:testHooks?.store??new SupabaseReviewStore(db),config:config??testHooks?.config??gptRecheckConfig(db),
      apiKey:apiKey??testHooks?.apiKey??getenv('OPENAI_API_KEY'),fetchFn:testHooks?.fetchFn??fetch,now,readFresh:testHooks?.readFresh});
  }catch(e){final={decision:'ABSTAIN',valid:false,error:'RC_ADAPTER_ERROR',completed_at_ms:now()};}
  record.final=final;record.final_gpt_decision=final.valid===true?final.decision:'ABSTAIN';record.final_gpt_at=final.completed_at_ms??null;
  const proceed=recheckAllows(final,now());
  const reason=proceed?'GPT_FINAL_RECHECK_BUY':`GPT_FINAL_RECHECK_${record.final_gpt_decision}${final.error?':'+final.error:''}`;
  if(purpose==='PRODUCTION')logRow(db,s,record,proceed?'FINAL_BUY_TO_ORDER_CHECKS':'NO_ORDER_'+record.final_gpt_decision);
  return {proceed,reason,record};
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
export async function finalRecheckProbe(db,{symbol='BTCUSDT',fixture='LIVE',apiKey,runId,fetchFn=fetch,store=new SupabaseReviewStore(db),config=null}){
  const cfg0=config??configFromControl(await readReviewControl(db).catch(()=>null),getenv);
  const cfg={...cfg0,approvalRef:'FD1_RECHECK_PROBE:'+String(runId).slice(0,40)};
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
  const step=await finalRecheckStep(db,s,{ticket,e1,rawQuote,purpose:'DRYRUN',config:cfg,apiKey,dataMode,asOf});
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
    proceed:step.proceed,reason:step.reason,postSafety:safety,elapsedMs:Date.now()-t0,
    wouldOrder:step.proceed&&(safety?.ok!==false)?'NEXT_STEP_IS_EXISTING_ORDER_GUARDS (not executed: probe)':'NO_ORDER',orderCalls:0};
}
