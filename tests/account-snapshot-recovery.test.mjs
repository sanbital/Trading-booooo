import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FinalReviewCoordinator,MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {hash} from '../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {isReviewRecoverable,isReviewTimeout,canRecoverTimeout,TIMEOUT_RECOVERY} from '../supabase/functions/_shared/gpt-final-decision/timeout-recovery.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
const fixture=JSON.parse(await readFile(new URL('../test-support/production-capacity-gap-20260928.json',import.meta.url)));
const observed=fixture.review_rows[0].result,T=1800000000000;
const cfg={mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:10,maxCalls:100,enforceApproved:true};
function harness({persistent=false,auto=true,freeze=false,maxCalls=100,late=false,fullAfter=false}={}){
 let at=T+1000,attempts=0,paid=0;const store=new MemoryReviewStore(),ends=[];
 const signal={id:'account-gap',symbol:'ONEUSDT',features:{v17Setup:{triggerAt:T}}};
 const engine={id:'ACCOUNT_GAP_TEST',model:'test',allow:'BUY',schema:{},promptText:'test',timeoutRecovery:auto,
  identity:s=>({signal_id:s.id,symbol:s.symbol,trigger_at_ms:T}),reobserveWait:()=>false,
  async prepare(i,o){if(attempts)at+=5000;const c=validCapture(freeze?T+1000:at);ends.push({end:c.end_ms,after:o.afterEndMs});
   const p={candidate_id:'candidate',as_of_offset_ms:at-T,facts:{capture_context:c},snapshot_hash:''};p.snapshot_hash=await hash(p);return {packet:p,captured:at};},
  packetHash:p=>hash({...p,snapshot_hash:''}),
  async call(){attempts++;at+=100;if(persistent||attempts===1||fullAfter){const result=structuredClone(observed);
   if(fullAfter&&attempts>1)result.budget_block.capacity.reason='PENDING_CAPITAL_RESERVED';
   return {...result,completed_at_ms:at,model_requested:'test',wire_profile:'ACCOUNT_GAP_TEST'};}
   paid++;at+=1000;return {origin:'OPENAI_API',valid:true,decision:'WAIT',error:null,attempted:true,completed_at_ms:at,model_requested:'test',
     raw_response:{model:'test',wire:{decision:'WAIT'}},request_id:'mock-only',wire_profile:'ACCOUNT_GAP_TEST'};},
  revalidate:r=>r.raw_response.wire};
 const expiry=()=>late?T+12000:T+60000;
 const make=()=>new FinalReviewCoordinator({config:{...cfg,maxCalls},store,apiKey:()=>'mock',engine,baseline:()=>true,expiry,now:()=>at});
 const c=make();return{c,make,store,signal,ends,get paid(){return paid;},get attempts(){return attempts;}};
}
async function drain(c){while(c.pending.size)await Promise.all([...c.pending.values()]);}
test('all three original uncalled account gaps become recoverable without interpreting them as provider timeouts',()=>{
 for(const row of fixture.review_rows){const r=row.result;assert.equal(r.attempted,false);assert.equal(r.api_cost_usd,0);
  assert.equal(isReviewRecoverable(r),true);assert.equal(isReviewTimeout(r),false);
  assert.equal(canRecoverTimeout(r,{now:r.completed_at_ms,deadline:row.packet.leader20.expires_at_ms-2500,attempt:1}),true);
  const c=row.packet.facts.capture_context;assert.equal(c.trajectory.length,24);assert.ok(c.valid&&c.complete&&c.causal);
  assert.ok(c.trajectory.every((v,i)=>v.start_ms<v.end_ms&&(!i||v.start_ms===c.trajectory[i-1].end_ms)));
 }
 const prior=fixture.snapshot_rows.find(x=>x.id===924448);assert.equal(Date.parse(prior.captured_at)+90000,Date.parse('2026-09-28T08:41:18.015Z'));
 const inserts=fixture.logs.filter(x=>x.path==='/rest/v1/trading_account_snapshots'&&x.method==='POST');
 assert.ok(inserts.every(x=>Date.parse(x.at+'Z')>Math.max(...fixture.review_rows.map(x=>x.result.completed_at_ms))));
});
test('capacity, pending exposure, unreadable account, budget and ambiguous dispatch never enter account recovery',()=>{
 const variants=[
  {...observed,valid:true},{...observed,attempted:true},{...observed,attempted:null},{...observed,api_cost_usd:null},{...observed,api_cost_usd:.01},
  {...observed,error:'API_BUDGET_EXHAUSTED'},{...observed,budget_block:null},
  {...observed,budget_block:{...observed.budget_block,created:true}},
  ...['NO_ENTRY_CAPACITY','PENDING_CAPITAL_RESERVED','ACCOUNT_SNAPSHOT_UNREADABLE',null].map(reason=>({...observed,budget_block:{...observed.budget_block,capacity:{available:0,reason}}}))
 ];for(const r of variants)assert.equal(isReviewRecoverable(r),false,JSON.stringify(r.budget_block));
});
test('coordinator re-prepares advanced capture under original expiry; recovered WAIT grants no entry',async()=>{
 const h=harness();await h.c.consider(h.signal);await drain(h.c);
 assert.equal(h.attempts,2);assert.equal(h.paid,1);assert.equal(h.store.rows.size,2);
 const rows=[...h.store.rows.values()];assert.equal(rows[0].record.result.attempted,false);assert.equal(rows[1].record.result.decision,'WAIT');
 assert.equal(rows[0].record.expires_at_ms,rows[1].record.expires_at_ms);assert.equal(rows[1].record.expires_at_ms,T+60000);
 assert.ok(h.ends[1].end>h.ends[0].end);assert.equal(h.ends[1].after,h.ends[0].end);assert.equal(h.c.check(h.signal).allowed,false);
 assert.equal((await h.c.consider(h.signal)).decision,'WAIT');assert.equal(h.paid,1);
});
test('same recovery is claimed once across concurrent coordinators',async()=>{
 const h=harness({auto:false});await h.c.consider(h.signal);await drain(h.c);h.c.engine.timeoutRecovery=true;
 const other=h.make();await Promise.all([h.c.consider(h.signal),other.consider(h.signal)]);await Promise.all([drain(h.c),drain(other)]);
 assert.equal(h.paid,1);assert.equal(h.store.rows.size,2);assert.equal(h.attempts,2);
});
test('persistent missing account is bounded and cannot call a provider or create BUY',async()=>{
 const h=harness({persistent:true});await h.c.consider(h.signal);await drain(h.c);
 assert.equal(h.attempts,TIMEOUT_RECOVERY.maxAttempts);assert.equal(h.paid,0);assert.equal(h.store.rows.size,4);
 assert.equal((await h.c.consider(h.signal)).reason,'GPT_REVIEW_RECOVERY_EXHAUSTED');assert.equal(h.c.check(h.signal).allowed,false);
});
test('late trigger, unchanged capture, exhausted journal budget and new pending exposure remain blocked',async()=>{
 for(const options of [{late:true},{freeze:true},{maxCalls:1},{fullAfter:true}]){
  const h=harness(options);await h.c.consider(h.signal);await drain(h.c);assert.equal(h.paid,0,JSON.stringify(options));assert.equal(h.c.check(h.signal).allowed,false);
 }
});
