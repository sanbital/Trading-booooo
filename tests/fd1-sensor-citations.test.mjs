import test from 'node:test';
import assert from 'node:assert/strict';
import {ADVISORY_PROMPT,validateAdvisory,evidenceCatalog} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
test('trade horizons and BTC sensor evidence stay separate exact paths; missing horizons fails closed',()=>{
 const shared={packet:{task:'HOLD',candidate_id:'fixture'},snapshot_hash:'a'.repeat(64),market_input:{
  capture_context:{dynamics:{horizons:{s120:{net_taker_flow:-20}}}},market_sensor:{return_120s:.001}}};
 const trade='capture_context.dynamics.horizons.s120.net_taker_flow',sensor='market_sensor.return_120s';
 assert.ok(ADVISORY_PROMPT.includes(trade));assert.ok(ADVISORY_PROMPT.includes(sensor));
 assert.deepEqual(Object.keys(evidenceCatalog(shared.market_input)),[trade,sensor]);
 const wire={task:'HOLD',candidate_id:'fixture',snapshot_hash:shared.snapshot_hash,decision_preference:'HOLD',confidence:.5,
  thesis_state:'ALIVE',bullish_evidence:[sensor],bearish_evidence:[trade],risk_flags:[],trajectory_interpretation:'Measured flows differ',
  strongest_counterargument:'The traded symbol can diverge',recommended_action:'HOLD',reason:'Causal evidence'};
 assert.equal(validateAdvisory(wire,shared),wire);
 assert.throws(()=>validateAdvisory({...wire,bearish_evidence:['capture_context.dynamics.s120.net_taker_flow']},shared),/UNSUPPORTED_EVIDENCE/);
});
