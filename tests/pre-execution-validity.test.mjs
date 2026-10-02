import test from 'node:test';
import assert from 'node:assert/strict';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
import {validateCapture120} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {classifyPreExecutionValidity,preExecutionDeltaPacket,preExecutionDeltaPayload,
  VALIDITY_RESULT} from '../supabase/functions/_shared/gpt-final-decision/pre-execution-validity.mjs';
import {clockExecutionStep,setRecheckTestHooks} from '../supabase/functions/v10-lane-executor/gpt-final-recheck-adapter.mjs';
import {MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {nmrClockFinal} from '../test-support/nmr-clock-final.mjs';
import {rollingCapture} from '../test-support/pre-execution-fixtures.mjs';

const T=Date.parse('2026-09-30T11:40:40Z');
function capture(at,{price=null,weak=false,mixed=false,hash='capture-'+at}={}){
  const raw=rawCapture(at),target=price??raw.trajectory.at(-1).mid,
    scale=target/raw.trajectory.at(-1).mid;
  for(let i=0;i<raw.trajectory.length;i++){
    const p=raw.trajectory[i];p.mid*=scale;p.start_mid*=scale;p.btc_return_1m=weak?-.004:.001;
    if(weak||mixed){
      const prior=i?raw.trajectory[i-1].mid:p.start_mid;
      p.start_mid=prior;p.mid=prior*(1-(weak?.0008:.00015));p.d_mid_bps=(p.mid/p.start_mid-1)*10000;
      p.buy_share_5s=weak?.2:.52;p.aggressive_buy=weak?150:520;p.aggressive_sell=weak?850:480;
      p.net_taker_quote_5s=p.aggressive_buy-p.aggressive_sell;p.trade_count=80-i;p.arrival_rate=16-i*.3;
      p.bid_depth_25_usdt=weak?100000-i*2500:100000;p.ask_depth_25_usdt=weak?100000+i*2500:100000;
      p.imbalance=weak?-.45:0;p.d_bid_depth_25_pct=weak?-.025:0;p.d_ask_depth_25_pct=weak?.025:0;
    }
  }
  // Preserve the requested final price after constructing the weak path.
  const endScale=target/raw.trajectory.at(-1).mid;
  for(const p of raw.trajectory){p.mid*=endScale;p.start_mid*=endScale;}
  const out=validateCapture120(raw,at);assert.equal(out.status,'AVAILABLE');out.trajectory_hash=hash;return out;
}
function quote(c,at,{spreadBps=2}={}){
  const mid=c.trajectory.at(-1).mid,half=spreadBps/20000,bid=mid*(1-half),ask=mid*(1+half),step=mid*.00005;
  return {best_bid:bid,best_ask:ask,bids:Array.from({length:60},(_,i)=>[bid-i*step,1000]),
    asks:Array.from({length:60},(_,i)=>[ask+i*step,1000]),timing:{received_at_ms:at}};
}
function ticket(original,{completed=T,snapshot=T,summary='상승 압력과 매수 흐름이 유지된다'}={}){
  const p=original.trajectory.at(-1),q=quote(original,snapshot),mid=(q.best_bid+q.best_ask)/2;
  return {initial:{completedAt:completed,snapshotAt:snapshot,executionRef:{mid,bid:q.best_bid,ask:q.best_ask,at:snapshot},
    capture_context:original,summary,support:['return_5m','taker_buy_ratio_5m'],decision_reason:'상승 압력 유지',
    thesis_invalidation:'매수 흐름 붕괴와 고점 갱신 실패',facts:{spread_bps:2,est_buy_slippage_bps:2,
      bid_depth_25bps_usdt:60000,ask_depth_25bps_usdt:60000,book_imbalance_25bps:0,
      distance_trigger_reference:.002,volume_ratio_5m_vs_60m:.73,oi_change_5m:-.01}},clockFinalAuthority:{completed_at_ms:completed}};
}
const classify=(original,latest,at,extra={})=>classifyPreExecutionValidity({ticket:ticket(original),latestCapture:latest,
  quote:quote(latest,at),at,executionSafety:{ok:true},...extra});

test('1. BUY + 2s unchanged => VALID, no GPT required',()=>{
  const original=capture(T,{hash:'original'}),r=classify(original,original,T+2000);
  assert.equal(r.result,VALIDITY_RESULT.VALID);assert.equal(r.new_buckets_since_buy,0);
});

test('2. BUY + 40s with still-strong rolling trajectory => VALID',()=>{
  const original=capture(T,{hash:'original'}),latest=capture(T+40000,{price:original.trajectory.at(-1).mid,hash:'strong-40s'}),
    r=classify(original,latest,T+40000);
  assert.equal(r.result,VALIDITY_RESULT.VALID,JSON.stringify(r.reasons));assert.ok(r.new_buckets_since_buy>=7);
});

test('3. BUY + 40s clear price/flow reversal => INVALID and no order authority',()=>{
  const original=capture(T,{hash:'original'}),latest=capture(T+40000,{price:original.trajectory.at(-1).mid*.992,weak:true,hash:'weak'}),
    r=classify(original,latest,T+40000);
  assert.equal(r.result,VALIDITY_RESULT.INVALID);assert.ok(r.reasons.includes('CLEAR_MULTI_AXIS_REVERSAL'));
});

test('4. mixed changed state => UNCERTAIN and compact packet contains no 24-bucket trajectory',()=>{
  const original=capture(T,{hash:'original'}),latest=capture(T+40000,{price:original.trajectory.at(-1).mid*.997,mixed:true,hash:'mixed'}),
    r=classify(original,latest,T+40000),packet=preExecutionDeltaPacket(r,{signalId:'s',symbol:'TESTUSDT'}),
    wire=JSON.stringify(preExecutionDeltaPayload(packet));
  assert.equal(r.result,VALIDITY_RESULT.UNCERTAIN);assert.doesNotMatch(wire,/ordered_path|trajectory/);
  assert.deepEqual(Object.keys(packet.current.horizons),['s5','s15','s30','s60','s120']);
});

async function clockCase(decision,{providerError=null,allowReview=true}={}){
  const f=await nmrClockFinal(),at=f.original.result.completed_at_ms+25000,ref=f.ticket.initial.executionRef.mid,
    originalLast=f.ticket.initial.capture_context.trajectory.at(-1).mid,
    latest=rollingCapture(f.ticket.initial.capture_context,at,{ratio:(ref*1.006)/originalLast,hash:'clock-chase'}),
    store=new MemoryReviewStore();f.setNow(at);
  let calls=0;
  setRecheckTestHooks({capture:async()=>latest,store,apiKey:'offline',config:{mode:'ENFORCE',modeValid:true,
    approvalRef:'pre-execution-test',apiBudgetUsd:10,maxCalls:20,enforceApproved:true},log:[],fetchFn:async()=>{
      calls++;if(providerError)throw Error(providerError);
      return Response.json({status:'completed',model:MODEL,output:[{type:'message',content:[{type:'output_text',
        text:JSON.stringify({decision,reason:decision==='KEEP_BUY'?'근거 유지':'근거 소멸'})}]}],
        usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:0}}});
    }});
  const r=await clockExecutionStep(f.db,f.s,f.ticket,async()=>quote(latest,f.now()),{now:f.now,allowReview});
  setRecheckTestHooks(null);return {r,calls};
}

