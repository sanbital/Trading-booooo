import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEntry,evaluateExit,confirmedLossHistory} from '../../supabase/functions/_shared/leader-strategy-shadow.mjs';
const at=Date.parse('2026-09-11T11:00:00Z');
const features={symbol:'METUSDT',strategy:'LEADER_MOMENTUM_V17',signal5Close:at,referenceClose:1,return5m:.01};
const loss=(id,extra={})=>({id,symbol:'METUSDT',state:'CLOSED',closed_at:at-120000,
  updated_at:at-60000,realized_pnl_usdt:-1,exit_reason:'V17_NATIVE_STOP',
  metadata:{executionMode:'LEADER_MOMENTUM_V17'},...extra});
const entry=(extra={})=>evaluateEntry({symbol:'METUSDT',features,asOf:at,variant:'REPEAT_STOP_2',...extra});
test('two known negative stop round trips filter; duplicate fills do not create another trade',()=>{
  const a=loss('a'),b=loss('b');
  assert.equal(entry({history:[a,a]}).verdict,'NO_ADDITIONAL_FILTER');
  assert.equal(entry({history:[b,a,a]}).verdict,'WOULD_FILTER');
});
test('future closure and delayed DB settlement cannot influence a past entry',()=>{
  assert.equal(entry({history:[loss('a'),loss('b',{updated_at:at+1})]}).verdict,'NO_ADDITIONAL_FILTER');
  assert.equal(entry({history:[loss('a'),loss('b',{closed_at:at+1})]}).verdict,'NO_ADDITIONAL_FILTER');
});
test('manual, open, positive and non-stop exits do not count as negative automatic stops',()=>{
  const rows=[loss('a',{metadata:{executionMode:'MANUAL'}}),loss('b',{state:'OPEN'}),
    loss('c',{realized_pnl_usdt:1}),loss('d',{exit_reason:'V17_MAX_HOLD'})];
  assert.equal(entry({history:rows}).verdict,'NO_ADDITIONAL_FILTER');
});
test('KST day rollover does not carry yesterday loss counters forward',()=>{
  const next=Date.parse('2026-09-11T15:00:00Z');
  assert.equal(confirmedLossHistory([loss('a'),loss('b')],'METUSDT',next).losses.length,0);
});
test('missing PnL, settlement timestamp and truncated history are unavailable, never zero-loss proof',()=>{
  for(const extra of [{realized_pnl_usdt:null},{updated_at:null},{metadata:{executionMode:'LEADER_MOMENTUM_V17',exitAccountingPending:true}}])
    assert.equal(entry({history:[loss('a',extra)]}).verdict,'UNAVAILABLE');
  assert.equal(entry({historyComplete:false}).verdict,'UNAVAILABLE');
});
test('conflicting duplicate settlement fails closed',()=>{
  assert.throws(()=>entry({history:[loss('a'),loss('a',{realized_pnl_usdt:2})]}),/CONFLICTING/);
});
test('future or stale signal never passes shadow feature eligibility',()=>{
  assert.equal(entry({features:{...features,signal5Close:at+1}}).verdict,'UNAVAILABLE');
  assert.equal(entry({features:{...features,signal5Close:at-120001}}).verdict,'UNAVAILABLE');
});
test('spike guard uses completed signal return only and exact 3% boundary',()=>{
  for(const [r,verdict] of [[.029999,'NO_ADDITIONAL_FILTER'],[.03,'WOULD_FILTER'],[.031,'WOULD_FILTER']])
    assert.equal(entry({variant:'SPIKE_3PCT',features:{...features,return5m:r}}).verdict,verdict);
  assert.equal(entry({variant:'SPIKE_3PCT',features:{...features,return5m:null}}).verdict,'UNAVAILABLE');
});
test('a known spike rejection remains rejected when settlement history is missing',()=>{
  assert.equal(entry({variant:'COMBINED',features:{...features,return5m:.04},historyComplete:false}).verdict,'WOULD_FILTER');
});
test('1.5% profit arm raises only the candidate stop and cannot mutate live position',()=>{
  const p={entryPrice:100,entryAt:at-120000,entryFee:.05,quantity:1,peakPrice:101.6,
    lastHighAt:at-1000,stopPrice:98.8,t1Completed:true};
  const frozen=structuredClone(p);
  assert.equal(evaluateExit(p,101.5,at).stopPrice,98.8);
  assert.equal(evaluateExit(p,101.5,at,'LOCK_1P5').stopPrice,100.8);
  assert.deepEqual(p,frozen);
});
test('profit candidate cannot loosen already superior stop or reset partial remainder',()=>{
  const p={entryPrice:100,entryAt:at-120000,entryFee:.05,quantity:.4,peakPrice:104,
    lastHighAt:at-1000,stopPrice:103,t1Completed:true};
  assert.ok(evaluateExit(p,103.5,at,'LOCK_1P5').stopPrice>=103);
  assert.equal(p.quantity,.4); assert.equal(p.t1Completed,true);
});
test('even a shadow close has no execution authority and initial stop remains bounded',()=>{
  const p={entryPrice:100,entryAt:at-120000,entryFee:.05,quantity:1,peakPrice:100,
    lastHighAt:at-1000,stopPrice:97.5};
  const d=evaluateExit(p,97,at,'LOCK_1P5');
  assert.equal(d.action,'CLOSE'); assert.equal(d.executionEnabled,false); assert.equal(d.stopPrice,97.5);
});
