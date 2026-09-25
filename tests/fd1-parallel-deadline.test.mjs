import test from 'node:test';
import assert from 'node:assert/strict';
import {parallelReview,startParallelReview,collectParallelReview,MODEL_CANDIDATES,REALTIME_MODEL_CANDIDATES,TASK_REQUEST_MS} from '../supabase/functions/_shared/gpt-final-decision/parallel.mjs';
import {RECHECK_POLICY} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {REQUEST_MS} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
const shared=(at,task='ENTRY')=>({packet:{task},snapshot_at_ms:at,snapshot_hash:'test'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const task of ['ENTRY','HOLD','RECHECK'])test(task+' real-clock counter timeout cannot delay or override GPT',async()=>{
  const at=Date.now(),decision=task==='HOLD'?'HOLD':'BUY';let counterFinished=false;
  const r=await parallelReview(shared(at,task),{deadlineMs:at+200,maxAgeMs:1000,
    gptCall:async()=>({valid:true,decision,completed_at_ms:Date.now()}),
    counterCall:async(s,o)=>{await pause(o.timeoutMs);counterFinished=true;return {valid:false,error:'COUNTER_TIMEOUT'};}});
  assert.equal(counterFinished,false);assert.equal(r.fusion.decision,decision);assert.ok(r.completed_at_ms<at+200);
  await pause(230);assert.equal(r.fusion.decision,decision,'late completion cannot mutate baseline');
});
test('research collector keeps decision-time freshness with advancing clock',async()=>{
  let at=10000,release;const gate=new Promise(r=>{release=r;});
  const work=startParallelReview(shared(at),{now:()=>at,deadlineMs:10200,maxAgeMs:8000,
    gptCall:async()=>({valid:true,decision:'BUY',completed_at_ms:10000}),counterCall:async()=>{await gate;return {valid:true,answer:{decision:'OPPOSE_BUY'}};}});
  const baseline=await work.baseline;at=10201;release();const counter=await work.counter;
  assert.equal(baseline.fusion.decision,'BUY');assert.equal(baseline.completed_at_ms,10000);
  assert.equal(counter.valid,false);assert.equal(counter.error,'COUNTER_STALE');
});
test('collector with real counter deadline preserves timely BUY',async()=>{
  const at=Date.now(),r=await collectParallelReview(shared(at),{deadlineMs:at+80,maxAgeMs:1000,
    gptCall:async()=>({valid:true,decision:'BUY',completed_at_ms:Date.now()}),counterCall:async(s,o)=>{await pause(o.timeoutMs);return {valid:false,error:'COUNTER_TIMEOUT'};}});
  assert.equal(r.fusion.decision,'BUY');assert.ok(r.completed_at_ms<at+80);assert.equal(r.counter.valid,false);
});
for(const kind of ['late','future-timestamp','old-snapshot','reject','hang'])test('GPT '+kind+' still abstains independently',async()=>{
  let at=10000;const r=await parallelReview(shared(at),{now:()=>at,deadlineMs:10100,maxAgeMs:kind==='old-snapshot'?10:8000,
    gptCall:async()=>{if(kind==='hang')return new Promise(()=>{});if(kind==='reject')throw Error('private');
      if(kind==='late')at=10101;if(kind==='old-snapshot')at=10011;
      return {valid:true,decision:'BUY',completed_at_ms:kind==='future-timestamp'?at+1:at};},counterCall:async()=>({valid:true,answer:{decision:'SUPPORT_BUY'}})});
  assert.equal(r.fusion.decision,'ABSTAIN');assert.deepEqual(r.fusion.authority,[]);
});
test('task request caps and 3000ms execution reserve are intersected',async()=>{
  assert.equal(TASK_REQUEST_MS.RECHECK,RECHECK_POLICY.requestTimeoutMs);assert.equal(TASK_REQUEST_MS.HOLD,REQUEST_MS);
  for(const [task,expires,want] of [['HOLD',30000,8000],['RECHECK',30000,4000],['RECHECK',14500,1500],['HOLD',14500,1500]]){
    const seen=[];const call=async(s,o)=>{seen.push(o.timeoutMs);return {valid:false};};
    await collectParallelReview(shared(10000,task),{now:()=>10000,deadlineMs:25000,maxAgeMs:30000,triggerExpiresAtMs:expires,gptCall:call,counterCall:call});
    assert.deepEqual(seen,[want,want]);
  }
  await assert.rejects(parallelReview(shared(10000),{now:()=>10000,deadlineMs:11000,maxAgeMs:8000,triggerExpiresAtMs:13000}),/DEADLINE/);
});
test('Pro remains explicit research-only and cannot enter baseline-first path by default',async()=>{
  assert.deepEqual(REALTIME_MODEL_CANDIDATES.map(x=>x.model),['deepseek-flash']);
  await assert.rejects(parallelReview(shared(10000),{now:()=>10000,deadlineMs:11000,maxAgeMs:8000,deepseek:MODEL_CANDIDATES[1]}),/RESEARCH_ONLY/);
});
