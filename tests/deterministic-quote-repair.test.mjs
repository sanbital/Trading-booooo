import test from 'node:test';import assert from 'node:assert/strict';
import {assertPausedQuoteRepair,assertQuoteRepairHealth} from '../ops/deterministic/quote-repair-policy.mjs';
test('quote rollout refuses admission, holdings, unresolved exchange truth, circuits and active writers',()=>{
 const state={paused:true,positions:0,unresolved_orders:0,circuit:false,writers:0};assert.doesNotThrow(()=>assertPausedQuoteRepair(state));
 for(const patch of [{paused:false},{positions:1},{unresolved_orders:1},{circuit:true},{writers:1},{paused:undefined}])assert.throws(()=>assertPausedQuoteRepair({...state,...patch}));
});
test('quote rollout preserves observed Paris and Tokyo writer/scheduler/credential roles',()=>{
 for(const app of ['trading-booooo','trading-booooo-sanbital-gateway']){
  const tokyo=app!=='trading-booooo',h={deployment_commit:'a'.repeat(40),order_writer:{required:true},scheduler_enabled:tokyo,external_scheduler:{enabled:tokyo},keys_configured:{binance_futures:!tokyo}},config={app,expectedCommit:'a'.repeat(40)};
  assert.doesNotThrow(()=>assertQuoteRepairHealth(h,config));
  for(const patch of [{deployment_commit:'b'.repeat(40)},{order_writer:{required:false}},{external_scheduler:{enabled:!tokyo}},{scheduler_enabled:!tokyo},{keys_configured:{binance_futures:tokyo}}])assert.throws(()=>assertQuoteRepairHealth({...h,...patch},config));
 }
});
