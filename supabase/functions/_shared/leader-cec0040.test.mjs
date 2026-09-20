import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CEC0040_CONFIG,CEC0040_TARGET_VERSION,CEC0040_VERSION,P142_POLICY_VERSION,
  advanceP142Completed,cec0040Decision,cec0040Fold,nextExitP142,
  p142Mean44Target,p142StyleForBranch,replayP142Target,
} from './leader-cec0040.mjs';
import {POLICY} from './leader-momentum-v17.mjs';
import {EXIT_REVIEW_R5} from './leader-exit-review.mjs';

const MIN=60000,AT=Date.parse('2026-09-20T00:00:13Z');
const bar=(i,o,h,l,c)=>[Math.floor(AT/MIN)*MIN+i*MIN,o,h,l,c,1000,500];

test('fixed identities, parameters and B06133 branch mapping are immutable',()=>{
  assert.equal(CEC0040_VERSION,'CEC0040_CAUSAL_EDGE_CONTROLLER_1');
  assert.equal(CEC0040_TARGET_VERSION,'CEC0040_P142_MEAN44_1');
  assert.equal(P142_POLICY_VERSION,'P142_COMPLETED_PRICE_BRANCH_1');
  assert.deepEqual(CEC0040_CONFIG,{scope:'global',alpha:.05,trainingTarget:'P142_MEAN44',winsorUsdt:20,
    minTrainingTrades:10,admissionThresholdUsdt:0,probeEveryRejectedSignals:3,targetNotionalUsdt:600});
  assert.equal(p142StyleForBranch('R62'),'retestAnchor');
  assert.equal(p142StyleForBranch('BUYER_SHARE_RESCUE'),'rangeFloor');
  assert.equal(p142StyleForBranch('BOTH'),'pivotFloor');
  assert.throws(()=>p142StyleForBranch('UNKNOWN'),/P142_BRANCH_INVALID/);
});

test('CEC0040 warmup, EWMA and every-third-negative probe match the frozen controller',()=>{
  assert.equal(cec0040Decision({ewmaUsdt:null,trainingCount:0,rejectRun:2}).action,'ADMIT');
  let state={ewmaUsdt:null,trainingCount:0,rejectRun:0};
  state=cec0040Fold(state,30);assert.equal(state.ewmaUsdt,20);
  state=cec0040Fold(state,-30);assert.equal(state.ewmaUsdt,18);
  const one=cec0040Decision({ewmaUsdt:-1,trainingCount:10,rejectRun:0});
  const two=cec0040Decision({ewmaUsdt:-1,trainingCount:10,rejectRun:one.rejectRunAfter});
  const three=cec0040Decision({ewmaUsdt:-1,trainingCount:10,rejectRun:two.rejectRunAfter});
  assert.deepEqual([one.action,two.action,three.action],['REJECT','REJECT','PROBE']);
  assert.deepEqual([one.rejectRunAfter,two.rejectRunAfter,three.rejectRunAfter],[1,2,0]);
  assert.equal(cec0040Decision({ewmaUsdt:0,trainingCount:10,rejectRun:2}).action,'ADMIT');
});

test('44bp replay preserves the frozen hard-stop arithmetic exactly',()=>{
  const bars=[bar(0,100,101,97,98)];
  const low=replayP142Target({at:AT,price:100},bars,{style:'retestAnchor',mode:'LOW_FIRST'}),
    high=replayP142Target({at:AT,price:100},bars,{style:'retestAnchor',mode:'HIGH_FIRST'}),
    close=replayP142Target({at:AT,price:100},bars,{style:'retestAnchor',mode:'CLOSE_ONLY'});
  assert.deepEqual([low.status,high.status,close.status],['CLOSED','CLOSED','CLOSED']);
  assert.deepEqual([low.reason,high.reason,close.reason],['NATIVE_HARD_STOP','R5_RISK_CUT','NATIVE_HARD_STOP']);
  assert.ok(Math.abs(low.netBeforeFunding-(-16.998681))<1e-9,low);
  assert.ok(Math.abs(high.netBeforeFunding-(-9.21973008))<1e-9,high);
  assert.ok(Math.abs(close.netBeforeFunding-(-16.998681))<1e-9,close);
});

test('three-path target is delayed until all paths close and subtracts path-specific funding',()=>{
  const bars=[bar(0,100,101,97,98)];
  const out=p142Mean44Target({entryAt:AT,actualEntryPrice:100/1.0005,branch:'R62',bars,
    fundingEvents:[{fundingTime:AT+1000,fundingRate:.001,markPrice:100}]});
  assert.equal(out.status,'RESOLVED');
  assert.ok(Math.abs(out.targetNetUsdt-(-15.00569736))<1e-9,out);
  assert.equal(Object.keys(out.pathNets).length,3);
});

