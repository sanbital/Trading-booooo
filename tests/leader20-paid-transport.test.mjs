import test from 'node:test';
import assert from 'node:assert/strict';
import {paidTransport} from '../supabase/functions/_shared/leader20/paid-transport.mjs';
import {batchFinalDecision} from '../supabase/functions/_shared/leader20/final.mjs';
import {buildDecisionPacket} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
const T=1800000000200;
const endpoint='https://api.deepseek.com/chat/completions';
const init={body:JSON.stringify({model:'deepseek-flash',max_tokens:2400,messages:[]})};
function database({denied=false}={}){
 const events=[];return {events,async rpc(name,p){events.push({name,p});
  return {data:name==='ai_call_reserve'?(denied?{created:false,reason:'API_BUDGET_EXHAUSTED',additional_usd:.05}:
   {created:true,row:{owner:'owner'}}):{state:p.p_state}};}};
}
test('usage is settled once even when provider model JSON is malformed',async()=>{
 const db=database();let calls=0;
 const f=paidTransport(db,{parentKey:'p',purpose:'ENTRY',fetchFn:async()=>{calls++;return Response.json({id:'r',
  usage:{prompt_tokens:20000,prompt_cache_hit_tokens:12000,completion_tokens:500},choices:[{message:{content:'{bad'}}]});}});
 await f(endpoint,init);assert.equal(calls,1);
 assert.deepEqual(db.events.map(e=>e.name==='ai_call_reserve'?'RESERVED':e.p.p_state),['RESERVED','DISPATCHED','SETTLED']);
 assert.equal(db.events[2].p.p_usage.cached_input_tokens,12000);
});
test('budget refusal sends no HTTP and preserves blocked-candidate additional cost',async()=>{
 const db=database({denied:true});let calls=0;
 const f=paidTransport(db,{parentKey:'p',purpose:'ENTRY',fetchFn:async()=>{calls++;}});
 await assert.rejects(f(endpoint,init),e=>e.message==='API_BUDGET_EXHAUSTED'&&e.budget.additional_usd===.05);
 assert.equal(calls,0);
});
test('ambiguous provider timeout is retained, never refunded or automatically retried',async()=>{
 const db=database();let calls=0;
 const f=paidTransport(db,{parentKey:'p',purpose:'EXIT',fetchFn:async()=>{calls++;throw Error('timeout');}});
 await assert.rejects(f(endpoint,init),/timeout/);assert.equal(calls,1);
 assert.equal(db.events.at(-1).p.p_state,'UNKNOWN');
 assert.equal(db.events.some(e=>e.p.p_state==='CANCELLED'),false);
});
test('batch PASS gets one independent GPT FINAL with original latest 24 buckets and no FIRST',async()=>{
 const facts=computeFacts(src(T),{asOf:T});facts.capture_context=validCapture(T);
 const packet=await buildDecisionPacket({task:'ENTRY',subjectId:'batch-final',symbol:'QNTUSDT',dataMode:'LIVE',facts});
 packet.dynamic_policy='DYNAMIC_FLOW_LIFECYCLE_1';packet.dynamic_as_of_ms=T;
 packet.leader20={version:'LEADER20_DYNAMIC_1',batch_advice:{id:'QNTUSDT',decision:'PASS',valid:true,grounding:'SYMBOL_CELLS_VERIFIED_V2',last_ms:T-6000,reason:'buy flow'}};
 let calls=0;
 const r=await batchFinalDecision(packet,{apiKey:'fixture',now:()=>T,call:async(p,o)=>{
  calls++;const payload=o.payloadFn(p),input=JSON.parse(payload.input[1].content);
  assert.equal(input.capture_context.ordered_path.length,24);
  assert.equal(input.original_latest_capture,undefined,'full evidence is supplied once');
  assert.equal(input.deepseek_prior_review.last_ms,T-6000);
  assert.match(payload.input[0].content,/independent final BUY\/WAIT\/SKIP/);
  return {valid:true,decision:'SKIP'};
 }});
 assert.equal(calls,1);assert.equal(r.decision,'SKIP');assert.equal(r.requires_final_recheck,true);
 for(const [decision,valid] of [['WAIT',true],['SKIP',true],['BLOCKED',false]]){
  packet.leader20.batch_advice={...packet.leader20.batch_advice,decision,valid};
  const independent=await batchFinalDecision(packet,{apiKey:'fixture',now:()=>T,call:async()=>({valid:true,decision:'BUY'})});
  assert.equal(independent.decision,'BUY','advisor opinion cannot veto GPT');
  assert.equal(independent.requires_final_recheck,true,'fixture BUY never grants direct dispatch authority');
 }
 packet.leader20.batch_advice.last_ms=T-600000;
 const stale=await batchFinalDecision(packet,{apiKey:'fixture',now:()=>T,call:async()=>{throw Error('must not call');}});
 assert.equal(stale.valid,false);
});