test('5. UNCERTAIN + GPT KEEP_BUY => order may proceed',async()=>{
  const {r,calls}=await clockCase('KEEP_BUY');assert.equal(calls,1,JSON.stringify(r.record.pre_execution_validity));assert.equal(r.proceed,true,r.reason);
  assert.equal(r.record.gpt_recheck_result,'KEEP_BUY');
});

test('6. UNCERTAIN + GPT CANCEL_BUY => no order',async()=>{
  const {r,calls}=await clockCase('CANCEL_BUY');assert.equal(calls,1);assert.equal(r.proceed,false);
  assert.equal(r.record.gpt_recheck_result,'CANCEL_BUY');
});

test('7. UNCERTAIN + GPT timeout/error => no old BUY inheritance',async()=>{
  const {r,calls}=await clockCase('KEEP_BUY',{providerError:'API_TIMEOUT'});assert.equal(calls,1);assert.equal(r.proceed,false);
  assert.match(r.record.gpt_recheck_result,/API_TIMEOUT/);
});

test('7a. UNCERTAIN with less than the full API budget => no API call and explicit insufficient window',async()=>{
  const f=await nmrClockFinal(),at=f.ticket.expires-16000,ref=f.ticket.initial.executionRef.mid,
    originalLast=f.ticket.initial.capture_context.trajectory.at(-1).mid,
    latest=rollingCapture(f.ticket.initial.capture_context,at,{ratio:(ref*1.006)/originalLast,hash:'clock-short-window'});
  f.setNow(at);let calls=0;
  setRecheckTestHooks({capture:async()=>latest,store:new MemoryReviewStore(),apiKey:'offline',config:{mode:'ENFORCE',modeValid:true,
    approvalRef:'test',apiBudgetUsd:10,maxCalls:20,enforceApproved:true},log:[],fetchFn:async()=>{calls++;throw Error('MUST_NOT_CALL');}});
  const r=await clockExecutionStep(f.db,f.s,f.ticket,async()=>quote(latest,f.now()),{now:f.now});setRecheckTestHooks(null);
  assert.equal(r.proceed,false);assert.equal(calls,0);
  assert.match(r.reason,/EXECUTION_WINDOW_INSUFFICIENT/);
});

