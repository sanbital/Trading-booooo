import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ENGINE,assertAccountProof,assertActivation,assertResume} from '../ops/deterministic/release-policy.mjs';
import {classifyMarket} from '../supabase/functions/_shared/deterministic/market-state.mjs';
import {scenario} from '../test-support/deterministic/fixtures.mjs';
import {readReadiness} from '../ops/deterministic/readiness-read.mjs';
import {expectedGatewayCommit} from '../ops/deterministic/gateway-source.mjs';
import {serviceSourceRoot} from '../ops/deterministic/service-source.mjs';
import {serviceIdentity,assertLatencySource} from '../ops/deterministic/service-identity.mjs';
import os from 'node:os';import path from 'node:path';
const root=new URL('../',import.meta.url);
const readinessRequest={project:'etaajwpernzrcdrifdnw',slug:'v10-lane-signal-generator',token:'fixture-only',body:{mode:'diagnostic'},region:'ap-northeast-1'};
test('latency deployment pins executor separately and refuses unrelated service identities',()=>{
 const request=JSON.parse(fs.readFileSync(new URL('../ops/deterministic/release-request.json',import.meta.url))),r=request.executor_latency_repair;
 const baseline=serviceIdentity(request),after=serviceIdentity(request,r.source_commit);
 assert.equal(baseline.versions['v10-lane-executor'],192);assert.equal(after.versions['v10-lane-executor'],193);
 assert.equal(after.sources['v10-lane-signal-generator'],request.staged_source_commit);
 assert.throws(()=>serviceIdentity(request,'f'.repeat(40)),/UNREVIEWED_SERVICE_IDENTITY/);
 assert.throws(()=>serviceIdentity({...request,executor_latency_repair:{...r,expected_versions:{'v10-lane-executor':194}}},r.source_commit),/UNREVIEWED_SERVICE_IDENTITY/);
});
test('production entry boundary pins the deployed executor without replacing generator or accepting old versions',()=>{
 const request=JSON.parse(fs.readFileSync(new URL('../ops/deterministic/release-request.json',import.meta.url))),b=request.production_entry_boundary;
 const identity=serviceIdentity(request,b.source_commit);assert.equal(identity.versions['v10-lane-executor'],196);
 assert.equal(identity.sources['v10-lane-signal-generator'],request.staged_source_commit);
 assert.throws(()=>serviceIdentity({...request,production_entry_boundary:{...b,expected_versions:{'v10-lane-executor':193,'v10-lane-signal-generator':53}}},b.source_commit),/UNREVIEWED_SERVICE_IDENTITY/);
});
test('latency source proof refuses any strategy dependency change or different runner bytes',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'latency-source-test-')),file='supabase/functions/v10-lane-executor/index.ts';
 const git=args=>{const r=spawnSync('git',args,{cwd:temp,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
  git(['init']);git(['config','user.email','fixture@example.invalid']);git(['config','user.name','Fixture']);fs.mkdirSync(path.dirname(path.join(temp,file)),{recursive:true});fs.writeFileSync(path.join(temp,file),'old');git(['add','.']);git(['commit','-m','baseline']);const baseline=git(['rev-parse','HEAD']);
  fs.writeFileSync(path.join(temp,file),'repair');git(['add','.']);git(['commit','-m','repair']);const source=git(['rev-parse','HEAD']);
  const request={staged_source_commit:baseline,expected_versions:{'v10-lane-executor':190,'v10-lane-signal-generator':52},expected_staged_versions:{'v10-lane-executor':192,'v10-lane-signal-generator':53},executor_latency_repair:{baseline_source_commit:baseline,source_commit:source,baseline_versions:{'v10-lane-executor':192,'v10-lane-signal-generator':53},expected_versions:{'v10-lane-executor':193,'v10-lane-signal-generator':53}}};
  const root=serviceSourceRoot(source,{cwd:temp,temp});assert.doesNotThrow(()=>assertLatencySource(request,root,{cwd:temp}));
  fs.writeFileSync(path.join(temp,file),'unreviewed');assert.throws(()=>assertLatencySource(request,root,{cwd:temp}),/RUNNER_SOURCE_MISMATCH/);
  git(['reset','--hard',baseline]);fs.writeFileSync(path.join(temp,file),'repair');fs.writeFileSync(path.join(temp,'supabase/functions/strategy.mjs'),'changed');git(['add','.']);git(['commit','-m','unrelated strategy']);request.executor_latency_repair.source_commit=git(['rev-parse','HEAD']);
  assert.throws(()=>assertLatencySource(request,root,{cwd:temp}),/CHANGED_STRATEGY_OR_DEPENDENCY/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('latency repair requires its explicit reviewed marker before production access',()=>{
 const r=spawnSync(process.execPath,['ops/deterministic/release.mjs'],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_REPOSITORY:'sanbital/Trading-booooo',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),EXPECTED_COMMIT:'a'.repeat(40),CUTOVER_OPERATION:'repair-latency'}});
 assert.notEqual(r.status,0);assert.match(r.stderr,/LATENCY_REPAIR_EXACT_BASELINE_REQUIRED/);assert.doesNotMatch(r.stdout,/DEPLOYED|SOURCE_RECORDED/);
});
test('deployed source parity uses the pinned commit even when the runner has repaired service bytes',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'source-pin-test-'));
 const git=args=>{const r=spawnSync('git',args,{cwd:temp,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
  git(['init']);git(['config','user.email','fixture@example.invalid']);git(['config','user.name','Fixture']);
  fs.mkdirSync(path.join(temp,'supabase/functions/executor'),{recursive:true});const file=path.join(temp,'supabase/functions/executor/index.ts');
  fs.writeFileSync(file,'immutable deployed source');git(['add','.']);git(['commit','-m','deployed']);const pin=git(['rev-parse','HEAD']);
  fs.writeFileSync(file,'subsequent runner repair');
  const source=serviceSourceRoot(pin,{cwd:temp,temp});assert.equal(fs.readFileSync(path.join(source,'supabase/functions/executor/index.ts'),'utf8'),'immutable deployed source');
  assert.equal(fs.readFileSync(file,'utf8'),'subsequent runner repair');
  assert.throws(()=>serviceSourceRoot('main',{cwd:temp,temp}),/SERVICE_SOURCE_PIN_REQUIRED/);
  assert.throws(()=>serviceSourceRoot('f'.repeat(40),{cwd:temp,temp}),/SERVICE_SOURCE_COMMIT_UNAVAILABLE/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('source-only entry repair rejects branch and confirmation drift before any deploy',()=>{
 const env={PATH:process.env.PATH,GITHUB_REPOSITORY:'sanbital/Trading-booooo',GITHUB_REF:'refs/heads/main',
  GITHUB_SHA:'a'.repeat(40),EXPECTED_COMMIT:'a'.repeat(40),CUTOVER_OPERATION:'repair-entry',RUNNER_TEMP:os.tmpdir()};
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'entry-repair-test-'));
 try{
  for(const rel of ['ops/deterministic','ops/execution-infra'])fs.mkdirSync(path.join(temp,rel),{recursive:true});
  for(const file of ['ops/deterministic/release-request.json','ops/execution-infra/evidence-public.pem'])fs.copyFileSync(new URL(file,root),path.join(temp,file));
  const result=spawnSync(process.execPath,[new URL('../ops/deterministic/release.mjs',import.meta.url).pathname],{cwd:temp,encoding:'utf8',env});
  assert.notEqual(result.status,0);assert.match(result.stderr,/ENTRY_REPAIR_EXACT_BASELINE_REQUIRED/);
  assert.doesNotMatch(result.stdout,/ENTRY_REPAIR_EXECUTOR_DEPLOYED|ENTRY_REPAIR_SOURCE_RECORDED/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('independent gateway builds require complete exact reviewed pins without clock redeployment',()=>{
 const paris='a'.repeat(40),tokyo='b'.repeat(40),request={gateway_commit:'c'.repeat(40),gateway_commits:{'trading-booooo':paris,'trading-booooo-sanbital-gateway':tokyo}};
 assert.equal(expectedGatewayCommit(request,'trading-booooo'),paris);assert.equal(expectedGatewayCommit(request,'trading-booooo-sanbital-gateway'),tokyo);
 assert.equal(expectedGatewayCommit({gateway_commit:tokyo},'trading-booooo'),tokyo);
 for(const pins of [null,{}, {'trading-booooo':paris}, {...request.gateway_commits,'trading-booooo':'unknown'}, {...request.gateway_commits,unreviewed:paris}])assert.throws(()=>expectedGatewayCommit({...request,gateway_commits:pins},'trading-booooo'));
 assert.throws(()=>expectedGatewayCommit(request,'other'));assert.throws(()=>expectedGatewayCommit({gateway_commit:'unknown'},'trading-booooo'));
});
test('readiness observes the production region and preserves endpoint authentication',async()=>{
 let requests=0;
 const result=await readReadiness({...readinessRequest,fetchImpl:async(url,init)=>{
  requests++;assert.equal(url,'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator');
  assert.equal(init.headers['x-region'],'ap-northeast-1');assert.equal(init.headers['x-v10-lane-token'],'fixture-only');assert.deepEqual(JSON.parse(init.body),{mode:'diagnostic'});
  return new Response(JSON.stringify({ok:true,members:20}),{headers:{'x-sb-edge-region':'ap-northeast-1'}});
 }});
 assert.equal(result.members,20);assert.equal(requests,1);
});
test('readiness refuses missing or mismatched regions and never retries another location',async()=>{
 for(const [region,status,message] of [['us-east-2',200,'READINESS_REGION_CHANGED'],[null,200,'READINESS_REGION_CHANGED'],['ap-northeast-1',503,'READINESS_ENDPOINT_HTTP_503']]){
  let requests=0;const headers=region?{'x-sb-edge-region':region}:{};
  await assert.rejects(readReadiness({...readinessRequest,fetchImpl:async()=>{requests++;return new Response('{"ok":true}',{status,headers});}}),new RegExp(message));assert.equal(requests,1);
 }
});
test('readiness routing cannot dispatch a clock, order or unsupported regional request',async()=>{
 let requests=0;const fetchImpl=async()=>{requests++;throw Error('UNEXPECTED_REQUEST');};
 for(const change of [{body:{mode:'run'}},{body:{mode:'diagnostic',action:'BUY'}},{slug:'market-autotrader'},{region:'us-east-2'},{project:'other'}])await assert.rejects(readReadiness({...readinessRequest,...change,fetchImpl}),/READINESS_REQUEST_NOT_ALLOWED/);
 assert.equal(requests,0);
});
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
test('resume reads actual active generation and paused permission without reactivating authority',()=>{
 const v=valid();v.control.enabled=true;v.control.generation=2;v.leader20.active_strategy=ENGINE;v.readiness.entry_enabled=true;v.settings.pause_new_entries=true;
 const before=structuredClone(v);assert.doesNotThrow(()=>assertResume(v));assert.deepEqual(v,before);assert.throws(()=>assertActivation(v));
 for(const mutate of [x=>x.control.enabled=false,x=>x.control.generation=3,x=>x.settings.pause_new_entries=false,x=>x.readiness.entry_enabled=false,x=>x.control.source_commit='b'.repeat(40),x=>x.gpt.mode='ENFORCE',x=>x.batch.enabled=true,x=>x.unresolvedIncidents=1,x=>x.runtime.circuit_open=true,x=>x.scheduler.recovered_postmaster_at='old',x=>x.providerCalls=1,x=>x.diagnostic.results[0].technical=false,x=>x.diagnostic.results[0].capture_end_ms-=30000]){
  const invalid=structuredClone(v);mutate(invalid);assert.throws(()=>assertResume(invalid));
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