test('completed-price retest anchor raises live stop without widening risk',()=>{
  const position={id:'p1',entryAt:AT,entryPrice:100,entryFee:.42,quantity:6,stopPrice:97.5,
    peakPrice:104,branch:'R62'};
  const bars=[bar(0,100,104,99,103),bar(1,103,104,102,104)];
  const state=advanceP142Completed(position,bars);
  assert.equal(state.accepted,104);
  assert.equal(state.stopPrice,102.44);
  assert.equal(state.stage,'retestAnchor_TRAIL');
  const next=nextExitP142({entryPrice:100,entryAt:AT,entryFee:.42,quantity:6,peakPrice:104,
    stopPrice:97.5,lastHighAt:AT},101.5,AT+2*MIN,{...POLICY,...EXIT_REVIEW_R5},state);
  assert.equal(next.action,'CLOSE');
  assert.equal(next.reason,'retestAnchor_TRAIL');
  assert.equal(next.stopPrice,102.44);
});

test('an inherited R5 stop is not misattributed to P142 before a branch level exists',()=>{
  const input={entryPrice:100,entryAt:AT,entryFee:.42,quantity:6,peakPrice:101,
    stopPrice:98.8,lastHighAt:AT};
  const next=nextExitP142(input,98.7,AT+11*MIN,{...POLICY,...EXIT_REVIEW_R5},
    {stage:'BASELINE',stopPrice:98.8});
  assert.equal(next.action,'CLOSE');
  assert.equal(next.reason,'V17_RISK_CUT');
  assert.equal(next.p142,false);
});

test('P142 state is position-bound and rejects gaps or identity substitution',()=>{
  const position={id:'p1',entryAt:AT,entryPrice:100,entryFee:.42,quantity:6,stopPrice:97.5,
    peakPrice:104,branch:'R62'};
  const state=advanceP142Completed(position,[bar(0,100,101,99,100)]);
  assert.throws(()=>advanceP142Completed({...position,id:'p2'},[bar(1,100,101,99,100)],state),/P142_STATE_MISMATCH/);
  assert.throws(()=>replayP142Target({at:AT,price:100},[bar(0,100,101,99,100),bar(2,100,101,99,100)],
    {style:'retestAnchor',mode:'LOW_FIRST'}),/P142_BAR_GAP/);
  assert.throws(()=>advanceP142Completed(position,[bar(2,100,101,99,100)],state),/P142_BAR_GAP/);
});

const executor=await readFile(new URL('../v10-lane-executor/index.ts',import.meta.url),'utf8');
const migration=await readFile(new URL('../../migrations/20260920114124_cec0040_operational_state.sql',import.meta.url),'utf8');

test('migration is bootstrap-gated, service-role-only and carries the exact 30d seed',()=>{
  assert.match(migration,/0\.9945815883759598,116,0,'2026-09-20T07:03:54\.503Z',false/);
  assert.match(migration,/enable row level security/g);
  assert.match(migration,/revoke execute on function public\.v11_cec0040_decide/);
  assert.match(migration,/grant execute on function public\.v11_cec0040_decide[\s\S]*to service_role/);
  assert.match(migration,/order by x\.entry_at desc, x\.position_id desc/);
  assert.match(migration,/CEC0040_TARGET_OBSERVATION_LAG/);
  assert.match(migration,/CEC0040_BOOTSTRAP_REQUIRED/);
  assert.doesNotMatch(migration,/CEC0040_FORWARD_SHADOW_REQUIRED/);
  assert.match(migration,/v11_cec0040_set_enforcement/);
});

test('executor integration is version-gated and cannot rewrite legacy positions',()=>{
  assert.match(executor,/CEC0040_VERSION/);
  assert.match(executor,/P142_POLICY_VERSION/);
  assert.match(executor,/v11_cec0040_decide/);
  assert.match(executor,/v11_cec0040_register_target/);
  assert.match(executor,/async function fetchCec0040Public/);
  assert.match(executor,/attempt<=3/);
  assert.match(executor,/AbortSignal\.timeout\(5000\)/);
  assert.match(executor,/leaderExitPolicyVersion:.*P142_POLICY_VERSION/);
  assert.match(executor,/meta\.leaderExitPolicyVersion===P142_POLICY_VERSION/);
  assert.match(executor,/ctx\?\.fastObservation!==true&&costUsable/);
  assert.match(executor,/mode==="cec-bootstrap"/);
});
