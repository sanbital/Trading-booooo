import test from 'node:test';
import assert from 'node:assert/strict';
import {R3_CANDIDATE as C,newR3State,nextR3Exit,restoreR3State} from '../../supabase/functions/_shared/leader-exit-r3.mjs';
import {createR3ReviewObserver} from '../../supabase/functions/_shared/leader-exit-r3-review-adapter.mjs';
const init=(policy=C)=>newR3State({positionId:'test-owned',entryPrice:100,entryAt:1000,quantity:1,entryFee:.05},policy);
const tick=(s,price,at,policy=C,rest={})=>nextR3Exit(s,{price,at,...rest},policy);
function path(prices,policy=C){let s=init(policy),out;for(const [at,p] of prices){out=tick(s,p,at,policy);s=out.state;}return out;}

test('cost break-even covers both fees and a fixed slippage budget',()=>{
  const s=init(),fill=s.breakEvenPrice*(1-C.slippageBudgetRate);
  assert.ok(Math.abs(fill*(1-C.estimatedExitFeeRate)-100-.05)<1e-10);
});
test('brief normal-stop excursion recovers without a close',()=>{
  const o=path([[1000,100],[2000,97],[3000,97.2],[4000,98],[5000,100]]);
  assert.equal(o.action,'HOLD');assert.equal(o.state.breachSince,null);
});
test('sustained normal-stop breach requires observed time and closes at 10 seconds',()=>{
  let s=init(),o;for(let t=1000;t<=11000;t+=1000){o=tick(s,97,t);s=o.state;if(t<11000)assert.equal(o.action,'HOLD');}
  assert.equal(o.reason,'R3_CONFIRMED_LOSS');
});
test('emergency stop bypasses confirmation, including after a data gap',()=>{
  const o=path([[1000,100],[61000,96.4]]);assert.equal(o.action,'CLOSE');assert.equal(o.reason,'R3_EMERGENCY_STOP');
});
test('a minute-spaced monitor does not fabricate ten seconds of continuity',()=>{
  const o=path([[1000,97],[61000,97],[121000,97]]);assert.equal(o.action,'HOLD');assert.equal(o.confirmationElapsedMs,0);assert.equal(o.state.dataGapCount,2);
});
test('profit floors ratchet up and do not fall when price recovers',()=>{
  let s=init(),last=s.stopPrice;for(const [at,price] of [[1000,100.6],[2000,103],[3000,108],[4000,107],[5000,106]]){
    const o=tick(s,price,at);assert.ok(o.state.stopPrice>=last);last=o.state.stopPrice;s=o.state;
  }assert.ok(s.stopPrice>=108*.975);
});
test('profit exit waits ten seconds and resets after reclaiming the floor',()=>{
  let s=path([[1000,100.6],[2000,100.1],[3000,100.3]]).state;
  assert.equal(s.breachSince,null);let out;
  for(let t=4000;t<=14000;t+=1000){out=tick(s,100.1,t);s=out.state;}
  assert.equal(out.reason,'R3_CONFIRMED_PROFIT_PROTECTION');
});
test('restarts preserve protection levels but discard unobserved confirmation time',()=>{
  const saved=path([[1000,101],[2000,100.1]]).state;
  const resumed=restoreR3State(saved,20000);
  assert.equal(resumed.stopPrice,saved.stopPrice);assert.equal(resumed.peakPrice,saved.peakPrice);
  assert.equal(tick(resumed,100.1,20000).action,'HOLD');
});
test('stale and duplicate market data never advance the state machine',()=>{
  const s=tick(init(),100,1000,C,{sequence:10}).state;
  const duplicate=tick(s,95,2000,C,{sequence:10});assert.equal(duplicate.action,'IGNORE');assert.equal(duplicate.state,s);
  const stale=tick(s,95,2000,C,{receivedAt:6001,sequence:11});assert.equal(stale.action,'DATA_GAP');assert.equal(stale.state.peakPrice,100);
});
test('a decided exit is terminal and cannot be emitted again',()=>{
  const s=tick(init(),95,1000).state;assert.equal(tick(s,104,2000).action,'CLOSED');
});
test('manual positions and overlapping manual symbols are excluded by the adapter',()=>{
  const p={id:'a',symbol:'MAGMAUSDT',side:'LONG',entry_price:100,original_quantity:1,entry_fee_usdt:.05,
    entry_at:new Date(1000).toISOString(),metadata:{executionMode:'LEADER_MOMENTUM_V17'}};
  assert.throws(()=>createR3ReviewObserver(p,{manualSymbols:['MAGMAUSDT']}),/NOT_EXCLUSIVELY/);
  assert.throws(()=>createR3ReviewObserver({...p,metadata:{}}),/NOT_EXCLUSIVELY/);
  const o=createR3ReviewObserver({...p,symbol:'TESTUSDT'});assert.equal(o.mode,'REVIEW_ONLY');assert.equal('submitOrder' in o,false);
});
test('invalid inputs, out-of-order timestamps, and mismatched checkpoints are rejected',()=>{
  assert.throws(()=>init({...C,emergencyStopPct:.02}),/INVALID_POLICY/);
  assert.throws(()=>tick(init(),NaN,1000),/INVALID_MARKET_EVENT/);
  const s=tick(init(),100,2000).state;assert.equal(tick(s,95,1500).action,'IGNORE');
  assert.throws(()=>restoreR3State(s,1500),/INVALID_RESTORE_TIME/);
});
