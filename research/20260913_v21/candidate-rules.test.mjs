import test from 'node:test';
import assert from 'node:assert/strict';
import {POLICY_VERSION,entryDecision,initialReclaimState,reclaimExitDecision} from './candidate-rules.mjs';

const features={return15m:.03,return5m:.01,referenceClose:100};
const position={id:'p',ownership:'AUTO',side:'LONG',state:'OPEN',entryAt:0,entryPrice:100.1};
const quote=(at,bid=99.9)=>({bid,detectedAtMs:at,quoteRequestedAtMs:at-300,quoteReceivedAtMs:at-100,exchangeBookAtMs:at-400});

test('blocks only a decelerated setup that has not reclaimed its completed signal close',()=>{
  assert.equal(entryDecision(features,100).reason,'V21_DECAY_NO_RECLAIM');
  assert.equal(entryDecision(features,100.00001).reason,'V21_DECAY_RECLAIMED');
  assert.equal(entryDecision({...features,return15m:.0249},99).wouldBlock,false);
  assert.equal(entryDecision({...features,return5m:.01201},99).wouldBlock,false);
});

test('missing additional-policy inputs preserve baseline rather than invent a block',()=>{
  assert.deepEqual(entryDecision({},100),{available:false,wouldBlock:false,reason:'PRESERVE_BASELINE_INPUT_UNAVAILABLE'});
});

test('a reclaimed setup creates a position-bound immutable premise',()=>{
  const s=initialReclaimState({positionId:'p',entryAt:0,entryPrice:100.1,features,limitPrice:100.1});
  assert.equal(s.version,POLICY_VERSION);assert.equal(s.referencePrice,100);assert.equal(s.belowCount,0);
  assert.equal(initialReclaimState({positionId:'p',entryAt:0,entryPrice:100.1,features,limitPrice:100}),null);
});

test('three fresh minute-spaced bids below reference close the reclaimed thesis',()=>{
  let state=initialReclaimState({positionId:'p',entryAt:0,entryPrice:100.1,features,limitPrice:100.1});
  for(const at of [180000,240000]){const r=reclaimExitDecision({position,state,observation:quote(at)});assert.equal(r.wouldClose,false);state=r.state;}
  const close=reclaimExitDecision({position,state,observation:quote(300000)});assert.equal(close.wouldClose,true);assert.equal(close.reason,'V21_RECLAIM_FAILURE_3');
});

test('a reclaim or an observation gap resets consecutive evidence',()=>{
  let state=initialReclaimState({positionId:'p',entryAt:0,entryPrice:100.1,features,limitPrice:100.1});
  state=reclaimExitDecision({position,state,observation:quote(180000)}).state;
  state=reclaimExitDecision({position,state,observation:quote(240000,100)}).state;assert.equal(state.belowCount,0);
  state=reclaimExitDecision({position,state,observation:quote(360001)}).state;assert.equal(state.belowCount,1);
});

test('stale timing, old positions and mismatched state cannot close',()=>{
  const state=initialReclaimState({positionId:'p',entryAt:0,entryPrice:100.1,features,limitPrice:100.1});
  assert.equal(reclaimExitDecision({position,state,observation:{...quote(180000),quoteReceivedAtMs:170000}}).wouldClose,false);
  assert.equal(reclaimExitDecision({position:{...position,id:'other'},state,observation:quote(180000)}).wouldClose,false);
});

