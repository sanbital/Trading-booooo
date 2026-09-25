import test from 'node:test';
import assert from 'node:assert/strict';
import {compareNoise} from '../supabase/functions/_shared/gpt-final-decision/noise-control.mjs';
import {callCounter,sharedReview,MODEL_CANDIDATES} from '../supabase/functions/_shared/gpt-final-decision/parallel.mjs';
import {buildDecisionPacket} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {T,src} from '../development/gpt-final-decision/tests/fixtures.mjs';
const packet=await buildDecisionPacket({task:'HOLD',subjectId:'noise',symbol:'ABCUSDT',dataMode:'REPLAY',facts:computeFacts(src(T),{asOf:T}),position:{}});
test('A/A and B/B reuse identical frozen inputs and do not import outcomes',async()=>{
  const seen=[];const r=await compareNoise({packet,group_key:'g',as_of_ms:T,outcome:999},[],{invoke:async(input,cfg)=>{
    seen.push({input,cfg});assert.equal(cfg.temperature,0);assert.equal(JSON.stringify(input).includes('outcome'),false);
    return {valid:true,answer:{decision_preference:'HOLD'}};}});
  assert.equal(seen.length,4);assert.equal(seen[0].input,seen[3].input);assert.equal(seen[1].input,seen[2].input);
  assert.ok(Object.isFrozen(seen[0].input));assert.deepEqual(r.agreement,{AA:true,BB:true,AB:true});assert.deepEqual(r.authority,[]);
});
test('sampling is explicit only when requested; unsupported seed is not sent',async()=>{
  for(const temperature of [undefined,0]){
    let sent;await callCounter(await sharedReview(packet,{snapshotAtMs:T}),{...MODEL_CANDIDATES[0],apiKey:'test',temperature,
      fetchFn:async(u,i)=>{sent=JSON.parse(i.body);return new Response('{}',{status:503});}});
    assert.equal(sent.temperature,temperature);assert.equal(Object.hasOwn(sent,'seed'),false);
  }
});
