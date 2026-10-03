import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEntryRescue,ENTRY_RESCUE_POLICY} from '../supabase/functions/_shared/deterministic/market-state.mjs';

const initial=(at=1_000_000)=>({at,reference_price:100,trigger:'MOMENTUM_REACCELERATION',trigger_reference:100,atr_normalized:.01});
const latest=(overrides={})=>({
 phase:'MOMENTUM_CONTINUATION',current_propulsion:'STRONG',structural_strength:'STRONG',
 families:{FLOW:{recovering:true}},...overrides
});
const facts=(overrides={})=>({
 ema9_slope:.005,ema20_slope:.003,ema9_vs_ema20:.002,
 return_5m:.005,return_15m:.015,return_60m:.02,
 rsi_1m_14:64,bb_position:.98,volume_ratio_1m_vs_baseline:1.2,candle_range_atr:1,
 higher_high:true,failed_breakout_candle:false,sell_volume_expansion:false,volume_climax_decline:false,
 expected_execution_cost_bps:13,spread_bps:1,
 taker_buy_ratio_5m:.57,taker_buy_ratio_15m:.56,
 accel_5m_vs_15m:.003,accel_15m_vs_60m:.008,distance_high_15m:-.003,
 ...overrides
});
const input=(values={},at=1_006_000)=>({at,facts:{values:facts(values)}});

test('rescues a fresh strong continuation that keeps independent strength evidence',()=>{
 const r=evaluateEntryRescue(initial(),input(),latest(),.003);
 assert.equal(r.allowed,true);
 assert.equal(r.reason,'STRONG_CONTINUATION_RESCUE');
 assert.ok(r.strength_score>=ENTRY_RESCUE_POLICY.strongMinScore);
});

test('keeps hard blocking collapsed high-distance and expensive setups',()=>{
 for(const values of [
  {distance_high_15m:-.04},
  {sell_volume_expansion:true},
  {expected_execution_cost_bps:19},
  {spread_bps:6},
  {taker_buy_ratio_5m:.47},
  {accel_15m_vs_60m:-.001}
 ]){
  const r=evaluateEntryRescue(initial(),input(values),latest(),0);
  assert.equal(r.allowed,false);
  assert.equal(r.reason,'RESCUE_HARD_BLOCK');
 }
});

test('does not rescue failed-breakout states when buy-side recovery is weak',()=>{
 const r=evaluateEntryRescue(initial(),input({failed_breakout_candle:true,taker_buy_ratio_5m:.50}),latest({families:{FLOW:{recovering:false}}}),0);
 assert.equal(r.allowed,false);
 assert.equal(r.reason,'RESCUE_HARD_BLOCK');
});

test('blocks overheat even when trend and flow remain strong',()=>{
 for(const values of [
  {rsi_1m_14:81},
  {return_5m:.026},
  {return_15m:.045},
  {return_60m:.067},
  {bb_position:1.21,volume_ratio_1m_vs_baseline:2.1},
  {candle_range_atr:1.6,higher_high:false}
 ]){
  const r=evaluateEntryRescue(initial(),input(values),latest(),0);
  assert.equal(r.allowed,false);
  assert.equal(r.reason,'RESCUE_OVERHEAT');
 }
});

test('requires strong structure and at least four independent strength checks',()=>{
 assert.equal(evaluateEntryRescue(initial(),input(),latest({structural_strength:'CONSTRUCTIVE'}),0).reason,'RESCUE_STRUCTURE_WEAK');
 const weak=input({taker_buy_ratio_5m:.50,taker_buy_ratio_15m:.50,accel_5m_vs_15m:-.001,spread_bps:3,expected_execution_cost_bps:15});
 const r=evaluateEntryRescue(initial(),weak,latest(),0);
 assert.equal(r.allowed,false);
 assert.equal(r.reason,'RESCUE_STRENGTH_INSUFFICIENT');
});

test('rescue authority expires after ten seconds and never chases more than 0.8 percent',()=>{
 assert.equal(evaluateEntryRescue(initial(),input({},1_010_001),latest(),0).reason,'RESCUE_WINDOW_EXPIRED');
 assert.equal(evaluateEntryRescue(initial(),input({},1_005_000),latest(),.0081).reason,'RESCUE_PRICE_CHASE');
});
