import test from 'node:test';
import assert from 'node:assert/strict';
import {fd1HoldTick,setFd1HoldTestHooks} from '../supabase/functions/v10-lane-executor/gpt-final-decision-adapter.mjs';
import {MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {positionGeneration} from '../supabase/functions/_shared/exit-authority.mjs';
import {buildDecisionPacket} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {frozenReview,DUAL_VERSION} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {FD1_HOLD_POLICY_VERSION} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
const T=1800000000000;
const p={id:'position-1',signal_id:'signal-1',symbol:'ABCUSDT',state:'OPEN',remaining_quantity:10,entry_price:100,entry_at:new Date(T-3600000).toISOString()};
const cfg={mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:50,maxCalls:300,enforceApproved:true};
async function advice(decision,{at=T,completed=T+3000,generation=positionGeneration(p)}={}){
 const packet=await buildDecisionPacket({task:'HOLD',subjectId:'emergency-test',symbol:p.symbol,dataMode:'LIVE',facts:computeFacts(src(at),{asOf:at}),position:{positionId:p.id,generation}});
 const shared=await frozenReview(packet,{snapshotAtMs:at});
 const answer={task:'HOLD',candidate_id:packet.candidate_id,snapshot_hash:shared.snapshot_hash,decision_preference:decision,recommended_action:decision,
 confidence:.8,thesis_state:'WEAKENING',bullish_evidence:[],bearish_evidence:['facts.trend.return_5m'],risk_flags:[],trajectory_interpretation:'Observed decline',strongest_counterargument:'Recovery possible',reason:'Risk evidence'};
 return {packet,result:{valid:false,decision:'ABSTAIN',error:'FD_KEY_MISSING',arbitration:{version:DUAL_VERSION,authority:'GPT_FINAL_ONLY',snapshot_hash:shared.snapshot_hash,
 deepseek_snapshot_hash:shared.snapshot_hash,gpt_first_snapshot_hash:shared.snapshot_hash,initial_input:structuredClone(shared.market_input),
 deepseek:{valid:true,answer,snapshot_hash:shared.snapshot_hash,snapshot_at_ms:at,completed_at_ms:completed}}}};
}
async function tick(out,{position=p,at=T,consumed=T+4000}={}){
 const store=new MemoryReviewStore();store.claim=async()=>{throw Error('API_BUDGET_EXHAUSTED')};
 setFd1HoldTestHooks({store,apiKey:'gpt',deepseekKey:'ds',config:cfg,now:()=>consumed,capture:async()=>null,review:async()=>out});
 return fd1HoldTick({},position,{meta:{},state:{peakPrice:104,stopPrice:97.5,lastHighAt:T-3000000},bid:102,now:at,timeCandidate:'V17_MOMENTUM_STALE'});
}
for(const decision of ['HOLD','PROTECT','EXIT'])test('budget exhausted: delayed valid '+decision+' is consumed with current time',async()=>{
 const r=await tick(await advice(decision));assert.equal(r.reason,'FD1_DEEPSEEK_'+decision);assert.equal(r.close,decision==='EXIT');
 if(decision==='PROTECT'){assert.ok(r.state.protectLevel>97.5);assert.equal(r.state.protection.exposureIncrease,false);}
});
for(const [name,mutate] of [
 ['wrong generation',o=>{o.result.arbitration.initial_input.snapshot.position_state.generation='old';}],
 ['wrong position',o=>{o.result.arbitration.initial_input.snapshot.position_state.position_id='other';}],
 ['mismatched hash',o=>{o.result.arbitration.deepseek.snapshot_hash='a'.repeat(64);}],
 ['unsupported evidence',o=>{o.result.arbitration.deepseek.answer.bearish_evidence=['facts.invented'];}],
 ['tampered evidence',o=>{o.result.arbitration.initial_input.facts.trend.return_5m=999;}],
 ['future completion',o=>{o.result.arbitration.deepseek.completed_at_ms=T+5000;}],
 ['future snapshot',o=>{o.result.arbitration.deepseek.snapshot_at_ms=T+5000;}],
 ['stale completion',o=>{o.result.arbitration.deepseek.completed_at_ms=T-30000;}],
 ['stale snapshot',o=>{o.result.arbitration.deepseek.snapshot_at_ms=T-30000;}],
 ['action disagreement',o=>{o.result.arbitration.deepseek.answer.recommended_action='HOLD';}],
 ['BUY',o=>{o.result.arbitration.deepseek.answer.decision_preference='BUY';o.result.arbitration.deepseek.answer.recommended_action='BUY';}],
 ['invalid advisory',o=>{o.result.arbitration.deepseek.valid=false;}],
])test('emergency rejects '+name,async()=>{const o=await advice('EXIT',{completed:T});mutate(o);const r=await tick(o,{consumed:T});assert.equal(r.close,false);assert.notEqual(r.fallback,true);});
test('closed position never gets emergency authority',async()=>{const r=await tick(await advice('EXIT',{completed:T}),{position:{...p,state:'CLOSED',remaining_quantity:0},consumed:T});assert.equal(r.close,false);});
test('both providers unavailable retains existing protection without close',async()=>{const r=await tick({result:{valid:false,decision:'ABSTAIN'}});assert.equal(r.close,false);});
for(const valid of [true,false])test('persisted API failure advisory '+(valid?'is revalidated':'rejects altered evidence')+' on consumption',async()=>{
 const out=await advice('EXIT');if(!valid)out.result.arbitration.deepseek.answer.bearish_evidence=['facts.fabricated'];
 const generation=positionGeneration(p),store={get:async()=>({state:'DONE',record:{purpose:'PRODUCTION',identity:{position_id:p.id,generation},...out}})};
 setFd1HoldTestHooks({store,apiKey:'gpt',deepseekKey:'ds',config:cfg,capture:async()=>null});
 const r=await fd1HoldTick({},p,{meta:{fd1Hold:{version:FD1_HOLD_POLICY_VERSION,generation,pending:{key:'job',event:'MOMENTUM_DETERIORATION',at:T}}},
 state:{peakPrice:104,stopPrice:97.5,lastHighAt:T-3000000},bid:102,now:T+4000,timeCandidate:'V17_MOMENTUM_STALE'});
 assert.equal(r.close,valid);
});
