import test from 'node:test';
import assert from 'node:assert/strict';
import {validCapture,dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {src,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket,modelInput,hash} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {DYNAMIC_VERSION} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {dualEntryDecision} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';

// Virtual inference delays, not production latency measurements.
const T=1800000000200;
async function run(age,{finalMs=3500,deadlineMs=null}={}){
 const capture=validCapture(T),p=await buildDecisionPacket({task:'ENTRY',subjectId:'latency',symbol:'ABCUSDT',dataMode:'LIVE',
  facts:computeFacts({...src(T),captureContext:capture},{asOf:T,referenceClose:1})});
 p.dynamic_policy=DYNAMIC_VERSION;p.dynamic_as_of_ms=T;
 p.snapshot_hash=await hash({...p,snapshot_hash:''});
 let at=capture.end_ms+age,firstCalls=0,advisorCalls=0,finalCalls=0;
 const out=await dualEntryDecision(p,{apiKey:'test',now:()=>at,snapshotAtMs:at,deadlineMs:deadlineMs??at+20000,
  fetchFn:async()=>{throw Error('No network in this regression');},
  counterCall:async(s,o)=>{advisorCalls++;at+=o.timeoutMs;
   return {valid:false,attempted:true,error:'DEEPSEEK_TIMEOUT',snapshot_hash:s.snapshot_hash};},
  gptCall:async(packet,o)=>{
   const input=JSON.parse(o.payloadFn(packet).input[1].content);
   if(!input.independent_reviews){firstCalls++;return {valid:false,attempted:false,error:'PRELIMINARY'};}
   finalCalls++;
   const wire={...dynamicWire(entryWire({t:'ENTRY',c:packet.candidate_id,d:'BUY',support:['return_5m'],n:'Continuation'}),modelInput(packet)),
    arbitration:{considered:[],adopted:[],rejected:[],supporting:[],opposing:[],reason:'Current flow'}};
   at+=finalMs;
   return {valid:true,wire,answer:wire,decision:'BUY',attempted:true};
  }});
 return {out,firstCalls,advisorCalls,finalCalls};
}

test('slow advisory cannot consume FINAL budget and expire a fresh snapshot',async()=>{
 const {out,firstCalls,advisorCalls,finalCalls}=await run(3000);
 assert.equal(firstCalls,1);assert.equal(advisorCalls,1);assert.equal(finalCalls,1);
 assert.equal(out.valid,true);assert.equal(out.decision,'BUY');
 const b=out.dynamic_audit.latency_budget;
 assert.equal(b.capture_age_at_start_ms,3000);
 assert.ok(b.advisory_timeout_ms<=2750);
 assert.ok(b.final_available_ms>=4000);
 assert.equal(b.final_ms,3500);assert.equal(b.expired_during_inference,false);
 assert.ok(out.dynamic_audit.capture_age<10000);
 assert.equal(out.arbitration.snapshot_hash,out.arbitration.final_snapshot_hash);
});

test('short lifetime retains independent opinions within a smaller shared wait',async()=>{
 const {out,firstCalls,advisorCalls,finalCalls}=await run(6000,{finalMs:2500});
 assert.equal(firstCalls,1);assert.equal(advisorCalls,1);assert.equal(finalCalls,1);
 assert.equal(out.valid,true);
 assert.equal(out.arbitration.deepseek_valid,false);
 assert.equal(out.arbitration.deepseek_error,'DEEPSEEK_TIMEOUT');
 assert.ok(out.dynamic_audit.latency_budget.advisory_timeout_ms<=750);
 assert.equal(out.dynamic_audit.latency_budget.final_ms,2500);
});

test('overrunning FINAL still fails closed and identifies inference expiry',async()=>{
 const {out}=await run(3000,{finalMs:5000});
 assert.equal(out.valid,false);assert.equal(out.decision,'WAIT');assert.match(out.error,/STALE_OR_FUTURE/);
 assert.equal(out.dynamic_audit.latency_budget.expired_during_inference,true);
});

test('already stale input starts no providers',async()=>{
 const {out,firstCalls,advisorCalls,finalCalls}=await run(10000);
 assert.equal(out.valid,false);assert.equal(out.decision,'WAIT');
 assert.equal(firstCalls+advisorCalls+finalCalls,0);
 assert.equal(out.origin,'LOCAL_DYNAMIC_GATE');
});

test('caller deadline remains stricter than capture freshness',async()=>{
 const {out,firstCalls,advisorCalls}=await run(3000,{deadlineMs:T+3500,finalMs:1000});
 assert.equal(firstCalls+advisorCalls,2);
 assert.equal(out.valid,false);assert.equal(out.error,'FD_ARBITRATION_EXPIRED');
 assert.equal(out.dynamic_audit.latency_budget.expired_during_inference,false);
});
