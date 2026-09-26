import test from 'node:test';
import assert from 'node:assert/strict';
import {FD1_ENTRY_ENGINE as FD1} from '../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {buildDecisionPacket,hash,MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {frozenReview} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {validateMarketSensor,SENSOR_CONTRACT} from '../supabase/functions/_shared/gpt-final-decision/market-sensor.mjs';
import {T,src,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {finalFields} from '../test-support/arbitration-fixtures.mjs';
import {gptFilterExecutable,gptFinalCheck,runWithGptReview,setTestCoordinator,recordAsyncReviewOutcome} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {buildRecheckPacket,recheckPayload} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {lifecycleNote,expiredTriggerReason} from '../supabase/functions/v10-lane-executor/entry-lifecycle.mjs';
const cfg={mode:'ENFORCE',modeValid:true,approvalRef:'fixture',apiBudgetUsd:3,maxCalls:300,enforceApproved:true};
function sensor(){
 const points=Array.from({length:24},(_,i)=>{const end=T-5000-(23-i)*5000;return {
  bucket_ms:end,start_ms:end-5000,end_ms:end,received_at_ms:end+10,exchange_event_ms:end-100,book_received_at_ms:end-50,
  btc_candle_end_ms:end-1000,btc_candle_exchange_ms:end-999,btc_candle_received_ms:end-950,
  bucket_complete:true,book_complete:true,trade_sequence_complete:true,flow_causal:true,btc_candle_complete:true,trade_count:0,
  mid:100+i*.01,start_mid:100+(i-1)*.01,best_bid:99.99,best_ask:100.01,spread_bps:2,
  taker_buy_quote_5s:0,taker_sell_quote_5s:0,btc_return_1m:.001,observed_bid_depth_usdt:1000,observed_ask_depth_usdt:1000,
  depth_bid_coverage_bps:10,depth_ask_coverage_bps:10,depth_bid_boundary:99.9,depth_ask_boundary:100.1,depth_coverage_complete:false};});
 return validateMarketSensor({status:'AVAILABLE',symbol:'BTCUSDT',role:'MARKET_SENSOR',contract:SENSOR_CONTRACT,version:SENSOR_CONTRACT,
  buckets:24,start_ms:points[0].start_ms,end_ms:points.at(-1).end_ms,ingested_at_ms:T-100,as_of_ms:T,market_sensor_trajectory:points},T);
}
const signal=()=>({id:'snapshot-resume',symbol:'QUSDT',status:'NEW',features:{strategy:'LEADER_MOMENTUM_V17',referenceClose:1,dayReturn:.1,rank:1,
 v17Setup:{state:'TRIGGERED',triggerAt:T},exitPolicy:{stopPct:.01}}});
async function packet(s=signal(),available=true,task='ENTRY'){
 const facts=computeFacts(src(T),{asOf:T+500});facts.market_sensor=available?sensor():validateMarketSensor(null,T);
 const p=await buildDecisionPacket({task,subjectId:s.id,symbol:s.symbol,dataMode:'LIVE',facts,judgments:FD1.identity(s).judgments,
  position:task==='HOLD'?{event:'REVIEW',positionId:'position',generation:'generation'}:null});
 p.as_of_offset_ms=500;p.execution_ref={bid:1.199,ask:1.2,mid:1.1995,at:T+500};p.snapshot_hash=await FD1.packetHash(p);return p;
}
function setup({decision='BUY',available=true,onResolved,store=new MemoryReviewStore()}={}){
 let clock=T+500,calls=0;
 const engine={...FD1,async prepare(identity){return {packet:await packet({...signal(),id:identity.signal_id},available),captured:T+500};}};
 const fetchFn=async(url,opts)=>{
  assert.equal(new URL(url).hostname,'api.openai.com','no exchange or live DB requests');calls++;
  const input=JSON.parse(JSON.parse(opts.body).input[1].content),d=decision;
  const wire=entryWire({t:'ENTRY',c:input.candidate_id,d,reasons:d==='SKIP'?[{r:'GPT_JUDGMENT',e:['return_5m']}]:[],
   support:d==='ABSTAIN'?[]:['return_5m','taker_buy_ratio_5m'],n:'Fixture review'});
  if(input.independent_reviews)wire.arbitration=finalFields(input);
  return Response.json({model:MODEL,status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]},
   {headers:{'x-request-id':'fixture-request'}});
 };
 const make=()=>new FinalReviewCoordinator({config:cfg,store,apiKey:()=>'fixture',engine,fetchFn,now:()=>clock,baseline:()=>true,onResolved});
 const c=make();return {c,make,store,s:signal(),setNow:t=>clock=t,calls:()=>calls};
}
async function complete(x){assert.equal((await x.c.consider(x.s)).reason,'GPT_REVIEW_PENDING');await Promise.all([...x.c.pending.values()]);}
for(const task of ['ENTRY','HOLD'])test(task+' canonical sensor is hashed before freeze; input unchanged',async()=>{
 const p=await packet(signal(),true,task),original=structuredClone(p),f=await frozenReview(p,{snapshotAtMs:T+500});
 assert.equal(p.facts.market_sensor.status,'AVAILABLE');assert.equal(f.packet.facts.market_sensor.age_ms,p.facts.market_sensor.age_ms+500);
 assert.equal(await FD1.packetHash(f.packet),f.packet.snapshot_hash);
 assert.deepEqual(p,original);assert.ok(Object.isFrozen(f.packet.facts.market_sensor));
 assert.deepEqual((await frozenReview(f.packet,{snapshotAtMs:T+500})).packet,f.packet);
});
for(const available of [true,false])for(const decision of ['BUY','SKIP','ABSTAIN'])test(`${available?'AVAILABLE':'UNAVAILABLE'} ${decision}: durable DONE reread and raw wire validation`,async()=>{
 const x=setup({decision,available});await complete(x);
 const row=[...x.store.rows.values()][0];assert.equal(row.state,'DONE');assert.equal(row.record.result.valid,true,row.record.result.error);
 assert.ok(row.record.result.raw_response);assert.ok(row.record.result.request_id);assert.equal(row.record.result.wire_profile,FD1.id);
 assert.deepEqual(row.record.packet,row.record.result.final_packet);assert.equal(row.record.snapshot_at_ms,row.record.result.final_snapshot_at_ms);
 const r=await x.c.consider(x.s);assert.equal(r.decision,decision);assert.equal(r.allowed,decision==='BUY');assert.equal(x.c.check(x.s).allowed,decision==='BUY');
 assert.equal(x.calls(),2,'FIRST + FINAL only, no repeated API request');
});
test('waitReady recovers BUY ticket from durable DONE after local tickets and hints are gone',async()=>{
 const x=setup();await complete(x);x.c.tickets.clear();x.c.readyHints.clear();x.c.pending.clear();x.c.yieldArmed=false;
 assert.equal(await x.c.waitReady(),true);assert.equal(x.c.check(x.s).allowed,true);
 const cold=x.make();assert.equal((await cold.consider(x.s)).allowed,true);assert.equal(cold.check(x.s).allowed,true);assert.equal(x.calls(),2);
});
test('pending wrapper resumes only after durable validation and ordinary second cycle rereads',async()=>{
 const x=setup(),db={};setTestCoordinator(db,x.c);let cycles=0;
 const out=await runWithGptReview(db,async()=>{cycles++;const r=await gptFilterExecutable(db,[x.s]);
  if(cycles===1){await Promise.all([...x.c.pending.values()]);return {ok:true,entry:{entered:false,reason:r.reason}};}
  assert.equal(r.candidates.length,1);assert.equal(gptFinalCheck(db,x.s).allowed,true);
  return {ok:true,entry:{entered:false,reason:'FIXTURE_ORDER_BOUNDARY'}};});
 assert.equal(cycles,2);assert.equal(out.gptFinalReview.rechecked,true);assert.equal(x.calls(),2);
});
for(const mutation of ['price','sensor','identity','wire'])test('DONE '+mutation+' tamper fails closed and replaces PENDING with real lifecycle reason',async()=>{
 const observed=[],x=setup({onResolved:async(s,r)=>observed.push(lifecycleNote({at:T+501,stage:'GPT_REVIEW',reason:r.reason,gptDecision:r.storedDecision}))});
 await complete(x);const row=[...x.store.rows.values()][0];
 if(mutation==='price')row.record.packet.facts.values.return_5m+=.1;
 if(mutation==='sensor')row.record.packet.facts.market_sensor.age_ms++;
 if(mutation==='identity')row.record.identity_json+=' ';
 if(mutation==='wire')row.record.result.request_id=null;
 x.c.tickets.set(x.s.id,{});
 assert.equal(await x.c.waitReady(),false);assert.equal(x.c.check(x.s).allowed,false);
 const reason=mutation==='identity'?'GPT_BINDING_MISMATCH':mutation==='wire'?'GPT_NO_VALID_API_RESPONSE':'GPT_SNAPSHOT_MISMATCH';
 assert.equal(observed.at(-1)?.reason,reason);assert.ok(!expiredTriggerReason(observed.at(-1)).includes('PENDING'));
});
test('pre-freeze tampering is refused rather than rehashed into a valid packet',async()=>{
 const p=await packet();p.facts.values.return_5m+=.1;await assert.rejects(frozenReview(p,{snapshotAtMs:T+500}),/GPT_SNAPSHOT_MISMATCH/);
});
test('aged BUY never dispatches without final recheck and closed trigger never resumes',async()=>{
 const x=setup();await complete(x);x.setNow(T+16000);assert.equal(await x.c.waitReady(),true);
 assert.equal(x.c.check(x.s).reason,'GPT_REVIEW_EXPIRED');assert.equal(x.c.check(x.s,{allowAged:true}).aged,true);
 x.setNow(T+58000);assert.equal((await x.c.consider(x.s)).allowed,false);assert.equal(x.c.check(x.s).allowed,false);
});
for(const change of ['signal','symbol','trigger','judgment'])test(change+' identity mismatch refuses restored BUY',async()=>{
 const x=setup();await complete(x);assert.equal((await x.c.consider(x.s)).allowed,true);const other=structuredClone(x.s);
 if(change==='signal')other.id+='-other';if(change==='symbol')other.symbol='OTHERUSDT';if(change==='trigger')other.features.v17Setup.triggerAt++;
 if(change==='judgment')other.features.rank++;
 assert.equal(x.c.check(other).allowed,false);
});
test('RECHECK shares the canonical sensor without changing initial/current execution references',async()=>{
 const p=await packet(),r=await buildRecheckPacket({signalId:'rc',symbol:p.symbol,facts:p.facts,initial:{executionRef:p.execution_ref},
  detection:{reasons:['INITIAL_ANSWER_AGED'],deltas:Object.fromEntries(['price_change_since_initial','tape_return','tape_buy_share','tape_trade_count',
   'buy_share_change_since_initial','spread_change_bps','ask_depth_change','bid_depth_change','imbalance_change','slippage_change_bps','elapsed_since_initial_ms'].map(k=>[k,null]))},currentRef:p.execution_ref});
 const f=await frozenReview(r,{snapshotAtMs:T+500,inputPayload:recheckPayload});
 assert.equal(await FD1.packetHash(f.packet),f.packet.snapshot_hash);assert.deepEqual(f.packet.current_ref,r.current_ref);
 assert.deepEqual(f.packet.initial.execution_ref,r.initial.execution_ref);
 assert.equal(f.market_input.market_sensor.age_ms,5500);
});
test('wrapper reports DONE validation failure without a second order cycle',async()=>{
 const x=setup(),db={};setTestCoordinator(db,x.c);let runs=0;
 const result=await runWithGptReview(db,async()=>{runs++;await complete(x);[...x.store.rows.values()][0].record.packet.symbol='TAMPERUSDT';
  return {ok:true,entry:{entered:false,reason:'GPT_REVIEW_PENDING'}};});
 assert.equal(runs,1);assert.equal(result.entry.reason,'GPT_SNAPSHOT_MISMATCH');assert.equal(result.gptFinalReview.resolved[0].storedDecision,'BUY');
});
for(const conflict of [false,true])test('async lifecycle uses fresh identity + NEW + features CAS; conflict='+conflict,async()=>{
 const s=signal(),row={...structuredClone(s),features:{...s.features,concurrentEvidence:'preserve',entryLifecycle:{reason:'GPT_REVIEW_PENDING'}}};let writes=0;
 const db={from(table){assert.equal(table,'v11_long_regime_signals');const filters=[];let update;
  const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},maybeSingle:async()=>({data:structuredClone(row)}),
   update(value){update=value;return q;},then(resolve){
    assert.deepEqual(filters.slice(0,2),[['id',s.id],['status','NEW']]);assert.equal(filters[2][0],'features');
    if(conflict)row.features.newer='another cycle';
    if(JSON.stringify(row.features)===filters[2][1]){row.features=update.features;writes++;}return Promise.resolve(resolve({error:null}));}};return q;}};
 await recordAsyncReviewOutcome(db,s,{reason:'GPT_SNAPSHOT_MISMATCH',storedDecision:'BUY'},()=>T+501);
 assert.equal(writes,conflict?0:1);assert.equal(row.features.concurrentEvidence,'preserve');
 assert.equal(row.features.entryLifecycle.reason,conflict?'GPT_REVIEW_PENDING':'GPT_SNAPSHOT_MISMATCH');
});
test('async lifecycle never updates an altered candidate identity',async()=>{
 const s=signal(),row={...s,features:{...s.features,rank:99,entryLifecycle:{reason:'GPT_REVIEW_PENDING'}}};
 const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:row}),update(){throw Error('MUST_NOT_WRITE');}};
 await recordAsyncReviewOutcome({from:()=>q},s,{reason:'GPT_SNAPSHOT_MISMATCH',storedDecision:'BUY'});
});
