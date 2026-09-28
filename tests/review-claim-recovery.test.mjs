import test from 'node:test';
import assert from 'node:assert/strict';
import {SupabaseReviewStore} from '../supabase/functions/_shared/gpt-final-review/supabase-store.mjs';
import {FinalReviewCoordinator} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';

const config={apiBudgetUsd:50,maxCalls:100};
const packet={snapshot_hash:'immutable',facts:{trajectory:[{start_ms:1000,end_ms:6000,net:-4}]}};
const record=()=>({packet:structuredClone(packet),expires_at_ms:120000,binding:'bound',identity:{signal_id:'signal'}});
function committedButLost({competing=false,done=false,throws=false}={}){
 let row,calls=0,inserts=0;const args=[];
 const db={rpc:async(name,a)=>{
  assert.equal(name,'gpt_final_review_claim');calls++;args.push(structuredClone(a));
  if(!row){inserts++;row={owner:'durable-owner',state:done?'DONE':'RUNNING',provider_ledger:true,
   record:{...structuredClone(a.p_record),...(competing?{claim_attempt_id:'other-worker'}:{})}};
   if(throws)throw new DOMException('signal timed out','TimeoutError');
   return {error:{message:'AbortError: request aborted'}};
  }
  return {data:{created:false,row:structuredClone(row)}};
 }};
 return {db,stats:()=>({calls,inserts,args,row})};
}

for(const throws of [false,true])test(`committed claim with lost ${throws?'thrown':'returned'} response resumes its own owner once`,async()=>{
 const h=committedButLost({throws}),s=new SupabaseReviewStore(h.db),r=record(),before=structuredClone(r);
 const claim=await s.claim('key',r,config);
 assert.equal(claim.created,true);assert.equal(claim.row.owner,'durable-owner');
 assert.equal(h.stats().inserts,1);assert.equal(h.stats().calls,2);
 assert.deepEqual(h.stats().args[0],h.stats().args[1]);
 assert.equal(s.ledgerModes.get('key'),true);assert.deepEqual(r,before);
 assert.deepEqual(claim.row.record.packet,packet);assert.equal(claim.row.record.expires_at_ms,120000);
});

test('a competing worker cannot inherit a lost claim',async()=>{
 const h=committedButLost({competing:true}),s=new SupabaseReviewStore(h.db);
 const r=await s.claim('key',record(),config);
 assert.equal(r.created,false);assert.equal(h.stats().inserts,1);
});

test('a completed claim cannot be restarted by acknowledgement recovery',async()=>{
 const h=committedButLost({done:true}),s=new SupabaseReviewStore(h.db);
 assert.equal((await s.claim('key',record(),config)).created,false);
});

test('claim retries are bounded; budget and authorization refusals are not retried',async()=>{
 for(const [error,expected,pattern] of [[{code:'55P03'},3,/REVIEW_STORE_CLAIM/],
  [{message:'API_BUDGET_EXHAUSTED'},1,/API_BUDGET_EXHAUSTED/],
  [{message:'APPROVED_API_BUDGET_REQUIRED'},1,/REVIEW_STORE_CLAIM/]]){
  let calls=0;const s=new SupabaseReviewStore({rpc:async()=>{calls++;return {error};}});
  await assert.rejects(s.claim('key',record(),config),pattern);assert.equal(calls,expected);
 }
});

test('separate claim invocations never reuse a caller supplied attempt marker',async()=>{
 const markers=[];const s=new SupabaseReviewStore({rpc:async(_name,a)=>{
  markers.push(a.p_record.claim_attempt_id);return {data:{created:false,row:{owner:'old',state:'RUNNING',record:a.p_record}}};
 }});
 const r={...record(),claim_attempt_id:'caller-supplied'};
 assert.equal((await s.claim('key',r,config)).created,false);
 assert.equal((await s.claim('key',r,config)).created,false);
 assert.notEqual(markers[0],markers[1]);assert.notEqual(markers[0],'caller-supplied');
});

test('ten simultaneous committed-response losses retain one durable claim per symbol',async()=>{
 const rows=new Map(),attempts=new Map();let inserts=0;
 const db={rpc:async(_name,a)=>{
  attempts.set(a.p_job_key,(attempts.get(a.p_job_key)??0)+1);
  if(!rows.has(a.p_job_key)){
   inserts++;rows.set(a.p_job_key,{owner:crypto.randomUUID(),state:'RUNNING',provider_ledger:true,record:structuredClone(a.p_record)});
   return {error:{message:'fetch failed'}};
  }
  return {data:{created:false,row:structuredClone(rows.get(a.p_job_key))}};
 }};
 const keys=Array.from({length:10},(_,i)=>`symbol-${i}`);
 const owned=await Promise.all(keys.map(k=>new SupabaseReviewStore(db).claim(k,record(),config)));
 assert.equal(owned.filter(r=>r.created).length,10);assert.equal(inserts,10);
 const competing=await Promise.all(keys.map(k=>new SupabaseReviewStore(db).claim(k,record(),config)));
 assert.equal(competing.filter(r=>r.created).length,0);assert.equal(inserts,10);
 assert.equal(new Set(owned.map(r=>r.row.owner)).size,10);
});

test('claim recovery after the immutable deadline never reaches the provider',async()=>{
 const started=Date.now();let clock=started,calls=0,saved,completed;const tasks=[];
 const db={rpc:async(_name,a)=>{
  if(!saved){saved={owner:'owner',state:'RUNNING',provider_ledger:true,record:structuredClone(a.p_record)};
   clock=started+200000;return {error:{message:'fetch failed'}};}
  return {data:{created:false,row:saved}};
 }};
 const store=new SupabaseReviewStore(db);store.get=async()=>null;store.snapshot=async()=>{};
 store.complete=async(_key,owner,r)=>{assert.equal(owner,'owner');completed=r;};
 const engine={id:'DEADLINE_TEST',model:'test',allow:'BUY',promptText:'test',schema:{},identity:s=>({signal_id:s.id,symbol:s.symbol,trigger_at_ms:started}),
  prepare:async()=>({packet:{snapshot_hash:'unchanged'},captured:started}),
  packetHash:async()=> 'unchanged',call:async()=>{calls++;throw Error('UNREACHABLE');}};
 const c=new FinalReviewCoordinator({config:{...config,mode:'ENFORCE',modeValid:true,approvalRef:'test',enforceApproved:true},
  apiKey:()=> 'test',store,engine,now:()=>clock,baseline:()=>true,expiry:()=>started+120000,schedule:p=>tasks.push(p)});
 await c.consider({id:'signal',symbol:'TESTUSDT'});await Promise.all(tasks);
 assert.equal(calls,0);assert.equal(completed.expires_at_ms,started+120000);
 assert.equal(completed.result.error,'REVIEW_TRIGGER_EXPIRED');assert.equal(completed.result.attempted,false);
});
