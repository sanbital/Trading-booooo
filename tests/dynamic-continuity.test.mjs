import test from 'node:test';
import assert from 'node:assert/strict';
import {validCapture,rawCapture,dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {src,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket,hash,modelInput} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {DYNAMIC_VERSION,compactDynamic} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {dualEntryDecision,frozenReview,arbitrationPayload,reviewsFor} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {detectChange,buildRecheckPacket,recheckModelInput} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {nextEvent,initialHoldState,holdStep} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {prepareStoredReplay} from '../supabase/functions/_shared/gpt-final-decision/stored-replay.mjs';
import {readCapture} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
const T=1800000000200;
async function packet(){const p=await buildDecisionPacket({task:'ENTRY',subjectId:'continuity',symbol:'ABCUSDT',dataMode:'LIVE',
 facts:computeFacts({...src(T),captureContext:validCapture(T)},{asOf:T,referenceClose:1})});
 p.dynamic_policy=DYNAMIC_VERSION;p.dynamic_as_of_ms=T;p.snapshot_hash=await hash({...p,snapshot_hash:''});return p;}
test('fresh unchanged final recheck still runs and includes all raw buckets, tape and initial deltas',async()=>{
 const c=validCapture(T),initial={facts:{},capture_context:c,dynamic_policy:DYNAMIC_VERSION,executionRef:{mid:1.2}},
  pre={at:T,mid:1.2,capture_context:c,tape:{return:.001,buyShare:.6,tradeCount:100}},detection=detectChange(initial,pre);
 assert.ok(detection.reasons.includes('MANDATORY_PREORDER_DYNAMIC_REVIEW'));
 const p=await buildRecheckPacket({signalId:'x',symbol:'ABCUSDT',facts:(await packet()).facts,initial,detection,preDispatch:pre}),input=recheckModelInput(p);
 assert.equal(input.current.capture_context.ordered_path.length,24);assert.deepEqual(input.fast_recheck.tape,pre.tape);
 assert.equal(input.dynamic_change.changes.s120.return,0);assert.equal(input.initial.capture_context.ordered_path.length,24);
});
test('all ordered bucket information is represented and latest six are explicitly indexed',()=>{
 const c=validCapture(T),small=compactDynamic(c);assert.deepEqual(small.latest_six_range,[18,23]);
 for(let i=0;i<24;i++)assert.deepEqual(small.ordered_path[i],small.ordered_path_columns.map(k=>c.trajectory[i][k]));
 assert.equal(c.trajectory.length,24);
 for(let i=18;i<24;i++)assert.ok(small.critical_segments.some(x=>x.index===i));
});

test('same-snapshot FINAL sends every ordered bucket once and explicitly binds both citation prefixes',async()=>{
 const p=await packet(),f=await frozenReview(p,{snapshotAtMs:T});
 assert.equal(f.capture_trajectory_hash,await hash(p.facts.capture_context.trajectory));
 const payload=arbitrationPayload(f,f,reviewsFor({valid:false},{valid:false}));
 const input=JSON.parse(payload.input[1].content);
 assert.equal(input.capture_context.ordered_path.length,24);
 assert.equal(input.initial_snapshot,undefined);
 assert.equal(input.initial_snapshot_reference.snapshot_hash,f.snapshot_hash);
 assert.match(input.initial_snapshot_reference.meaning,/initial\.\* and current\.\*/);
});

test('capture reader and review use one canonical hash even after JSONB reorders object keys',async()=>{
 const c=await readCapture('ABCUSDT',T,{env:k=>k==='SUPABASE_URL'?'https://fixture.invalid':'test-key',
  fetchFn:async()=>Response.json(rawCapture(T))});
 assert.equal(c.status,'AVAILABLE');assert.equal(c.trajectory_hash,await hash(c.trajectory));
 const reordered=c.trajectory.map(p=>Object.fromEntries(Object.entries(p).reverse()));
 assert.equal(c.trajectory_hash,await hash(reordered));
});

test('stored replay keeps the historical clock and missing data, excluding realized outcomes',async()=>{
 const p=await packet(),record={packet:p,snapshot_at_ms:T,result:{decision:'BUY'},realized_pnl:999};
 const r=await prepareStoredReplay(record);assert.equal(r.at,T);assert.equal(r.safety.ok,true);
 assert.equal(r.packet.realized_pnl,undefined);assert.equal(r.packet.result,undefined);
 p.task='HOLD';p.facts.capture_context={status:'TIMEOUT'};
 const missing=await prepareStoredReplay(record);
 assert.equal(missing.packet.dynamic_data_state.status,'DATA_DEGRADED');
 assert.equal(missing.packet.facts.capture_context.status,'TIMEOUT');
 assert.equal(missing.packet.dynamic_data_state.emergency_packet.status,'UNAVAILABLE');
});
test('dynamic FINAL and DeepSeek share exactly one snapshot; inference aging prevents BUY',async()=>{
 const p=await packet();let at=T,calls=0,refreshes=0,adviceHash;
 const out=await dualEntryDecision(p,{apiKey:'unit',now:()=>at,snapshotAtMs:T,deadlineMs:T+20000,
  fetchFn:async()=>{throw Error('unexpected network');},refreshPacket:async()=>{refreshes++;throw Error('must not refresh just one provider');},
  counterCall:async s=>{adviceHash=s.snapshot_hash;return {valid:false,attempted:false,error:'UNAVAILABLE',snapshot_hash:s.snapshot_hash};},
  gptCall:async(p,o)=>{calls++;if(calls===1)return {valid:false,attempted:false,error:'PRELIMINARY'};
   const wire={...dynamicWire(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',support:['return_5m'],n:'Continuation'}),modelInput(p)),
    arbitration:{considered:[],adopted:[],rejected:[],supporting:[],opposing:[],reason:'Current flow'}};
   at=p.facts.capture_context.end_ms+10000;return {valid:true,wire,answer:wire,decision:'BUY',attempted:true};}});
 assert.equal(refreshes,0);assert.equal(out.arbitration.gpt_snapshot_hash,adviceHash);
 assert.equal(out.valid,false);assert.equal(out.decision,'WAIT');assert.match(out.error,/STALE/);
 assert.equal(out.arbitration.final_decision,out.decision);
 assert.equal(out.dynamic_audit.final_decision,out.decision);
});
test('critical events and recovery bypass old HOLD and routine review caps without granting EXIT',()=>{
 for(const event of ['BID_DEPTH_COLLAPSE','SELL_DOMINANCE','MOMENTUM_ACCELERATION_FLIP','TREND_BREAK','BTC_SHOCK','TRAJECTORY_RECOVERED']){
  const s={...initialHoldState(1),reviews:30,lastReviewAt:T-6000,retryAfter:T+60000,holdUntil:T+900000};
  const r=nextEvent(s,{now:T,price:1,peak:1,dynamics:{event,evidenceKey:event+':new'}});
  assert.equal(r.event,event);assert.equal(r.close,undefined);
 }
});
test('a newly judged degraded HOLD never acquires a reusable HOLD TTL or lowers protection',async()=>{
 const state={...initialHoldState(1),protectLevel:1.02,holdUntil:T+900000,pending:{key:'j',at:T-1000},dynamicTracker:{status:'DATA_DEGRADED'}};
 const r=await holdStep(state,{now:T,price:1.03,peak:1.05,timeCandidate:'V17_MAX_HOLD',positionId:'p',generation:'g',
  answerOf:async()=>({state:'DONE',valid:true,decision:'HOLD',snapshot_at_ms:T-900,completed_at_ms:T-100})});
 assert.equal(r.close,false);assert.equal(r.reason,'FD1_DATA_DEGRADED_REVIEWED');assert.equal(r.state.holdUntil,null);
 assert.equal(r.state.protectLevel,1.02);assert.equal(r.state.retryAfter,T+5000);
});
