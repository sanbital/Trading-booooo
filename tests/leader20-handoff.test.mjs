import test from 'node:test';
import assert from 'node:assert/strict';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
import {runEntryBatch} from '../supabase/functions/_shared/leader20/batch-runtime.mjs';
import {clockDecisionWindow,CLOCK_VERSION} from '../supabase/functions/_shared/leader20/clock.mjs';
import {batchFinalDecision} from '../supabase/functions/_shared/leader20/final.mjs';
import {generateLeader20} from '../supabase/functions/_shared/leader20/runtime.mjs';
import {validateCapture120} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {hash} from '../supabase/functions/_shared/gpt-final-decision/snapshot-hash.mjs';
import {nmrClockFinal} from '../test-support/nmr-clock-final.mjs';
import {validClockFinalPacket} from '../supabase/functions/_shared/leader20/clock-final.mjs';
const slot=Date.parse('2026-09-28T22:40:00+09:00');
const fixed=()=>({...rawCapture(slot+200),entry_window:{version:CLOCK_VERSION,slot_ms:slot,expires_at_ms:slot+120000}});
function harness({start=2000,ready=5000,reserve=80000,capacity=2,partial=false,ds='invalid'}={}){
 let at=slot+start,claimed=false;const notes=[],sleeps=[],packets=[],paid=[],reads=[];
 const members=Array.from({length:20},(_,i)=>({symbol:`C${i}USDT`,rank:i+1}));
 const db={from(table){return {select(){return this;},eq(){return this;},lte(){return this;},
  async maybeSingle(){return {data:{decision_reserve_ms:reserve,last_periodic_slot:claimed?new Date(slot).toISOString():null}};},
  async order(){return {data:members};}};},async rpc(name,args){
  if(name==='leader20_clock_note'){notes.push(args);return {data:{recorded:true}};}
  if(name==='leader20_batch_capacity')return {data:{available:capacity,held:[],reason:capacity?null:'NO_ENTRY_CAPACITY'}};
  if(name==='leader20_batch_note_full')return {data:{}};
  if(name==='doa_context_for_role_v1'){
   reads.push(args);return {data:at>=slot+ready||partial&&args.p_symbol==='C0USDT'?fixed():{status:'UNAVAILABLE',reason:'CLOCK_INCOMPLETE_TRAJECTORY'}};
  }
  if(name==='leader20_batch_claim'){
   if(claimed)return {data:{created:false,reason:'NOT_DUE'}};
   claimed=true;packets.push(args.p_packet);return {data:{created:true,row:{id:'b',owner:'o'}}};
  }
  if(name==='leader20_batch_start')return {data:{allowed:true}};
  if(name==='ai_call_reserve_owned')return {data:{created:true,row:{owner:'paid-owner'}}};
  if(name==='ai_call_transition')return {data:{}};
  if(name==='leader20_batch_finish'){
   assert.equal(args.p_result.results.length,20);
   assert.ok(args.p_result.results.every(s=>s.decision==='BLOCKED'&&s.valid===false));
   return {data:{events:20}};
  }
  throw Error('Unexpected RPC '+name);
 }};
 const options={now:()=>at,apiKey:'fixture',sleep:async ms=>{sleeps.push(ms);at+=ms;},fetchFn:async(url,init)=>{
  if(url.startsWith('https://fapi')){assert.ok(url.includes('endTime='+String(slot-1)));throw Error('offline momentum');}
  paid.push(JSON.parse(init.body));at+=9000;
  if(ds==='timeout')throw Object.assign(Error('fixture'),{name:'TimeoutError'});
  return new Response(JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:'invalid JSON'}}],
   usage:{prompt_tokens:100,completion_tokens:5}}));
 }};
 return {db,options,notes,sleeps,packets,paid,reads,get at(){return at;},ctl:{clock_capture_enabled:true,epoch_id:'e',generation:4}};
}
test('22:40:02 incomplete -> bounded same-slot retry -> 22:40:05 READY -> one advisory even invalid JSON',async()=>{
 const h=harness({partial:true}),r=await runEntryBatch(h.db,h.ctl,h.options);
 assert.equal(r.batch_created,true);assert.equal(r.batch_reason,'CREATED');assert.equal(r.capture_ready_count,20);
 assert.equal(r.capture_blocked_count,0);assert.equal(r.available_slots,2);assert.equal(r.decision_deadline,new Date(slot+120000).toISOString());
 assert.ok(r.retry_count>0);assert.ok(h.sleeps.every(n=>n>=250&&n<=1000));assert.equal(h.paid.length,1);
 assert.equal(h.packets[0].entry_window.slot_ms,slot);assert.ok(h.packets[0].as_of_ms>=slot+5000&&h.packets[0].as_of_ms<slot+6000);
 assert.ok(h.packets[0].symbols.every(s=>s.matrix.length===24&&s.last_ms===slot+100));
 assert.equal(h.packets[0].symbols[0].trajectory_hash,await hash(validateCapture120(fixed(),h.at).trajectory));
 assert.ok(h.notes.some(n=>n.p_data.batch_reason==='CAPTURE_NOT_READY'));
 assert.equal((await runEntryBatch(h.db,h.ctl,h.options)).batch_reason,'NOT_DUE');assert.equal(h.paid.length,1);
});
test('35-second READY starts; 100-second READY cannot spend AI reserve or roll into next slot',async()=>{
 const h=harness({ready:35000}),r=await runEntryBatch(h.db,h.ctl,h.options);
 assert.equal(r.created,true);assert.ok(h.packets[0].as_of_ms>=slot+35000);
 const late=harness({ready:100000}),no=await runEntryBatch(late.db,late.ctl,late.options);
 assert.equal(no.reason,'DECISION_WINDOW_INSUFFICIENT');assert.equal(late.paid.length,0);assert.equal(late.packets.length,0);
 assert.ok(late.at<=slot+40000);assert.ok(late.reads.every(x=>Date.parse(x.p_as_of)<slot+40000));
 const firstLate=harness({start:100000,ready:100000});
 assert.equal((await runEntryBatch(firstLate.db,firstLate.ctl,firstLate.options)).reason,'DECISION_WINDOW_INSUFFICIENT');
 assert.equal(firstLate.reads.length,0);
});
test('reserve is configurable, T itself may wait for freeze ingest, and capacity zero makes no capture/provider read',async()=>{
 assert.equal(clockDecisionWindow(slot,30000).latest_batch_start_ms,slot+90000);
 assert.throws(()=>clockDecisionWindow(slot,0),/RESERVE/);
 const exact=harness({start:0});assert.equal((await runEntryBatch(exact.db,exact.ctl,exact.options)).created,true);
 const full=harness({capacity:0});assert.equal((await runEntryBatch(full.db,full.ctl,full.options)).batch_reason,'CAPACITY_ZERO');
 assert.equal(full.reads.length,0);assert.equal(full.paid.length,0);
});
test('DeepSeek timeout remains explicit unavailable advice for twenty GPT events',async()=>{
 const h=harness({ds:'timeout'});assert.equal((await runEntryBatch(h.db,h.ctl,h.options)).events,20);assert.equal(h.paid.length,1);
});
test('already-expired GPT FINAL is a technical ABSTAIN and makes no API call',async()=>{
 let calls=0;const r=await batchFinalDecision({leader20:{entry_window:{expires_at_ms:slot+120000}}},
  {now:()=>slot+120000,call:async()=>{calls++;}});
 assert.equal(r.error,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');assert.equal(r.decision,'ABSTAIN');assert.equal(calls,0);
});
test('advisory and GPT bind identical slot/hash; a response arriving at the deadline is never BUY',async()=>{
 const f=await nmrClockFinal(),p=structuredClone(f.packet),w=p.leader20.entry_window;
 p.leader20.batch_advice={...p.leader20.batch_advice,entry_window:w,trajectory_hash:p.facts.capture_context.trajectory_hash};
 assert.equal(validClockFinalPacket(p,f.now()),true);
 p.leader20.batch_advice.trajectory_hash='different';assert.equal(validClockFinalPacket(p,f.now()),false);
 p.leader20.batch_advice.trajectory_hash=p.facts.capture_context.trajectory_hash;
 let at=w.expires_at_ms-100;const r=await batchFinalDecision(p,{now:()=>at,deadlineMs:at+20000,call:async(_p,o)=>{
  assert.equal(o.timeoutMs,100);at=w.expires_at_ms;return {valid:true,decision:'BUY',attempted:true,completed_at_ms:at};
 }});
 assert.equal(r.decision,'ABSTAIN');assert.equal(r.valid,false);assert.equal(r.requires_final_recheck,false);
 assert.equal(r.error,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
});
test('off-window generator HTTP payload exposes the slot and technical outcome',async()=>{
 const r=await generateLeader20({},{clock_capture_enabled:true},{now:()=>slot+150000});
 assert.equal(r.batch_outcome.batch_reason,'DECISION_WINDOW_EXPIRED');assert.equal(r.batch_outcome.slot_at,new Date(slot).toISOString());
});
