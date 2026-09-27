import test from 'node:test';
import assert from 'node:assert/strict';
import {fd1HoldTick,setFd1HoldTestHooks} from '../supabase/functions/v10-lane-executor/gpt-final-decision-adapter.mjs';
import {MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {positionGeneration} from '../supabase/functions/_shared/exit-authority.mjs';
import {buildDecisionPacket,hash} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {frozenReview,DUAL_VERSION,dualEntryDecision} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {validateAdvisory} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {FD1_HOLD_POLICY_VERSION,HOLD_POLICY} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';

const T=1800000000000;
const position={id:'position-1',signal_id:'signal-1',symbol:'ABCUSDT',state:'OPEN',remaining_quantity:10,
  entry_price:100,entry_at:new Date(T-3600000).toISOString()};
const generation=positionGeneration(position);
const config={mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:50,maxCalls:300,enforceApproved:true};
const args={state:{peakPrice:104,stopPrice:97.5,lastHighAt:T-3000000},bid:102,timeCandidate:'V17_MOMENTUM_STALE'};
test.afterEach(()=>setFd1HoldTestHooks(null));

async function advice(decision='EXIT',{snapshot=T,completed=T+3000,task='HOLD'}={}){
  const packet=await buildDecisionPacket({task,subjectId:'emergency-test',symbol:position.symbol,dataMode:'LIVE',
    facts:computeFacts(src(snapshot),{asOf:snapshot}),position:{positionId:position.id,generation}});
  const frozen=await frozenReview(packet,{snapshotAtMs:snapshot});
  const answer={task,candidate_id:packet.candidate_id,snapshot_hash:frozen.snapshot_hash,
    decision_preference:decision,recommended_action:decision,confidence:.8,thesis_state:'WEAKENING',
    bullish_evidence:[],bearish_evidence:['facts.trend.return_5m'],risk_flags:[],
    trajectory_interpretation:'Observed decline',strongest_counterargument:'Recovery possible',reason:'Risk evidence'};
  validateAdvisory(answer,frozen);
  return {packet,result:{valid:false,decision:'ABSTAIN',error:'FD_KEY_MISSING',arbitration:{
    version:DUAL_VERSION,authority:'GPT_FINAL_ONLY',snapshot_hash:frozen.snapshot_hash,
    deepseek_snapshot_hash:frozen.snapshot_hash,gpt_first_snapshot_hash:frozen.snapshot_hash,
    initial_input:structuredClone(frozen.market_input),deepseek:{valid:true,answer,
      snapshot_hash:frozen.snapshot_hash,snapshot_at_ms:snapshot,completed_at_ms:completed}}}};
}
// Rehash identity mutations so identity checks are exercised independently of hash corruption.
async function rehash(out){
  const arb=out.result.arbitration,{snapshot,...market}=arb.initial_input;
  const {snapshot_hash:ignored,...identity}=snapshot;
  const digest=await hash({identity,market});
  snapshot.snapshot_hash=arb.snapshot_hash=arb.deepseek_snapshot_hash=arb.gpt_first_snapshot_hash=
    arb.deepseek.snapshot_hash=arb.deepseek.answer.snapshot_hash=digest;
}
async function consume(out,{persisted=false,p=position,at=T,consumed=T+4000,unavailable=false}={}){
  let reviewCalls=0,orders=0,clockReads=0;
  const store=new MemoryReviewStore();
  store.claim=async()=>{throw Error('API_BUDGET_EXHAUSTED');};
  store.get=async()=>({state:'DONE',record:{purpose:'PRODUCTION',identity:{position_id:position.id,generation},...out}});
  const db={from(){orders++;throw Error('Unexpected database/order call');},rpc(){orders++;throw Error('Unexpected order RPC');}};
  setFd1HoldTestHooks({leader20Control:{active_strategy:'LEGACY'},store,apiKey:unavailable?'':'gpt',deepseekKey:'ds',config,capture:async()=>null,
    now:()=>{clockReads++;assert.equal(reviewCalls,1,'read the consumption clock after provider completion');return consumed;},
    review:async()=>{reviewCalls++;return out;}});
  const meta=persisted?{fd1Hold:{version:FD1_HOLD_POLICY_VERSION,generation,
    pending:{key:'job',event:'MOMENTUM_DETERIORATION',at}}}:{};
  const result=await fd1HoldTick(db,p,{...args,meta,now:persisted?consumed:at});
  return {result,reviewCalls,orders,clockReads};
}
function denied({result,orders}){
  assert.equal(result.close,false);
  assert.notEqual(result.fallback,true);
  assert.equal(result.approval,undefined);
  assert.equal(result.state.protectLevel??null,null);
  assert.equal(result.state.holdUntil??null,null);
  assert.equal(orders,0);
}

for(const persisted of [false,true])for(const decision of ['HOLD','PROTECT','EXIT'])
test(`${persisted?'persisted':'budget exhausted'} validated ${decision} retains exit-only authority`,async()=>{
  const out=await advice(decision);
  // A forged outer valid flag is neither required nor sufficient for emergency authority.
  if(persisted)out.result.valid=true;
  const {result:r,orders}=await consume(out,{persisted});
  assert.equal(r.close,decision==='EXIT');assert.equal(r.state.last.authority,'DEEPSEEK_EMERGENCY_EXIT_ONLY');
  if(decision==='EXIT')assert.equal(r.approval.authority,'DEEPSEEK_EMERGENCY_EXIT_ONLY');
  // DeepSeek stands in for GPT only to EXIT or HOLD. Its PROTECT buys elevated sensitivity, not a
  // higher stop: with GPT unavailable the mandated fallback is KEEP_LAST_APPROVED_PROTECTION.
  if(decision==='PROTECT'){assert.equal(r.state.protectLevel??null,null);
    assert.equal(r.state.protectDeclined.verdict,'KEEP_LAST_APPROVED_PROTECTION');
    assert.equal(r.state.protectDeclined.provider,'deepseek');
    assert.equal(r.state.protection.sensitivityMultiplier,2);
    assert.equal(r.state.protection.exposureIncrease,false);}
  if(decision==='HOLD'&&persisted){assert.equal(r.state.holdUntil,null);assert.equal(r.reason,'FD1_DATA_DEGRADED_REVIEWED');}
  else if(decision==='HOLD')assert.ok(r.state.holdUntil>T);
  assert.equal(orders,0);
});

const mutations=[
  ['A persisted packet snapshot_hash mismatch despite valid=true',o=>{o.packet.snapshot_hash='a'.repeat(64);} ],
  ['A frozen packet hash mismatch despite valid=true',o=>{o.result.arbitration.initial_input.snapshot.packet_hash='a'.repeat(64);} ],
  ['B snapshot generation',async o=>{o.result.arbitration.initial_input.snapshot.position_state.generation='old';await rehash(o);} ],
  ['B persisted packet generation',o=>{o.packet.position.generation='old';} ],
  ['C snapshot position_id',async o=>{o.result.arbitration.initial_input.snapshot.position_state.position_id='other';await rehash(o);} ],
  ['C persisted packet position_id',o=>{o.packet.position.position_id='other';} ],
  ['D snapshot symbol',async o=>{o.result.arbitration.initial_input.snapshot.symbol='OTHERUSDT';await rehash(o);} ],
  ['D packet symbol',o=>{o.packet.symbol='OTHERUSDT';} ],
  ['packet content tampering',o=>{o.packet.facts.values.return_5m=999;} ],
  ['E packet candidate_id',o=>{o.packet.candidate_id='other';} ],
  ['E advisory candidate_id',o=>{o.result.arbitration.deepseek.answer.candidate_id='other';} ],
  ['F deepseek snapshot hash',o=>{o.result.arbitration.deepseek_snapshot_hash='a'.repeat(64);} ],
  ['F response snapshot hash',o=>{o.result.arbitration.deepseek.snapshot_hash='a'.repeat(64);} ],
  ['G GPT FIRST snapshot hash',o=>{o.result.arbitration.gpt_first_snapshot_hash='a'.repeat(64);} ],
  ['H unsupported evidence',o=>{o.result.arbitration.deepseek.answer.bearish_evidence=['facts.invented'];} ],
  ['market hash tampering',o=>{o.result.arbitration.initial_input.facts.trend.return_5m=999;} ],
  ['snapshot identity hash',o=>{o.result.arbitration.initial_input.snapshot.snapshot_hash='a'.repeat(64);} ],
  ['arbitration snapshot hash',o=>{o.result.arbitration.snapshot_hash='a'.repeat(64);} ],
  ['advisory snapshot hash',o=>{o.result.arbitration.deepseek.answer.snapshot_hash='a'.repeat(64);} ],
  ['arbitration version',o=>{o.result.arbitration.version='obsolete';} ],
  ['snapshot timestamp mismatch',async o=>{o.result.arbitration.initial_input.snapshot.snapshot_at_ms=T-1;await rehash(o);} ],
  ['packet task ENTRY',o=>{o.packet.task='ENTRY';} ],
  ['snapshot task ENTRY',async o=>{o.result.arbitration.initial_input.snapshot.task='ENTRY';await rehash(o);} ],
  ['advisory task ENTRY',o=>{o.result.arbitration.deepseek.answer.task='ENTRY';} ],
  ['decision/action disagreement',o=>{o.result.arbitration.deepseek.answer.recommended_action='HOLD';} ],
  ['invalid advisory',o=>{o.result.arbitration.deepseek.valid=false;} ],
  ['S DeepSeek BUY',o=>{Object.assign(o.result.arbitration.deepseek.answer,{decision_preference:'BUY',recommended_action:'BUY'});} ],
  ['K completion before snapshot',o=>{o.result.arbitration.deepseek.completed_at_ms=T-1;} ],
  ['J future completion',o=>{o.result.arbitration.deepseek.completed_at_ms=T+4001;} ],
  ['J future snapshot',async o=>{o.result.arbitration.deepseek.snapshot_at_ms=T+4001;
    o.result.arbitration.initial_input.snapshot.snapshot_at_ms=T+4001;await rehash(o);} ],
];
for(const persisted of [false,true])for(const [name,mutate] of mutations)
test(`${persisted?'persisted':'direct'} emergency rejects ${name}`,async()=>{
  const out=await advice();out.result.valid=true;await mutate(out);
  denied(await consume(out,{persisted}));
});

test('H validateAdvisory itself rejects evidence absent from the frozen input',async()=>{
  const out=await advice(),arb=out.result.arbitration;
  arb.deepseek.answer.bearish_evidence=['facts.unsupported'];
  assert.throws(()=>validateAdvisory(arb.deepseek.answer,{packet:out.packet,
    snapshot_hash:arb.snapshot_hash,market_input:arb.initial_input}),/DEEPSEEK_UNSUPPORTED_EVIDENCE/);
});
for(const persisted of [false,true])test(`${persisted?'persisted':'direct'} I stale completion and snapshot rejected`,async()=>{
  const consumed=T+HOLD_POLICY.exitMaxAgeMs+1;
  denied(await consume(await advice('EXIT',{completed:T}),{persisted,consumed}));
});
test('I fresh completion cannot revive an expired frozen snapshot',async()=>{
  const consumed=T+HOLD_POLICY.exitMaxAgeMs+1;
  denied(await consume(await advice('EXIT',{completed:consumed}),{consumed}));
});
test('L provider completion clock rejects advice that was fresh at tick start',async()=>{
  const out=await advice('EXIT',{completed:T});
  const r=await consume(out,{at:T,consumed:T+HOLD_POLICY.exitMaxAgeMs+1});
  denied(r);assert.equal(r.clockReads,1);assert.equal(r.reviewCalls,1);
});
test('GPT unavailable still allows fresh delayed emergency EXIT',async()=>{
  const {result,clockReads}=await consume(await advice(),{unavailable:true});
  assert.equal(result.reason,'FD1_DEEPSEEK_EXIT');assert.equal(clockReads,1);
});
for(const [name,p] of [['M CLOSED',{...position,state:'CLOSED'}],['N zero remaining',{...position,remaining_quantity:0}]])
test(`${name} refuses review and EXIT authority`,async()=>{
  const r=await consume(await advice(),{p});denied(r);
  assert.equal(r.result.reason,'FD1_POSITION_NOT_OPEN');assert.equal(r.reviewCalls,0);assert.equal(r.clockReads,0);
});
test('S internally valid ENTRY/BUY advice cannot authorize any HOLD emergency or new order',async()=>{
  denied(await consume(await advice('BUY',{task:'ENTRY'})));
});
test('S actual ENTRY arbitration with valid DeepSeek BUY and unavailable GPT returns ABSTAIN',async()=>{
  const {packet}=await advice('BUY',{task:'ENTRY'});let orders=0;
  const result=await dualEntryDecision(packet,{apiKey:'',deepseekKey:'ds',now:()=>T,snapshotAtMs:T,
    fetchFn:async()=>{orders++;throw Error('Unexpected external/order call');},
    counterCall:async shared=>({valid:true,available:true,attempted:true,snapshot_hash:shared.snapshot_hash,snapshot_at_ms:T,
      completed_at_ms:T,answer:{...(await advice('BUY',{task:'ENTRY'})).result.arbitration.deepseek.answer,snapshot_hash:shared.snapshot_hash}})});
  assert.equal(result.arbitration.deepseek_valid,true);assert.equal(result.valid,false);
  assert.equal(result.decision,'ABSTAIN');assert.equal(result.arbitration.authority,'GPT_FINAL_ONLY');assert.equal(orders,0);
});

async function refreshedAdvice(){
  const out=await advice(),next=structuredClone(out.packet);
  next.facts.values.return_5m+=.01;
  // Sensor normalization changes the packet after its original checksum was built.
  // Match the full frozen packet hash, not a recomputed pre-normalization checksum.
  next.facts.market_sensor={status:'UNAVAILABLE',reason:'FIXTURE',untrusted_extra:1};
  next.snapshot_hash=await hash({...next,snapshot_hash:''});
  const current=await frozenReview(next,{snapshotAtMs:T+1000});
  assert.notDeepEqual(current.packet,next);
  out.packet=structuredClone(current.packet);
  Object.assign(out.result.arbitration,{final_input:structuredClone(current.market_input),final_snapshot_hash:current.snapshot_hash});
  out.result.final_snapshot_at_ms=T+1000;
  return out;
}
async function rehashFinal(out){
  const arb=out.result.arbitration,{snapshot,...market}=arb.final_input;
  const {snapshot_hash:ignored,...identity}=snapshot;
  snapshot.snapshot_hash=arb.final_snapshot_hash=await hash({identity,market});
}
for(const persisted of [false,true])test(`${persisted?'persisted':'direct'} legitimate refreshed FINAL packet remains bound separately from DeepSeek FIRST`,async()=>{
  const out=await refreshedAdvice();
  assert.notEqual(out.result.arbitration.snapshot_hash,out.result.arbitration.final_snapshot_hash);
  const {result}=await consume(JSON.parse(JSON.stringify(out)),{persisted});
  assert.equal(result.close,true);assert.equal(result.approval.authority,'DEEPSEEK_EMERGENCY_EXIT_ONLY');
  assert.equal(result.approval.snapshotHash,out.result.arbitration.snapshot_hash,'authority still cites validated DeepSeek input');
});
for(const [name,mutate] of [
  ['full packet hash',async o=>{o.result.arbitration.final_input.snapshot.packet_hash='a'.repeat(64);await rehashFinal(o);} ],
  ['final snapshot reference',o=>{o.result.arbitration.final_snapshot_hash='a'.repeat(64);} ],
  ['final market tampering',o=>{o.result.arbitration.final_input.facts.trend.return_5m=999;} ],
  ['task',async o=>{o.result.arbitration.final_input.snapshot.task='ENTRY';await rehashFinal(o);} ],
  ['position',async o=>{o.result.arbitration.final_input.snapshot.position_state.position_id='other';await rehashFinal(o);} ],
  ['generation',async o=>{o.result.arbitration.final_input.snapshot.position_state.generation='old';await rehashFinal(o);} ],
  ['symbol',async o=>{o.result.arbitration.final_input.snapshot.symbol='OTHERUSDT';await rehashFinal(o);} ],
  ['candidate',async o=>{o.result.arbitration.final_input.snapshot.candidate_id='other';await rehashFinal(o);} ],
  ['future time',async o=>{o.result.arbitration.final_input.snapshot.snapshot_at_ms=T+4001;await rehashFinal(o);} ],
  ['time before FIRST',async o=>{o.result.arbitration.final_input.snapshot.snapshot_at_ms=T-1;await rehashFinal(o);} ],
  ['substituted initial packet',async o=>{o.packet=(await advice()).packet;} ],
])test('persisted refreshed packet rejects '+name,async()=>{
  const out=await refreshedAdvice();await mutate(out);denied(await consume(out,{persisted:true}));
});
test('real arbitration output with failed GPT FINAL and refreshed packet supports validated emergency EXIT',async()=>{
  const initial=await advice(),next=structuredClone(initial.packet);
  next.facts.values.return_5m+=.01;next.snapshot_hash=await hash({...next,snapshot_hash:''});
  const result=await dualEntryDecision(initial.packet,{apiKey:'',deepseekKey:'ds',now:()=>T+4000,snapshotAtMs:T,
    refreshPacket:async()=>({packet:next,captured:T+1000}),
    fetchFn:async()=>{throw Error('Unexpected external request');},
    counterCall:async shared=>({valid:true,available:true,attempted:true,snapshot_hash:shared.snapshot_hash,
      snapshot_at_ms:T,completed_at_ms:T+3000,answer:{...initial.result.arbitration.deepseek.answer,snapshot_hash:shared.snapshot_hash}})});
  assert.equal(result.valid,false);assert.equal(result.arbitration.deepseek_valid,true);
  assert.notEqual(result.arbitration.snapshot_hash,result.arbitration.final_snapshot_hash);
  const consumed=await consume({packet:result.final_packet,result},{persisted:true});
  assert.equal(consumed.result.reason,'FD1_DEEPSEEK_EXIT');assert.equal(consumed.orders,0);
});
