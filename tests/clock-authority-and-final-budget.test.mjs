import test from 'node:test';
import assert from 'node:assert/strict';
import {eventExpiry,clockAuthorityDeadline,CAMPAIGN_POLICY} from '../supabase/functions/_shared/leader20/campaign.mjs';
import {CLOCK_VERSION,SLOT_MS,EXECUTION_MS} from '../supabase/functions/_shared/leader20/clock.mjs';
import {batchFinalDecision,CLOCK_FINAL_MIN_BUDGET_MS} from '../supabase/functions/_shared/leader20/final.mjs';
import {runEntryBatch} from '../supabase/functions/_shared/leader20/batch-runtime.mjs';

const slot=Math.floor(Date.now()/SLOT_MS)*SLOT_MS;
const window=(over={})=>({version:CLOCK_VERSION,slot_ms:slot,expires_at_ms:slot+EXECUTION_MS,...over});
const row=(leader20)=>({id:'s',symbol:'C0USDT',features:{leader20}});

test('the clock entry deadline is derived from the slot and no TTL can widen it',async t=>{
 await t.test('a stored expiry beyond the slot window is tightened, never honoured',()=>{
  const w=window();
  // The honest case: materialization writes exactly slot+120s.
  assert.equal(eventExpiry(row({entry_window:w,expires_at_ms:slot+EXECUTION_MS})),slot+EXECUTION_MS);
  // Raising CAMPAIGN_POLICY.eventTtlMs, or writing a larger expires_at_ms, must not extend it.
  for(const stored of [slot+EXECUTION_MS+1,slot+EXECUTION_MS+60000,slot+3600000,Number.MAX_SAFE_INTEGER])
   assert.equal(eventExpiry(row({entry_window:w,expires_at_ms:stored})),slot+EXECUTION_MS,
    'stored '+stored+' must be clamped to the slot deadline');
  // A tighter stored expiry is still respected: the rule only ever narrows.
  assert.equal(eventExpiry(row({entry_window:w,expires_at_ms:slot+30000})),slot+30000);
 });
 await t.test('a malformed clock window is already expired, never open-ended',()=>{
  for(const bad of [window({slot_ms:slot+1}),window({version:'SOMETHING_ELSE'}),
   window({slot_ms:Number.NaN}),window({slot_ms:null})]){
   assert.equal(clockAuthorityDeadline(bad),null);
   assert.equal(eventExpiry(row({entry_window:bad,expires_at_ms:slot+3600000})),null,
    'fail closed rather than inherit a stored TTL');
  }
 });
 await t.test('a legacy non-clock entry keeps its own stored expiry unchanged',()=>{
  assert.equal(eventExpiry(row({expires_at_ms:slot+45000})),slot+45000);
  assert.equal(CAMPAIGN_POLICY.eventTtlMs,120000,'the documented TTL itself is unchanged');
 });
 await t.test('the derived deadline is exactly slot + EXECUTION_MS on a valid window',()=>{
  assert.equal(clockAuthorityDeadline(window()),slot+EXECUTION_MS);
  assert.equal(clockAuthorityDeadline(window({slot_ms:slot+SLOT_MS})),slot+SLOT_MS+EXECUTION_MS);
 });
});

