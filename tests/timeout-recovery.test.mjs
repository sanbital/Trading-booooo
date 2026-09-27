import test from 'node:test';
import assert from 'node:assert/strict';
import {FinalReviewCoordinator,MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {hash} from '../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {TIMEOUT_RECOVERY,isReviewTimeout} from '../supabase/functions/_shared/gpt-final-decision/timeout-recovery.mjs';
import {captureForInference} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {runFinalRecheck,recheckAllows,detectChange,preDispatchSnapshot} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {holdStep,nextEvent,initialHoldState} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {gptTerminalReason,expiredTriggerReason} from '../supabase/functions/v10-lane-executor/entry-lifecycle.mjs';
import {runWithGptReview,setTestCoordinator} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
const T=1800000000000,cfg={mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:10,maxCalls:100,enforceApproved:true};
function harness(errors=['API_TIMEOUT',null],{auto=true,maxCalls=100}={}){
 let at=T+1000,calls=0;const store=new MemoryReviewStore(),prepared=[],resolved=[];
 const signal={id:'xvg-timeout',symbol:'XVGUSDT',features:{v17Setup:{triggerAt:T}}};
 const engine={id:'TIMEOUT_TEST',model:'test',allow:'BUY',schema:{},promptText:'test',timeoutRecovery:auto,
  identity:s=>({signal_id:s.id,symbol:s.symbol,trigger_at_ms:s.features.v17Setup.triggerAt}),
  async prepare(identity,options){
   prepared.push({at,afterEndMs:options.afterEndMs});
   const packet={candidate_id:'candidate',as_of_offset_ms:at-T,facts:{capture_context:validCapture(at)},snapshot_hash:''};
   packet.snapshot_hash=await hash(packet);return {packet,captured:at};
  },packetHash:p=>hash({...p,snapshot_hash:''}),
  async call(packet){const error=errors[Math.min(calls++,errors.length-1)];at+=error?8000:2000;
   return {origin:'OPENAI_API',valid:!error,decision:error?'ABSTAIN':'BUY',error,attempted:true,completed_at_ms:at,
    model_requested:'test',raw_response:error?null:{model:'test',wire:{decision:'BUY'}},request_id:error?null:'req',wire_profile:'TIMEOUT_TEST'};
  },revalidate:r=>r.raw_response.wire};
 const make=()=>new FinalReviewCoordinator({config:{...cfg,maxCalls},store,apiKey:()=>'test',engine,baseline:()=>true,
  expiry:()=>T+60000,now:()=>at,onResolved:async(s,r)=>resolved.push(r)});
 const c=make();return {c,make,store,signal,prepared,resolved,setTime:x=>{at=x;},get calls(){return calls;}};
}
async function drain(c){while(c.pending.size)await Promise.all([...c.pending.values()]);}
test('ENTRY timeout automatically obtains a new journal reservation, capture and valid BUY',async()=>{
 const h=harness();assert.equal((await h.c.consider(h.signal)).reason,'GPT_REVIEW_PENDING');
 assert.equal(h.c.check(h.signal).allowed,false);
 await drain(h.c);
 const result=await h.c.consider(h.signal);
 assert.equal(result.allowed,true);assert.equal(h.c.check(h.signal).allowed,true);assert.equal(h.calls,2);
 const rows=[...h.store.rows.values()];assert.equal(rows.length,2);assert.equal(h.store.calls,2);
 assert.equal(rows[0].record.result.error,'API_TIMEOUT');assert.equal(rows[1].record.timeout_recovery.parent_job_key,rows[0].key);
 assert.ok(rows[1].record.packet.facts.capture_context.end_ms>rows[0].record.packet.facts.capture_context.end_ms);
 assert.equal(h.prepared[1].afterEndMs,rows[0].record.packet.facts.capture_context.end_ms);
 assert.equal(h.c.tracked.size,1);
});
test('timeout during waitReady is retried outside the lease; no failed parent is terminalized',async()=>{
 const h=harness();await h.c.consider(h.signal);assert.equal(await h.c.waitReady(),true);
 assert.equal(h.resolved.length,1);assert.equal(h.resolved[0].decision,'BUY');assert.equal(h.calls,2);
});
test('durable recovery is idempotent across concurrent coordinators and late rereads',async()=>{
 const h=harness(['API_TIMEOUT',null],{auto:false});await h.c.consider(h.signal);await drain(h.c);
 h.c.engine.timeoutRecovery=true;
 const b=h.make();await Promise.all([h.c.consider(h.signal),b.consider(h.signal)]);
 await Promise.all([drain(h.c),drain(b)]);assert.equal(h.calls,2);assert.equal(h.store.rows.size,2);
 h.setTime(T+48000);const r=await b.consider(h.signal);
 // At this point there is no time for a new attempt; the existing child is still found.
 assert.notEqual(r.reason,'GPT_REVIEW_RECOVERY_EXHAUSTED');assert.equal(h.calls,2);
});
test('repeated timeouts are bounded by original trigger and never become a BUY or terminal market rejection',async()=>{
 const h=harness(['API_TIMEOUT']);await h.c.consider(h.signal);await drain(h.c);
 const r=await h.c.consider(h.signal);assert.equal(r.reason,'GPT_REVIEW_RECOVERY_EXHAUSTED');
 assert.equal(h.calls,TIMEOUT_RECOVERY.maxAttempts);assert.equal(h.c.check(h.signal).allowed,false);
 assert.equal(gptTerminalReason(r),null);assert.ok([...h.store.rows.values()].every(x=>x.record.result.valid===false));
 assert.equal(expiredTriggerReason(r),'STALE:TIMEOUT_RECOVERY_EXHAUSTED');
});
test('a short trigger remainder or an unadvanced retry snapshot cannot buy another model call',async()=>{
 const late=harness(['API_TIMEOUT']);late.setTime(T+40000);await late.c.consider(late.signal);await drain(late.c);
 assert.equal(late.calls,1);assert.equal((await late.c.consider(late.signal)).reason,'GPT_REVIEW_RECOVERY_EXHAUSTED');
 const stuck=harness(['API_TIMEOUT',null]),prepare=stuck.c.engine.prepare;let original;
 stuck.c.engine.prepare=async(...args)=>{const p=await prepare(...args);original??=p.packet.facts.capture_context;
  p.packet.facts.capture_context=original;p.packet.snapshot_hash=await hash({...p.packet,snapshot_hash:''});return p;};
 await stuck.c.consider(stuck.signal);await drain(stuck.c);assert.equal(stuck.calls,1);assert.equal(stuck.c.check(stuck.signal).allowed,false);
});
test('budget prevents a second paid call; invalid schema is never treated as timeout',async()=>{
 const h=harness(['API_TIMEOUT',null],{maxCalls:1});await h.c.consider(h.signal);await drain(h.c);
 assert.equal((await h.c.consider(h.signal)).reason,'GPT_API_BUDGET_EXHAUSTED');assert.equal(h.calls,1);
 for(const error of ['FD_EV_SKIP_REQUIRES_BEARISH_FACTS','FD_MODEL_MISMATCH','HTTP_401',null]){
  assert.equal(isReviewTimeout({valid:false,error}),false);
 }
 assert.equal(isReviewTimeout({valid:true,error:'API_TIMEOUT'}),false);
});
test('fresh retry refuses the original bucket even when it is only 200 ms old',async()=>{
 let at=T+200;const old=validCapture(at);
 const fresh=await captureForInference('XVGUSDT',old,{now:()=>at,sleep:async ms=>{at+=ms;},afterEndMs:old.end_ms,
   read:async()=>at>=T+6000?validCapture(at):old});
 assert.equal(fresh.status,'AVAILABLE');assert.ok(fresh.end_ms>old.end_ms);assert.equal(fresh.pre_inference_refresh.advanced,true);
});
test('RECHECK timeout releases its failed attempt; next call retries with fresh capture, same sequence, new key',async()=>{
 let at=T+1500,calls=0;const store=new MemoryReviewStore(),reads=[];
 const signal={id:'xvg-recheck',symbol:'XVGUSDT',features:{v17Setup:{triggerAt:T},referenceClose:1}},
  ticket={expires:T+60000,snapshotHash:'initial',identityJson:'{}',initial:{facts:{},support:[]}},
  preDispatch=preDispatchSnapshot({at,rawQuote:{best_bid:1,best_ask:1.001},e1:null}),detection=detectChange(ticket.initial,preDispatch);
 const args={signal,ticket,detection,preDispatch,store,config:cfg,apiKey:'test',now:()=>at,
  readFresh:async(s,t,o)=>{reads.push(o.afterEndMs);return {src:{...src(at),captureContext:validCapture(at)},errors:{}};},
  review:async()=>{at+=calls++===0?8000:2000;return {valid:calls>1,decision:calls>1?'BUY':'ABSTAIN',error:calls>1?null:'API_TIMEOUT',completed_at_ms:at,attempted:true};}};
 const first=await runFinalRecheck(args);assert.equal(first.retryable,true);assert.equal(recheckAllows(first,at),false);
 const second=await runFinalRecheck(args);assert.equal(second.valid,true);assert.equal(recheckAllows(second,at),true);
 assert.notEqual(first.job_key,second.job_key);assert.equal(reads[1],first.capture_context.end_ms);
 assert.ok(second.capture_context.end_ms>first.capture_context.end_ms);assert.equal(store.calls,2);
 const duplicate=await runFinalRecheck(args);assert.equal(duplicate.error,'RC_LIMIT_REACHED');assert.equal(calls,2);
});
test('a recheck retry re-enters through a new ordinary lease cycle and stops on SKIP/safety/busy',async()=>{
 for(const last of [{ok:true,entry:{entered:true}},{ok:true,entry:{entered:false,reason:'GPT_SKIP'}},{ok:false,skipped:true}]){
  const db={};let runs=0,held=false;setTestCoordinator(db,{config:{mode:'ENFORCE'},now:()=>0});
  const result=await runWithGptReview(db,async()=>{assert.equal(held,false);held=true;runs++;held=false;
   return runs===1?{ok:true,entry:{entered:false,reviewRetryPending:true}}:last;});
  assert.equal(runs,2);assert.deepEqual(result,last);
 }
});
test('ordinary invalid answers are single-use and repeated recheck scheduling is bounded',async()=>{
 const h=harness(['FD_EV_SKIP_REQUIRES_BEARISH_FACTS']);await h.c.consider(h.signal);await drain(h.c);
 assert.equal(h.calls,1);assert.equal((await h.c.consider(h.signal)).reason,'GPT_NO_VALID_API_RESPONSE');
 const db={};let runs=0;setTestCoordinator(db,{config:{mode:'ENFORCE'},now:()=>0});
 await runWithGptReview(db,async()=>{runs++;return {ok:true,entry:{reviewRetryPending:true}};});
 assert.equal(runs,TIMEOUT_RECOVERY.maxAttempts);
});
test('HOLD timeout retains protection and retries same event after five seconds, not one minute',async()=>{
 const st={...initialHoldState(1),reviews:1,lastReviewAt:T,pending:{key:'hold',event:'MOMENTUM_DETERIORATION',at:T}};
 const r=await holdStep(st,{now:T+8000,price:1,peak:1,positionId:'p',answerOf:async()=>({state:'DONE',valid:false,error:'API_TIMEOUT',completed_at_ms:T+8000})});
 assert.equal(r.close,false);assert.equal(r.state.retryAfter,T+13000);
 assert.equal(nextEvent(r.state,{now:T+12999,price:1,peak:1}).event,null);
 assert.equal(nextEvent(r.state,{now:T+13000,price:1,peak:1}).event,'MOMENTUM_DETERIORATION');
});
