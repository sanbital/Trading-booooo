import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ENGINE,assertAccountProof,assertActivation} from '../ops/deterministic/release-policy.mjs';
import {classifyMarket} from '../supabase/functions/_shared/deterministic/market-state.mjs';
import {scenario} from '../test-support/deterministic/fixtures.mjs';
const root=new URL('../',import.meta.url);
function sensor(asOf){
 const end=asOf-5000,points=Array.from({length:24},(_,i)=>{const t=end-(23-i)*5000,candle=Math.floor((t-1000)/60000)*60000;
  return {bucket_complete:true,book_complete:true,trade_sequence_complete:true,flow_causal:true,btc_candle_complete:true,
   bucket_ms:t,start_ms:t-5000,end_ms:t,received_at_ms:t+500,exchange_event_ms:t-200,book_received_at_ms:t-100,
   btc_candle_end_ms:candle,btc_candle_exchange_ms:candle+10,btc_candle_received_ms:candle+30,trade_count:1,flow_event_ms:t-150,flow_received_at_ms:t-100,
   mid:100+i*.01,start_mid:100+(i-1)*.01,best_bid:99.99,best_ask:100.01,spread_bps:2,taker_buy_quote_5s:200,taker_sell_quote_5s:100,btc_return_1m:.001,
   observed_bid_depth_usdt:10000,observed_ask_depth_usdt:10000,depth_bid_coverage_bps:8,depth_ask_coverage_bps:9,depth_bid_boundary:99.92,depth_ask_boundary:100.09,depth_coverage_complete:false};});
 return {contract:'MARKET_SENSOR_CONTEXT_V1',version:'MARKET_SENSOR_CONTEXT_V1',symbol:'BTCUSDT',role:'MARKET_SENSOR',status:'AVAILABLE',buckets:24,start_ms:points[0].start_ms,end_ms:end,ingested_at_ms:end+500,as_of_ms:asOf,market_sensor_trajectory:points};
}
function valid(){const now=Date.now(),at=new Date(now).toISOString(),symbols=Array.from({length:20},(_,i)=>'S'+i+'USDT'),postmaster=at;
 return {sourceCommit:'a'.repeat(40),control:{version:ENGINE,source_commit:'a'.repeat(40),enabled:false},leader20:{active_strategy:'PAUSED',watch_limit:20},batch:{enabled:false},gpt:{mode:'OFF'},runtime:{circuit_open:false,protection_health:'FLAT',last_cycle_completed_at:at},operator:{entry_enabled:true,legacy_entries_retired:true},settings:{pause_new_entries:false},scheduler:{enabled:true,recovery_complete:true,recovered_postmaster_at:postmaster,heartbeat_at:at,expires_at:new Date(Date.now()+15000).toISOString()},postmaster,
 jobs:[['v11-long-regime-executor','v10-lane-executor'],['leader20-observer-tick','v10-lane-signal-generator']].map(([job_key,endpoint])=>({job_key,enabled:true,period_ms:5000,target:{endpoint,body:{mode:'run'}},last_success:at})),
 captures:symbols.map(symbol=>({symbol,status:'AVAILABLE',buckets:24})),marketSensorAsOf:now,marketSensor:sensor(now),unresolvedIncidents:0,diagnostic:{version:ENGINE,members:20,observed_at:at,results:symbols.map(symbol=>({symbol,technical:true,capture_end_ms:now,decision:'WAIT',setup:'PASS',reasons:['TRIGGER_NOT_READY'],timing:{decision:now}}))},readiness:{authority:ENGINE,entry_enabled:false,native_stop_enabled:true,hard_stop_pct:.025,maxSlots:10,sizingContract:{targetMarginUsdt:150,leverage:3},position_mode:{supported:true,mode:'ONE_WAY'}},providerCalls:0};
}
test('activation refuses real production failure modes and duplicate authority',()=>{
 assert.doesNotThrow(()=>assertActivation(valid()));
 for(const mutate of [v=>v.runtime.circuit_open=true,v=>v.unresolvedIncidents=1,v=>v.jobs[0].enabled=false,v=>v.jobs[0].target.body={},v=>v.captures.pop(),v=>v.captures[0].status='UNAVAILABLE',v=>v.diagnostic.results[0].technical=false,v=>v.providerCalls=1,v=>v.batch.enabled=true,v=>v.gpt.mode='ENFORCE',v=>v.readiness.native_stop_enabled=false,v=>v.scheduler.recovered_postmaster_at='old',v=>v.control.source_commit='b'.repeat(40),v=>v.jobs.push({...v.jobs[0],job_key:'duplicate'})]){
  const v=valid();mutate(v);assert.throws(()=>assertActivation(v));
 }
});
test('BTC context accepts finite observed depth, rejects causal gaps, and never grants BTC trade eligibility',()=>{
 assert.doesNotThrow(()=>assertActivation(valid()));
 for(const mutate of [v=>v.marketSensor=null,v=>v.marketSensor.market_sensor_trajectory.pop(),v=>v.marketSensor.market_sensor_trajectory[3].book_complete=false,
  v=>v.marketSensor.market_sensor_trajectory[3].flow_event_ms=v.marketSensorAsOf+1,v=>v.marketSensor.market_sensor_trajectory[3].start_ms+=1,
  v=>v.marketSensor.market_sensor_trajectory[3].btc_candle_received_ms=v.marketSensorAsOf+1,v=>v.marketSensorAsOf-=30000]){
  const v=valid();mutate(v);assert.throws(()=>assertActivation(v),/BTC_MARKET_SENSOR_NOT_READY/);
 }
 const v=valid();v.diagnostic.results[0].symbol='BTCUSDT';v.captures[0]={symbol:'BTCUSDT',status:'UNAVAILABLE',reason:'INVALID_OR_NONCAUSAL_BUCKET'};
 assert.throws(()=>assertActivation(v),/INCOMPLETE_SYMBOL_NOT_FAIL_CLOSED/);
});
test('incomplete symbols must be causally REJECTED while healthy symbol authority remains verifiable',()=>{
 const v=valid(),r=v.diagnostic.results[0],input=scenario({at:Date.now()});
 const rejected=classifyMarket({...input,capture:{status:'UNAVAILABLE',reason:'INCOMPLETE_TRAJECTORY'}});
 v.captures[0]={symbol:r.symbol,status:'UNAVAILABLE',reason:'INCOMPLETE_TRAJECTORY'};
 Object.assign(r,{capture_end_ms:rejected.capture_end_ms,decision:rejected.decision,setup:rejected.setup,reasons:rejected.reasons});
 assert.doesNotThrow(()=>assertActivation(v));
 for(const mutate of [x=>x.diagnostic.results[0].decision='BUY',x=>x.diagnostic.results[0].decision='WAIT',x=>x.diagnostic.results[0].setup='PASS',x=>x.diagnostic.results[0].reasons=['STRUCTURE'],x=>x.captures[0].reason=null]){
  const copy=structuredClone(v);mutate(copy);assert.throws(()=>assertActivation(copy));
 }
 const blind=structuredClone(v);for(const c of blind.captures){c.status='UNAVAILABLE';c.reason='INCOMPLETE_TRAJECTORY';}
 assert.throws(()=>assertActivation(blind),/TOP20_CONTINUOUS_CAPTURE_NOT_READY/);
 const stale=valid();stale.diagnostic.results[0].capture_end_ms-=30000;assert.throws(()=>assertActivation(stale),/INCOMPLETE_SYMBOL_NOT_FAIL_CLOSED/);
});
test('signed proof gate cannot ignore unknown orders, mismatched fills, balance or a changed holding',()=>{
 const holdings={failures:[],exchange_positions:0,db_positions:0,ordinary_orders:0,protective_orders:0},trades={failures:[]};
 assert.doesNotThrow(()=>assertAccountProof(holdings,trades,true));
 assert.throws(()=>assertAccountProof({...holdings,failures:['UNRESOLVED_DB_ORDER']},trades,true));
 assert.throws(()=>assertAccountProof(holdings,{failures:['EXCHANGE_DB_FILL_OR_FEE_MISMATCH']},true));
 assert.throws(()=>assertAccountProof(holdings,trades,false));
 assert.throws(()=>assertAccountProof({...holdings,exchange_positions:1},trades,true));
});
test('SQL stage and bind preserve financial rows and maintenance while disabling legacy admission',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE??new URL('../test-support/deterministic/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url).href),db=new PGlite();
 try{
  await db.exec(`create table trading_settings(id int,pause_new_entries boolean,mode text,emergency_liquidation boolean,manual_intervention_required boolean,margin int,leverage int);
  insert into trading_settings values(1,true,'LIVE_LIMITED',false,false,150,3);
  create table leader20_control(singleton boolean,active_strategy text,watch_limit int,generation int,updated_at timestamptz,clock_capture_enabled boolean);insert into leader20_control values(true,'LEADER20_DYNAMIC_1',10,4,now(),true);
  create table leader20_batch_control(singleton boolean,enabled boolean,generation int);insert into leader20_batch_control values(true,true,386);
  create table gpt_final_review_control(singleton boolean,mode text,enforce_approved boolean,updated_at timestamptz,budget int);insert into gpt_final_review_control values(true,'ENFORCE',true,now(),500);
  create table trading_scheduler_control(scheduler_key text,enabled boolean);insert into trading_scheduler_control values('trading-production',true);
  create table trading_scheduler_jobs(scheduler_key text,job_key text,target jsonb,enabled boolean,period_ms int,offset_ms int,retry_at timestamptz,failure_count int);
  insert into trading_scheduler_jobs values('trading-production','v11-long-regime-executor','{"endpoint":"v10-lane-executor","body":{}}',false,30000,0,null,1),('trading-production','leader20-observer-tick','{"endpoint":"v10-lane-signal-generator","body":{"mode":"leader20-observe"}}',true,10000,0,null,0),('trading-production','entry-reservation-maintenance','{"rpc":"leader20_entry_reservation_sweep"}',true,60000,0,null,0),('trading-production','gpt-review-expire','{"rpc":"gpt_final_review_expire"}',true,60000,0,null,0);
  create table economic_ledger(id int,quantity numeric,fee numeric);insert into economic_ledger values(1,4.5,.03);`);
  const ledger=await db.query('select * from economic_ledger');
  await db.exec(fs.readFileSync(new URL('ops/deterministic/stage-paused.sql',root),'utf8'));
  assert.equal((await db.query('select enabled from leader20_batch_control')).rows[0].enabled,false);
  assert.equal((await db.query('select mode,budget from gpt_final_review_control')).rows[0].budget,500);
  assert.equal((await db.query("select enabled from trading_scheduler_jobs where job_key='entry-reservation-maintenance'")).rows[0].enabled,true);
  await db.exec('create table deterministic_control(singleton boolean,enabled boolean);insert into deterministic_control values(true,false);');
  await db.exec(fs.readFileSync(new URL('ops/deterministic/bind-paused.sql',root),'utf8'));
  const targets=(await db.query("select period_ms,target from trading_scheduler_jobs where target->>'endpoint' is not null")).rows;
  assert.equal(targets.length,2);assert.ok(targets.every(j=>j.period_ms===5000&&j.target.body.mode==='run'));
  assert.equal((await db.query('select enabled from deterministic_control')).rows[0].enabled,false);
  assert.deepEqual((await db.query('select margin,leverage,pause_new_entries from trading_settings')).rows[0],{margin:150,leverage:3,pause_new_entries:false});
  assert.deepEqual(await db.query('select * from economic_ledger'),ledger);
 }finally{await db.close();}
});
test('release entrypoint rejects branch or source drift before credentials or production are accessed',()=>{
 const r=spawnSync(process.execPath,['ops/deterministic/release.mjs'],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_REPOSITORY:'sanbital/Trading-booooo',GITHUB_REF:'refs/heads/codex/deterministic-dynamic-state',GITHUB_SHA:'a'.repeat(40),EXPECTED_COMMIT:'a'.repeat(40),CUTOVER_OPERATION:'stage'}});
 assert.notEqual(r.status,0);assert.match(r.stderr,/EXACT_MAIN_RELEASE_REQUIRED/);
});