test('8. VALID + GPT outage => no GPT call and normal order authority',async()=>{
  const f=await nmrClockFinal(),at=f.original.result.completed_at_ms+2000,ref=f.ticket.initial.executionRef.mid,
    originalLast=f.ticket.initial.capture_context.trajectory.at(-1).mid,
    latest=rollingCapture(f.ticket.initial.capture_context,at,{ratio:ref/originalLast,hash:'clock-strong'});f.setNow(at);let calls=0;
  setRecheckTestHooks({capture:async()=>latest,store:new MemoryReviewStore(),apiKey:'offline',config:{mode:'ENFORCE',modeValid:true,
    approvalRef:'test',apiBudgetUsd:10,maxCalls:20,enforceApproved:true},log:[],fetchFn:async()=>{calls++;throw Error('GPT_DOWN');}});
  const r=await clockExecutionStep(f.db,f.s,f.ticket,async()=>quote(latest,f.now()),{now:f.now});setRecheckTestHooks(null);
  assert.equal(r.proceed,true,r.reason);assert.equal(r.record.validity_result,'VALID');assert.equal(calls,0);
});

test('9. incomplete trajectory can never be VALID and failed recovery does not call GPT',async()=>{
  const original=capture(T,{hash:'original'}),latest=structuredClone(capture(T+10000,{hash:'incomplete'}));latest.trajectory.pop();
  const r=classify(original,latest,T+10000);assert.equal(r.result,VALIDITY_RESULT.UNCERTAIN);
  assert.ok(r.reasons.some(x=>/INCOMPLETE/.test(x)));
});

test('10. one candidate validation failure is candidate-scoped; another candidate still validates',async()=>{
  const original=capture(T,{hash:'original'}),bad=structuredClone(original);bad.status='UNAVAILABLE';bad.reason='READ_FAILED';
  const good=capture(T+2000,{price:original.trajectory.at(-1).mid,hash:'good'}),rows=await Promise.allSettled([
    Promise.resolve().then(()=>classify(original,bad,T+2000)),Promise.resolve().then(()=>classify(original,good,T+2000))]);
  assert.equal(rows[0].status,'fulfilled');assert.notEqual(rows[0].value.result,'VALID');
  assert.equal(rows[1].status,'fulfilled');assert.equal(rows[1].value.result,'VALID');
});

test('MOVR 2026-09-30 replay: 52s-old BUY at 1.83305 is not inherited at 1.81955',()=>{
  const original=capture(T,{price:1.83305,hash:'movr-buy-204040'}),latest=capture(T+52000,
    {price:1.81955,weak:true,hash:'movr-fill-204132'}),r=classifyPreExecutionValidity({
      ticket:ticket(original,{summary:'confidence 0.61, EXHAUSTION risk, weak volume and falling OI'}),
      latestCapture:latest,quote:quote(latest,T+52000),at:T+52000,executionSafety:{ok:true}});
  assert.equal(r.decision_age_ms,52000);assert.ok(Math.abs(r.price_drift_bps+73.6472)<.01);
  assert.notEqual(r.result,VALIDITY_RESULT.VALID);assert.equal(r.result,VALIDITY_RESULT.INVALID);
});

test('UNCERTAIN at writer boundary defers paid review without weakening latest data validation',async()=>{const {r,calls}=await clockCase('KEEP_BUY',{allowReview:false});assert.equal(calls,0);assert.equal(r.proceed,false);assert.equal(r.reason,'PRE_EXECUTION_REVIEW_REQUIRED');assert.equal(r.record.pre_execution_validity.result,'UNCERTAIN');});
