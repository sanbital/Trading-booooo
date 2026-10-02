import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEarly,runFd1Early,EARLY_SQL} from './fd1-early.mjs';

const start=Date.parse('2026-09-25T06:00:00Z');
const position={position_id:'00000000-0000-0000-0000-000000000001',signal_id:'00000000-0000-0000-0000-000000000002',
  entry_at:new Date(start+20_000).toISOString(),entry_price:'100',symbol:'FOOUSDT'};
const bar=(minute,open,high,low,close,buy=.25)=>[start+minute*60_000,String(open),String(high),String(low),String(close),
  '1000',start+(minute+1)*60_000-1,'1000',40,'250',String(1000*buy),'0'];

test('completed bars yield an observational label without an order',()=>{
  const raw=[bar(0,100,106,95,103),bar(1,100,100.03,99.4,99.5),bar(2,99.5,99.6,98.5,98.7)];
  const e=evaluateEarly(position,raw,start+3*60_000+1000,2);
  assert.equal(e.bars,2);assert.ok(e.mfe<.001);assert.ok(e.ret<0);
  assert.equal(e.label,'EARLY_COMPOUND_HYPOTHESIS');
  assert.equal(e.signals.entry_minute_peak_unobserved,true);
  assert.equal(e.signals.window_is_observation_not_time_exit,true);
  assert.equal(evaluateEarly(position,raw,start+60_000,1),null);
});

test('no open position results in zero Binance calls and zero writes',async()=>{
  let calls=0;
  const r=await runFd1Early({db:{query:async sql=>{calls++;assert.equal(sql,EARLY_SQL.readOpen);return [];}},
    guard:{fetch:()=>{throw Error('No public market request expected');}},now:()=>start+8*60_000});
  assert.equal(r.positions,0);assert.equal(r.orders,0);assert.equal(r.recorded,0);assert.equal(calls,1);
});
