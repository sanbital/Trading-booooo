import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ENGINE,assertAccountProof,assertActivation} from '../ops/deterministic/release-policy.mjs';
const root=new URL('../',import.meta.url);
function valid(){const at=new Date().toISOString(),symbols=Array.from({length:20},(_,i)=>'S'+i+'USDT'),postmaster=at;
 return {sourceCommit:'a'.repeat(40),control:{version:ENGINE,source_commit:'a'.repeat(40),enabled:false},leader20:{active_strategy:'PAUSED',watch_limit:20},batch:{enabled:false},gpt:{mode:'OFF'},runtime:{circuit_open:false,protection_health:'FLAT',last_cycle_completed_at:at},operator:{entry_enabled:true,legacy_entries_retired:true},settings:{pause_new_entries:false},scheduler:{enabled:true,recovery_complete:true,recovered_postmaster_at:postmaster,heartbeat_at:at,expires_at:new Date(Date.now()+15000).toISOString()},postmaster,
 jobs:[['v11-long-regime-executor','v10-lane-executor'],['leader20-observer-tick','v10-lane-signal-generator']].map(([job_key,endpoint])=>({job_key,enabled:true,period_ms:5000,target:{endpoint,body:{mode:'run'}},last_success:at})),
 captures:[...symbols,'BTCUSDT'].map(symbol=>({symbol,status:'AVAILABLE',buckets:24})),diagnostic:{version:ENGINE,members:20,results:symbols.map(symbol=>({symbol,technical:true,capture_end_ms:Date.now()}))},providerCalls:0};
}
test('activation refuses real production failure modes and duplicate authority',()=>{
 assert.doesNotThrow(()=>assertActivation(valid()));
 for(const mutate of [v=>v.runtime.circuit_open=true,v=>v.jobs[0].enabled=false,v=>v.jobs[0].target.body={},v=>v.captures.pop(),v=>v.captures[0].status='UNAVAILABLE',v=>v.diagnostic.results[0].technical=false,v=>v.providerCalls=1,v=>v.batch.enabled=true,v=>v.gpt.mode='ENFORCE',v=>v.scheduler.recovered_postmaster_at='old',v=>v.control.source_commit='b'.repeat(40),v=>v.jobs.push({...v.jobs[0],job_key:'duplicate'})]){
  const v=valid();mutate(v);assert.throws(()=>assertActivation(v));
 }
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
