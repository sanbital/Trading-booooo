import test from 'node:test';
import assert from 'node:assert/strict';
import {validCapture,dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {src,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket,modelInput,hash,MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {DYNAMIC_VERSION,dispatchDynamicSafety} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {dualEntryDecision} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {ENTRY_ANALYSIS,entryAnalysisDeadline} from '../supabase/functions/_shared/gpt-final-decision/entry-analysis.mjs';
import {FD1_ENTRY_ENGINE} from '../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
const T=1800000000200;
async function fixture({age=1500,finalMs=16000,preliminaryMs=7000,task='ENTRY',deadlineOffset=30000}={}){
 const capture=validCapture(T);let at=capture.end_ms+age,calls=0;
 const start=at,leader20={version:'LEADER20_DYNAMIC_1',event_id:'event',epoch_id:'epoch',generation:1,
  symbol:'ABCUSDT',requested_at_ms:start-1000,expires_at_ms:start+100000};
 const p=await buildDecisionPacket({task,subjectId:'analysis',symbol:'ABCUSDT',dataMode:'LIVE',
  facts:computeFacts({...src(T),captureContext:capture},{asOf:start,referenceClose:1})});
 Object.assign(p,{dynamic_policy:DYNAMIC_VERSION,dynamic_as_of_ms:start,leader20,as_of_offset_ms:1000});
 p.snapshot_hash=await hash({...p,snapshot_hash:''});
 const run=async(packet=p,deadline=start+deadlineOffset)=>dualEntryDecision(packet,{apiKey:'test',now:()=>at,snapshotAtMs:start,deadlineMs:deadline,
  fetchFn:async()=>{throw Error('No network');},
  counterCall:async(s,o)=>{calls++;at+=Math.min(preliminaryMs,o.timeoutMs);return {valid:false,attempted:false,error:'DEEPSEEK_KEY_MISSING',snapshot_hash:s.snapshot_hash};},
  gptCall:async(packet,o)=>{
   calls++;const input=JSON.parse(o.payloadFn(packet).input[1].content);
   if(!input.independent_reviews)return {valid:false,attempted:false,error:'PRELIMINARY'};
   const wire={...dynamicWire(entryWire({t:task,c:packet.candidate_id,d:'BUY',support:['return_5m'],n:'Continuation'}),modelInput(packet)),
    action:'ENTER',pressure_state:'RISING',decision_reason:'Buyer flow supports price',counter_evidence:[],
    thesis_invalidation:'Loss of support',next_review_conditions:'New flow evidence',
    arbitration:{considered:[],adopted:[],rejected:[],supporting:[],opposing:[],reason:'Current flow'}};
   at+=finalMs;return {valid:true,wire,answer:wire,decision:'BUY',attempted:true,request_id:'fixture-request'};
  }});
 return {p,run,start,now:()=>at,calls:()=>calls};
}
test('23-second initial analysis keeps all 24 buckets and every provider on the same frozen input',async()=>{
 const f=await fixture(),r=await f.run();
 assert.equal(r.valid,true);assert.equal(r.decision,'BUY');assert.equal(f.calls(),3);
 assert.equal(r.dynamic_audit.capture_valid,false,'completion does not mislabel old evidence as fresh');
 assert.equal(r.dynamic_audit.capture_valid_at_start,true);assert.equal(r.dynamic_audit.requires_final_recheck,true);
 assert.equal(r.arbitration.analysis_mode,ENTRY_ANALYSIS.version);
 assert.equal(r.arbitration.initial_input.capture_context.ordered_path.length,24);
 assert.deepEqual(r.arbitration.initial_input.capture_context,r.arbitration.final_input.capture_context);
 assert.equal(r.arbitration.gpt_first_snapshot_hash,r.arbitration.gpt_snapshot_hash);
 assert.equal(r.arbitration.deepseek_snapshot_hash,r.arbitration.gpt_snapshot_hash);
 assert.ok(r.dynamic_audit.latency_budget.final_available_ms>=20000);
 assert.equal(dispatchDynamicSafety({reviewed:f.p.facts.capture_context,latest:validCapture(f.now()),at:f.now()}).ok,false);
});
test('initial analysis still rejects stale starts and caller/30-second deadline overruns',async()=>{
 const stale=await fixture({age:10000});assert.equal((await stale.run()).valid,false);assert.equal(stale.calls(),0);
 for(const opts of [{finalMs:24000},{finalMs:16000,deadlineOffset:20000}]){
  const f=await fixture(opts),r=await f.run();assert.equal(r.valid,false);assert.equal(r.error,'FD_ARBITRATION_EXPIRED');
 }
});
test('extended analysis never applies to RECHECK or HOLD',()=>{
 const packet={task:'ENTRY',dynamic_policy:DYNAMIC_VERSION,leader20:{version:'LEADER20_DYNAMIC_1'}};
 const args={now:T,executionDeadline:T+90000,ordinaryDeadline:T+10000};
 assert.equal(entryAnalysisDeadline(packet,args),T+30000);
 for(const p of [{...packet,task:'RECHECK'},{...packet,task:'HOLD'},{...packet,leader20:null}])
  assert.equal(entryAnalysisDeadline(p,args),args.ordinaryDeadline);
 assert.equal(entryAnalysisDeadline(packet,{...args,executionDeadline:T+29999}),null);
 assert.equal(entryAnalysisDeadline(packet,{...args,executionDeadline:T+30000}),T+15000);
});
test('durable campaign BUY cannot dispatch even if fast; delayed BUY gets a ticket only for fresh recheck',async()=>{
 for(const finalMs of [1000,16000]){
  const f=await fixture({finalMs}),s={id:'analysis',symbol:'ABCUSDT',status:'NEW',features:{leader20:f.p.leader20,
   referenceClose:1,rank:1,exitPolicy:{stopPct:.025}}};
  const c=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'fixture',apiBudgetUsd:1.25,maxCalls:100,enforceApproved:true},
   store:new MemoryReviewStore(),apiKey:()=> 'fixture',now:f.now,baseline:()=>true,expiry:()=>s.features.leader20.expires_at_ms,
   engine:{...FD1_ENTRY_ENGINE,prepare:async()=>({packet:f.p,captured:f.start}),
    call:async(p,o)=>{assert.ok(o.deadlineMs>f.start+15000);const r=await f.run(p,o.deadlineMs);
     return {...r,origin:'OPENAI_API',model_requested:MODEL,raw_response:{model:MODEL,wire:r.wire},wire_profile:FD1_ENTRY_ENGINE.id};}}});
  await c.consider(s);await Promise.all([...c.pending.values()]);
  const reviewed=await c.consider(s);assert.equal(reviewed.allowed,true,JSON.stringify(reviewed));
  assert.equal(c.check(s).allowed,false);assert.equal(c.check(s).reason,'GPT_FINAL_RECHECK_REQUIRED');
  assert.equal(c.beginExecution(s),null);
  assert.equal(c.check(s,{allowAged:true}).allowed,true);
  assert.equal(c.check(s,{supersededBy:'fresh-recheck-validated-by-adapter'}).allowed,true);
  assert.equal(c.tickets.get('analysis').validUntil,f.start+15000,'original answer lifetime is unchanged');
 }
});
test('a short remaining event cannot start paid inference and reserve time needed for FINAL RECHECK',async()=>{
 const f=await fixture(),s={id:'analysis',symbol:'ABCUSDT',features:{leader20:f.p.leader20,referenceClose:1,rank:1,exitPolicy:{}}};
 const c=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'fixture',apiBudgetUsd:1.25,maxCalls:100,enforceApproved:true},
  store:new MemoryReviewStore(),apiKey:()=> 'fixture',now:f.now,baseline:()=>true,expiry:()=>f.start+30000,
  engine:{...FD1_ENTRY_ENGINE,prepare:async()=>({packet:f.p,captured:f.start}),call:()=>assert.fail('paid inference must not start')}});
 await c.consider(s);await Promise.all([...c.pending.values()]);
 const row=[...c.store.rows.values()][0];assert.equal(row.record.result.error,'REVIEW_RECHECK_ROOM_REQUIRED');
 assert.equal(row.record.result.attempted,false);assert.equal(row.record.result.api_cost_usd,0);
});
