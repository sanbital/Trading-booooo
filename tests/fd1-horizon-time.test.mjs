import test from 'node:test';
import assert from 'node:assert/strict';
import {horizonDefinitions,horizonTimeMismatch} from '../supabase/functions/_shared/gpt-final-decision/horizon-time.mjs';
import {DYNAMIC_VERSION,HORIZONS} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {validateDynamicWire} from '../supabase/functions/_shared/gpt-final-decision/dynamic-contract.mjs';
import {buildDecisionPacket,modelInput,payloadFor,callDecision} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {validateDecision} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {batchFinalPayload} from '../supabase/functions/_shared/leader20/final.mjs';
import {validCapture,dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {src,entryWire,mockApi} from '../development/gpt-final-decision/tests/fixtures.mjs';
const T=1800000000200;
async function fixture(decision='WAIT'){
 const facts=computeFacts({...src(T),captureContext:validCapture(T)},{asOf:T,referenceClose:1});
 const packet=await buildDecisionPacket({task:'ENTRY',subjectId:'horizon-unit-test',symbol:'ABCUSDT',dataMode:'LIVE',facts});
 packet.dynamic_policy=DYNAMIC_VERSION;packet.dynamic_as_of_ms=T;
 const wire=dynamicWire(entryWire({t:'ENTRY',c:packet.candidate_id,d:decision,n:'Current demand assessed',support:decision==='BUY'?['return_5m','taker_buy_ratio_5m']:[]}),modelInput(packet));
 return {packet,wire};
}

test('seconds labels preserve every original horizon, timestamp, cell and candle fact',async()=>{
 const {packet}=await fixture(),before=structuredClone(packet);
 packet.leader20={version:'LEADER20_DYNAMIC_1',batch_advice:{decision:'BLOCKED'}};
 const input=modelInput(packet),definitions=input.horizon_definitions;
 assert.equal(definitions.unit,'seconds');
 for(const s of HORIZONS){
  const h=definitions.windows['s'+s],points=packet.facts.capture_context.trajectory.slice(-s/5);
  assert.equal(h.nominal_seconds,s);assert.equal(h.bucket_count,points.length);
  assert.equal(h.start_ms,points[0].start_ms);assert.equal(h.end_ms,points.at(-1).end_ms);
  assert.equal(h.actual_seconds,packet.facts.capture_context.dynamics.horizons['s'+s].actual_seconds);
 }
 assert.deepEqual(input.capture_context.dynamics,before.facts.capture_context.dynamics);
 const columns=input.capture_context.ordered_path_columns;
 for(const [i,row] of input.capture_context.ordered_path.entries())assert.deepEqual(row,columns.map(k=>before.facts.capture_context.trajectory[i][k]??null));
 assert.deepEqual(packet.facts,before.facts);assert.equal(packet.snapshot_hash,before.snapshot_hash);
 assert.equal(input.facts.trend.return_60m,Number(packet.facts.values.return_60m.toPrecision(5)));
 const missing=horizonDefinitions({status:'UNAVAILABLE'});
 assert.equal(missing.windows.s60.actual_seconds,null);assert.equal(missing.windows.s60.start_ms,null);
 const payload=batchFinalPayload(packet);
 assert.match(payload.input[0].content,/s60=60 seconds \(one minute\)/);
 assert.match(payload.input[0].content,/s60 is NOT return_60m/);
 assert.match(payload.text.format.schema.properties.why_buy_now.properties.horizons.properties.s60.description,/60-SECOND/);
 assert.ok(JSON.stringify(payload).length<130000);assert.equal(payload.max_output_tokens,1800);
});

test('the four original 13:00 horizon errors are rejected for WAIT and SKIP without rewriting them',async()=>{
 const incidents=[['CAPUSDT','WAIT','한 시간 흐름은 순매도입니다.'],['MARSCOINUSDT','WAIT','한 시간 수익은 유지되나 당장은 둔화됨'],
  ['QNTUSDT','SKIP','한 시간 흐름은 아직 음수다'],['SOONUSDT','SKIP','한 시간 흐름이 음수다.']];
 for(const [symbol,decision,summary] of incidents){
  const {packet,wire}=await fixture(decision);wire.why_buy_now.horizons.s60.summary=summary;
  const saved=JSON.stringify(wire);
  assert.throws(()=>validateDecision(wire,packet),/FD_DYNAMIC_HORIZON_TIME_UNIT_MISMATCH:s60/,symbol);
  assert.equal(JSON.stringify(wire),saved);
 }
});

test('equivalent seconds/minutes pass; explicit hours and oversized minute windows fail',()=>{
 for(const [s,text] of [[60,'최근 60초는 순매도'],[60,'한 분 흐름은 약함'],[60,'One minute of net selling'],
  [120,'최근 두 분 매수 우위'],[120,'2 minutes of demand'],[5,'5초 매수 우위'],[60,'시간이 지나며 매수 약화']])assert.equal(horizonTimeMismatch(text,s),false,text);
 for(const [s,text] of [[60,'1시간 순매도'],[60,'one-hour net selling'],[120,'hourly flow weak'],[60,'60 minutes of selling'],
  [60,'sixty minutes of selling'],[30,'한 분 매수 우위'],[60,'두 분 매수 우위'],[60,'1h flow negative'],[60,'최근60분 순매도']])assert.equal(horizonTimeMismatch(text,s),true,text);
});

test('BUY and RECHECK cannot retain authority with the wrong horizon; long-term prose stays separate',async()=>{
 const {packet,wire}=await fixture('BUY');
 wire.structural_strength='One hour candle trend is rising';
 assert.equal(validateDecision(wire,packet).decision,'BUY');
 wire.why_buy_now.horizons.s60.summary='One hour flow is strong';
 assert.throws(()=>validateDecision(wire,packet),/HORIZON_TIME_UNIT_MISMATCH:s60/);
 assert.throws(()=>validateDynamicWire(wire,{...packet,task:'RECHECK'}),/HORIZON_TIME_UNIT_MISMATCH:s60/);
});

test('normal provider response with time-unit error becomes explicit invalid ABSTAIN, without a retry',async()=>{
 const {packet,wire}=await fixture('BUY');wire.why_buy_now.horizons.s60.summary='한 시간 매수 우위';
 const api=mockApi(()=>wire);
 const result=await callDecision(packet,{apiKey:'synthetic-unit-key',fetchFn:api.fetchFn,now:()=>T});
 assert.equal(api.calls.length,1);assert.equal(result.valid,false);assert.equal(result.decision,'ABSTAIN');
 assert.equal(result.error,'FD_DYNAMIC_HORIZON_TIME_UNIT_MISMATCH:s60');
 assert.equal(result.wire.why_buy_now.horizons.s60.summary,wire.why_buy_now.horizons.s60.summary);
 assert.equal(payloadFor(packet).model,'gpt-5.4-mini-2026-03-17');
});
