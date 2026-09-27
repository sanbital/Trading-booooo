import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validCapture,rawCapture,dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {DYNAMIC_VERSION,HORIZONS,entryCaptureSafety,dynamicDelta,dispatchDynamicSafety,compactDynamic,positionDynamicState,entryFailureEvidence} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {readCaptureWithRecovery,validateCapture120,emergencyDynamicPacket} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {initialHoldState,holdStep} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {buildDecisionPacket,hash,modelInput} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {validateDecision} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {src,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
const T=1800000000200,clone=structuredClone;
test('full trajectory clock is independent of a fresh quote; exactly ten seconds blocks',()=>{
 const c=validCapture(T);assert.equal(entryCaptureSafety(c,T).ok,true);
 assert.equal(entryCaptureSafety(c,c.end_ms+9999).ok,true);
 assert.equal(entryCaptureSafety(c,c.end_ms+10000).decision,'WAIT');
 assert.equal(dispatchDynamicSafety({reviewed:c,latest:validCapture(T+15000),at:T+15000}).ok,false);
});
test('missing, gapped, future, incomplete book and unknown flow cannot BUY',()=>{
 for(const mutate of [c=>c.status='UNAVAILABLE',c=>c.trajectory.pop(),c=>c.trajectory[2].start_ms++,c=>c.trajectory[0].received_at_ms=T+1,
  c=>c.trajectory[5].bid_depth_25_usdt=null,c=>c.trajectory[3].flow_event_ms=null,c=>c.trajectory[7].book_received_at_ms-=20000]){
  const c=validCapture(T);mutate(c);assert.equal(entryCaptureSafety(c,T).ok,false);
 }
 assert.equal(entryCaptureSafety(validCapture(T),T,{btcRequired:true}).reason,'DYNAMIC_BTC_UNAVAILABLE');
});
test('a single negative bucket asks for review without deterministic strategic exit',()=>{
 const a=validCapture(T),b=clone(a);b.dynamics.horizons.s5.return=-.0001;
 const d=dynamicDelta(a,b);assert.equal(d.review,true);assert.ok(d.reasons.includes('DYNAMIC_RETURN_REVERSED_5'));
 assert.equal(d.close,undefined);assert.equal(dispatchDynamicSafety({reviewed:a,latest:b,at:T}).decision,'WAIT');
});
test('recovery retries role source then reconstructs raw buckets, without filling gaps',async()=>{
 const calls=[];const c=await readCaptureWithRecovery('ABCUSDT',T,{now:()=>T,read:async(_s,_a,o)=>{
  calls.push(o.rpc);return calls.length===3?validCapture(T):{status:'UNAVAILABLE',reason:calls.length===1?'TIMEOUT':'INVALID_OR_NONCAUSAL_BUCKET'};
 }});assert.equal(c.status,'AVAILABLE');assert.equal(c.recovery_attempts.length,3);assert.equal(calls[2],'doa_gpt_capture_context_v3');
 const failed=await readCaptureWithRecovery('ABCUSDT',T,{now:()=>T,read:async()=>({status:'UNAVAILABLE',reason:'INCOMPLETE_TRAJECTORY'})});
 assert.equal(failed.status,'UNAVAILABLE');assert.equal(failed.recovery_attempts.length,3);
});
test('per-position generation prevents previous position state from crossing lifecycle',()=>{
 const c=validCapture(T),a=positionDynamicState(null,c,{at:T,bid:1.2,entry:1.1,generation:'a',positionId:'A'});
 const b=positionDynamicState(a,{status:'UNAVAILABLE',reason:'TIMEOUT'},{at:T+5000,bid:1.1,entry:1.1,generation:'b',positionId:'B'});
 assert.equal(b.last_valid_capture,null);assert.equal(b.position_id,'B');assert.equal(b.status,'DATA_DEGRADED');
 const degraded=positionDynamicState(a,{status:'UNAVAILABLE',reason:'TIMEOUT'},{at:T+15000,bid:1.1,entry:1.1,generation:'a',positionId:'A'});
 assert.equal(degraded.last_valid_age_ms,T+15000-c.end_ms);assert.ok(degraded.drift_from_last_valid<0);
 assert.equal(degraded.hard_stop_action,'KEEP');assert.equal(degraded.approved_protection_action,'NEVER_LOWER');assert.equal(degraded.close,undefined);
});

test('missing initial tracker and generation preserve DATA_DEGRADED without throwing',()=>{
 for(const previous of [null,undefined]){
  const state=positionDynamicState(previous,{status:'UNAVAILABLE',reason:'TIMEOUT'},
   {at:T,bid:1.1,entry:1.1,positionId:'fixture'});
  assert.equal(state.status,'DATA_DEGRADED');assert.equal(state.last_valid_capture,null);
  assert.equal(state.hard_stop_action,'KEEP');assert.equal(state.approved_protection_action,'NEVER_LOWER');
 }
});
test('compact evidence preserves horizons and source indices; raw journal is unchanged',()=>{
 const c=validCapture(T),before=JSON.stringify(c),short=compactDynamic(c);
 assert.deepEqual(short.dynamics,c.dynamics);assert.ok(short.critical_segments.length<=8);
 for(const p of short.critical_segments)assert.equal(p.mid,c.trajectory[p.index].mid);
 assert.equal(short.trajectory,undefined);assert.equal(JSON.stringify(c),before);
 assert.ok(JSON.stringify(short).length<JSON.stringify(c).length);
});
test('horizon endpoint includes the start boundary for liquidity change and drawdown',()=>{
 const raw=rawCapture(T),p=raw.trajectory.at(-1);p.mid=p.start_mid*.99;p.d_mid_bps=-100;p.bid_depth_25_usdt=90000;p.d_bid_depth_25_pct=-.1;
 const c=validateCapture120(raw,T),h=c.dynamics.horizons.s5;
 assert.ok(Math.abs(h.drawdown_from_sampled_peak+.01)<1e-7);assert.equal(h.bid_liquidity_change,-.1);
 for(const s of HORIZONS)assert.ok('acceleration_bps_s2' in c.dynamics.horizons['s'+s]);
});
test('entry failure is multi-axis review evidence; healthy winner pullback is not an automatic exit',()=>{
 const c=validCapture(T);c.dynamics.horizons.s15.return=-.0001;
 assert.equal(entryFailureEvidence(c,{entry:1,peak:1.2}).review,false);
 for(const s of [15,30])Object.assign(c.dynamics.horizons['s'+s],{return:-.01,net_taker_flow:-200,buy_share_slope:-.01,aggressive_sell:800,aggressive_buy:200,sampled_high_renewals:0,bid_liquidity_change:-.1,ask_liquidity_change:.1});
 const f=entryFailureEvidence(c,{entry:1.2,peak:1.2});assert.equal(f.review,true);assert.ok(f.axes.includes('PRICE'));assert.ok(f.axes.includes('FLOW'));assert.ok(f.axes.includes('BOOK'));assert.equal(f.close,undefined);
});
test('late completed HOLD remains HOLD with explicit unapplied status',async()=>{
 const st={...initialHoldState(1),pending:{key:'j',event:'DATA_DEGRADED',at:T},protectLevel:1.01};
 const r=await holdStep(st,{now:T+60000,price:.99,peak:1.03,positionId:'p',generation:'g',answerOf:async()=>({state:'DONE',valid:true,decision:'HOLD',started_at_ms:T+100,completed_at_ms:T+7000,snapshot_at_ms:T+500})});
 assert.equal(r.state.last.decision,'HOLD');assert.equal(r.state.last.applied_decision,null);assert.equal(r.state.last.ignored_reason,'LATE_RESULT_NOT_APPLIED');
 assert.equal(r.reason,'LATE_RESULT_NOT_APPLIED');assert.equal(r.close,false);assert.equal(r.state.protectLevel,1.01);
});
test('refresh failure is recorded separately from a late response',async()=>{
 const r=await holdStep({...initialHoldState(1),pending:{key:'j',at:T}},{now:T+2000,price:1,peak:1,positionId:'p',generation:'g',answerOf:async()=>({state:'DONE',valid:true,decision:'EXIT',completed_at_ms:T+1000,snapshot_at_ms:T,refresh_error:'MISSING'})});
 assert.equal(r.state.last.decision,'EXIT');assert.equal(r.state.last.ignored_reason,'SNAPSHOT_REFRESH_FAILED');assert.equal(r.close,false);
});
test('BUY requires five horizon citations plus flow and book; confidence is bounded',async()=>{
 const facts=computeFacts({...src(T),captureContext:validCapture(T)},{asOf:T,referenceClose:1});
 const p=await buildDecisionPacket({task:'ENTRY',subjectId:'test',symbol:'ABCUSDT',dataMode:'LIVE',facts});
 p.dynamic_policy=DYNAMIC_VERSION;p.dynamic_as_of_ms=T;p.snapshot_hash=await hash({...p,snapshot_hash:''});
 const w=dynamicWire(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',support:['return_5m','taker_buy_ratio_5m'],n:'Continuation'}),modelInput(p));
 assert.equal(validateDecision(w,p).decision,'BUY');
 for(const mutate of [w=>w.why_buy_now.horizons.s5.evidence=[],w=>w.why_buy_now.flow=[],w=>w.why_buy_now.orderbook=[],w=>w.dynamic_evidence=['dynamics.fabricated'],w=>w.confidence=2]){
  const x=clone(w);mutate(x);assert.throws(()=>validateDecision(x,p));
 }
});
test('emergency packet never claims full trajectory or authorizes entry',async()=>{
 const r=await emergencyDynamicPacket('ABCUSDT',{now:()=>T,fetchFn:async url=>Response.json(url.includes('depth')?{T,bids:[[1,5]],asks:[[1.001,5]]}:[{T:T-100,p:'1',q:'2',m:true}])});
 assert.equal(r.status,'EMERGENCY_PARTIAL');assert.equal(r.full_trajectory,false);assert.equal(r.entry_allowed,false);assert.equal(r.net_taker_flow,-2);
});
const incident=JSON.parse(readFileSync(new URL('../test-support/soon-20260927-replay.json',import.meta.url)));
test('stored SOON loss: actual initial/final direction flip and predispatch stale reviewed trajectory produce WAIT',()=>{
 const j=incident.jobs.find(x=>x.decision==='BUY'),a=j.record.result.arbitration.initial_input.capture_context,b=j.record.packet.facts.capture_context;
 const point=incident.reconstruction.find(x=>x.t.includes('03:44:27')),at=Date.parse(point.t),c=validateCapture120(point.capture,at);
 assert.equal(c.status,'AVAILABLE');assert.ok(a.dynamics.horizons.s5.return>0);assert.ok(b.dynamics.horizons.s5.return<0);
 assert.equal(dynamicDelta(a,b).review,true);const r=dispatchDynamicSafety({reviewed:b,latest:c,at});
 assert.equal(r.decision,'WAIT');assert.match(r.reason,/REVIEWED_.*STALE/);assert.ok(at-b.end_ms>17000);
 assert.ok(Math.abs(incident.position.realized_pnl_usdt+11.5596817)<1e-7);
});
test('stored SOON HOLD missing data: DATA_DEGRADED and causal reconstruction, no automatic EXIT',()=>{
 const j=incident.jobs.find(x=>x.decision==='HOLD'),at=Date.parse(j.completed_at),capture=j.record.packet.facts.capture_context;
 assert.equal(capture.status,'UNAVAILABLE');const state=positionDynamicState(null,capture,{at,bid:.285,entry:.2898,generation:'incident',positionId:incident.position.id});
 assert.equal(state.status,'DATA_DEGRADED');assert.equal(state.close,undefined);
 const archived=incident.reconstruction.find(x=>x.t.includes('03:46:18'));assert.equal(validateCapture120(archived.capture,Date.parse(archived.t)).status,'AVAILABLE');
});
test('stored SOON EXIT latency exceeded time to native stop; no fictional earlier execution claim',()=>{
 const j=incident.jobs.find(x=>x.decision==='EXIT'),completed=Date.parse(j.api_completed_at),closed=Date.parse(incident.position.closed_at);
 assert.ok(completed>closed);assert.ok(completed-Date.parse(j.api_started_at)>9000);
});