test('FINAL is never dispatched into a window that cannot hold its answer',async t=>{
 const packet=at=>({task:'ENTRY',symbol:'C0USDT',
  leader20:{entry_window:window(),batch_advice:{id:'C0USDT',decision:'PASS',last_ms:at-1000}}});
 await t.test('a dead window is refused before the paid call, with its own reason',async()=>{
  let calls=0;const at=slot+EXECUTION_MS-CLOCK_FINAL_MIN_BUDGET_MS+1;
  const r=await batchFinalDecision(packet(at),{now:()=>at,call:async()=>{calls++;return {};}});
  assert.equal(calls,0);assert.equal(r.attempted,false);
  assert.equal(r.error,'CLOCK_FINAL_WINDOW_INSUFFICIENT');
  assert.notEqual(r.error,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',
   'a never-attempted call is distinguishable from one that ran out');
 });
 await t.test('an already-expired window still reports the expiry, not the budget floor',async()=>{
  let calls=0;const at=slot+EXECUTION_MS;
  const r=await batchFinalDecision(packet(at),{now:()=>at,call:async()=>{calls++;return {};}});
  assert.equal(calls,0);assert.equal(r.error,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
 });
});

test('a dead collector is named as such instead of looking like a capture problem',async t=>{
 const members=Array.from({length:20},(_,i)=>({symbol:`C${i}USDT`,rank:i+1}));
 const build=health=>{
  const notes=[],seen=[];let at=slot+2000;
  const db={from(){return {select(){return this;},eq(){return this;},lte(){return this;},
   async maybeSingle(){return {data:{decision_reserve_ms:80000,last_periodic_slot:null}};},
   async order(){return {data:members};}};},async rpc(name,args){
    seen.push(name);
    if(name==='leader20_clock_note'){notes.push(args.p_data);return {data:{recorded:true}};}
    if(name==='leader20_collector_health')return {data:health};
    if(name==='leader20_batch_capacity')return {data:{available:2,available_for_new_entry:2,certain:true,
     held:[],open_symbols:[],open_positions:0,reserved_slots:0,max_slots:10,target_margin_per_slot:152.021375,
     futures_available_margin:400,reason:null}};
    throw Error('Unexpected RPC '+name);
   }};
  return {db,notes,seen,options:{now:()=>at,apiKey:'fixture',sleep:async ms=>{at+=ms;},
   fetchFn:async()=>{throw Error('no network in this test');}}};
 };
 await t.test('COLLECTOR_DOWN stops the slot without a capture read or a retry loop',async()=>{
  const h=build({live:false,reason:'COLLECTOR_DOWN',heartbeat_age_ms:14401000});
  const r=await runEntryBatch(h.db,{clock_capture_enabled:true,epoch_id:'e',generation:4},h.options);
  assert.equal(r.created,false);
  assert.equal(r.reason,'COLLECTOR_DOWN','the outage names itself');
  assert.notEqual(r.reason,'DECISION_WINDOW_INSUFFICIENT');
  assert.equal(h.seen.includes('doa_context_for_role_v1'),false,'no capture read against absent streams');
  assert.equal(h.seen.includes('leader20_batch_claim'),false,'no batch, no provider spend');
  const note=h.notes.at(-1);
  assert.equal(note.batch_reason,'COLLECTOR_DOWN');
  assert.equal(note.collector_reason,'COLLECTOR_DOWN');
  assert.equal(note.collector_heartbeat_age_ms,14401000);
  assert.equal(note.slot_status,'EXPIRED');
 });
 await t.test('a live collector is untouched and proceeds to the capture read',async()=>{
  const h=build({live:true,reason:null,heartbeat_age_ms:3000});
  await runEntryBatch(h.db,{clock_capture_enabled:true,epoch_id:'e',generation:4},h.options)
   .catch(()=>{/* the capture read itself is out of scope here */});
  assert.equal(h.seen.includes('doa_context_for_role_v1'),true,'a live collector still gets its capture read');
 });
});

test('the FINAL fan-out spends the slot window on candidates that can still be ordered',async t=>{
 const {gptFilterExecutable,setTestCoordinator}=await import('../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs');
 const signals=Array.from({length:20},(_,i)=>({id:'s'+i,symbol:`C${i}USDT`,status:'NEW',
  features:{leader20:{version:'LEADER20_DYNAMIC_1',symbol:`C${i}USDT`,entry_window:window(),
   expires_at_ms:slot+EXECUTION_MS}}}));
 // Each FINAL costs perCall ms of the shared window; the fan-out runs four at a time.
 const build=({at,perCall})=>{
  let now=at;const considered=[];
  const c={injected:true,config:{mode:'ENFORCE'},tickets:new Map(),clockWakeAt:new Map(),
   now:()=>now,schedule:()=>{},yieldArmed:false,
   consider:async s=>{considered.push(s.id);now+=perCall;return {allowed:true,reason:'PASS'};}};
  const db={rpc:async()=>({data:{allowed:true}}),
   from(){return {select(){return this;},eq(){return this;},
    async maybeSingle(){return {data:{active_strategy:'LEADER20_DYNAMIC_1'}};}};}};
  setTestCoordinator(db,c);
  return {db,considered,get now(){return now;}};
 };
 await t.test('a whole-window fan-out no longer expires every candidate together',async()=>{
  // The measured failure: 20 candidates x ~5.8s served four at a time needs ~29s of model time,
  // but slot-to-GPT-completion reached 180.6s at p95 against a 120s window.
  const h=build({at:slot+20000,perCall:6000});
  const r=await gptFilterExecutable(h.db,signals);
  assert.ok(h.considered.length<20,'the fan-out stops instead of running past the deadline');
  assert.ok(r.candidates.length>0,'the candidates reviewed inside the window keep a real chance');
  assert.ok(h.now<slot+EXECUTION_MS,'no work is started after the authority expires');
  const stopped=r.reviews.filter(x=>x.reason==='CLOCK_FINAL_WINDOW_INSUFFICIENT');
  assert.equal(stopped.length,20-h.considered.length,'every skipped candidate says why');
  assert.equal(r.reviews.length,20,'and all twenty are still accounted for');
 });
 await t.test('a window with room for everyone still reviews all twenty',async()=>{
  const h=build({at:slot,perCall:200});
  const r=await gptFilterExecutable(h.db,signals);
  assert.equal(h.considered.length,20);
  assert.equal(r.candidates.length,20);
  assert.equal(r.reviews.some(x=>x.reason==='CLOCK_FINAL_WINDOW_INSUFFICIENT'),false);
 });
 await t.test('an already-spent window starts no FINAL at all',async()=>{
  const h=build({at:slot+EXECUTION_MS-1,perCall:100});
  const r=await gptFilterExecutable(h.db,signals);
  assert.equal(h.considered.length,0,'not one paid call against a dead window');
  assert.equal(r.candidates.length,0);
  assert.equal(r.reviews.every(x=>x.reason==='CLOCK_FINAL_WINDOW_INSUFFICIENT'),true);
 });
});
