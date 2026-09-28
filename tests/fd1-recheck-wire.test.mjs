import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {recheckCaptureInput,recheckModelInput,recheckPayload} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {frozenReview,firstPayload,arbitrationPayload,reviewsFor,finalEvidenceTransport} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {callDecision} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {callAdvisory} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
import {prepareStoredReplay} from '../supabase/functions/_shared/gpt-final-decision/stored-replay.mjs';
const fixture=JSON.parse(readFileSync(new URL('../test-support/production-recheck-cost-bound-20260928.json',import.meta.url)));
function unpack(w){return w.ordered_path.map(row=>Object.fromEntries(w.ordered_path_columns.map((k,i)=>
  [k,row[i]!==null&&w.path_offset_column_indices.includes(i)?row[i]+w.path_time_origin_ms:row[i]])));}
const shared=()=>frozenReview(fixture.packet,{snapshotAtMs:fixture.packet.dynamic_as_of_ms,inputPayload:recheckPayload,
  policy:{context:fixture.policy,bundle:{policy_version:fixture.policy.version}}});

test('stored replay pairs the actual final packet with its final clock after pre-inference refresh',async()=>{
  const original=structuredClone(fixture.packet);original.facts.capture_context={status:'UNAVAILABLE',reason:'BEFORE_REFRESH'};
  const replay=await prepareStoredReplay({packet:original,result:{final_packet:fixture.packet,final_snapshot_at_ms:fixture.packet.dynamic_as_of_ms}});
  assert.equal(replay.safety.ok,true);assert.deepEqual(replay.packet.facts.capture_context,fixture.packet.facts.capture_context);
  assert.equal(replay.at,fixture.packet.dynamic_as_of_ms);assert.equal(original.facts.capture_context.status,'UNAVAILABLE');
});

test('production ONE recheck preserves all three complete paths and every original cell',()=>{
  const original=structuredClone(fixture.packet),input=recheckModelInput(original);
  const pairs=[[original.initial.capture_context,input.initial.capture_context],
    [original.facts.capture_context,input.current.capture_context],
    [original.pre_dispatch.capture_context,input.fast_recheck.capture_context]];
  let cells=0;
  for(const [capture,wire]of pairs){
    assert.equal(wire.ordered_path.length,24);
    const restored=unpack(wire);
    assert.deepEqual(restored,capture.trajectory.map(row=>Object.fromEntries(wire.ordered_path_columns.map(k=>[k,row[k]??null]))));
    assert.equal(wire.end_ms,capture.end_ms);assert.equal(wire.start_ms,capture.start_ms);
    assert.equal(wire.snapshot_at,capture.snapshot_at);
    for(const index of wire.critical_segments)assert.deepEqual(restored[index],Object.fromEntries(wire.ordered_path_columns.map(k=>[k,capture.trajectory[index][k]??null])));
    cells+=24*wire.ordered_path_columns.length;
  }
  assert.ok(cells>2000);
  assert.notEqual(input.fast_recheck.capture_context.end_ms,input.current.capture_context.end_ms);
  assert.deepEqual(original,fixture.packet,'transport must not mutate journal evidence');
});

test('time encoding does not round unsafe/fractional clocks or change zeros and nulls',()=>{
  const c=structuredClone(fixture.packet.facts.capture_context);
  c.trajectory[0].flow_event_ms+=.5;c.trajectory[1].aggressive_buy=0;c.trajectory[2].aggressive_sell=null;
  const wire=recheckCaptureInput(c),restored=unpack(wire);
  assert.equal(wire.path_offset_column_indices.includes(wire.ordered_path_columns.indexOf('flow_event_ms')),false);
  assert.equal(restored[0].flow_event_ms,c.trajectory[0].flow_event_ms);
  assert.equal(restored[1].aggressive_buy,0);assert.equal(restored[2].aggressive_sell,null);
  assert.deepEqual(recheckCaptureInput({status:'UNAVAILABLE',reason:'GAP'}),{status:'UNAVAILABLE',reason:'GAP'});
});

test('execution state refers to the supplied pre-dispatch input once; journal still has original',async()=>{
  const s=await shared();assert.equal(s.market_input.execution_state.pre_dispatch.reference,'fast_recheck');
  const {capture_context,...fast}=s.market_input.fast_recheck;
  const {capture_context:_capture,...original}=fixture.packet.pre_dispatch;
  assert.deepEqual(fast,original);assert.deepEqual(s.packet.pre_dispatch,fixture.packet.pre_dispatch);
  assert.equal(capture_context.ordered_path.length,24);
});

test('the real 177265-byte failure fits unchanged GPT/DeepSeek bounds after lossless deduplication',async()=>{
  const s=await shared(),final=finalEvidenceTransport(arbitrationPayload(s,s,reviewsFor(null,{valid:false}))).payload;
  let gptCalls=0,dsCalls=0;
  for(const payload of [firstPayload(s),final]){
    const result=await callDecision(s.packet,{apiKey:'fixture',payloadFn:()=>payload,
      fetchFn:async(_url,init)=>{gptCalls++;assert.ok(Buffer.byteLength(init.body)<=130000);return new Response('{}',{status:503});}});
    assert.equal(result.attempted,true);assert.equal(result.error,'HTTP_503');
    assert.equal(result.valid,false,'passing a byte guard must never create BUY authority');
  }
  const ds=await callAdvisory(s,{apiKey:'fixture',fetchFn:async(_url,init)=>{
    dsCalls++;assert.ok(Buffer.byteLength(init.body)<=90000);return new Response('{}',{status:503});}});
  assert.equal(ds.error,'DEEPSEEK_HTTP_503');assert.equal(ds.attempted,true);
  assert.equal(gptCalls,2);assert.equal(dsCalls,1);
  assert.ok(Buffer.byteLength(JSON.stringify(final))<120000);
  assert.equal(fixture.observed_request_bytes,177265);
});
