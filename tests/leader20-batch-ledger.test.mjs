import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const migration=new URL('../supabase/migrations/20260928001607_leader20_batch_provider_ledger.sql',import.meta.url);
test('provider ledger and batch SQL execute in isolated PostgreSQL',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href), db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table gpt_final_entry_reviews(job_key text primary key,owner uuid default gen_random_uuid(),state text,record jsonb,purpose text,
 budget_day date,reserved_usd numeric,settled_usd numeric,model text,signal_id text,symbol text,created_at timestamptz default clock_timestamp());
 create table gpt_final_review_control(singleton boolean,mode text,enforce_approved boolean,approval_ref text,budget_effective_day date,daily_spend_offset numeric,daily_call_offset integer,max_calls_per_day integer);
 insert into gpt_final_review_control values(true,'ENFORCE',true,'test',current_date,0,0,100);
 create table gpt_final_review_daily_budget(utc_day date,reserved_usd numeric,calls integer);
 create function ai_monthly_spend_used(date default current_date) returns numeric language sql as 'select 40.13311308::numeric';
 create function leader20_entry_budget_limits() returns jsonb language sql as 'select ''{"protected_usd":0.5}''::jsonb';
 create function gpt_final_review_claim(text,jsonb,numeric,integer,numeric) returns jsonb language sql as 'select ''{"legacy":true}''::jsonb';
 create table leader20_control(singleton boolean,epoch_id uuid,generation bigint,observation_enabled boolean,active_strategy text);
 create table leader20_members(epoch_id uuid,symbol text,rank int);
 create table trading_account_snapshots(exchange text,captured_at timestamptz,positions_complete boolean,available_quote numeric,positions jsonb);
 create table v11_long_regime_positions(symbol text,state text,remaining_quantity numeric,metadata jsonb);
 create table v11_long_regime_orders(state text,response_payload jsonb);
 create table v11_long_regime_signals(id uuid primary key,features jsonb);
 create table leader20_review_events(id uuid default gen_random_uuid(),epoch_id uuid,symbol text,generation bigint,requested_at timestamptz,
 snapshot_end_ms bigint,snapshot_hash text,reason text,priority int,state text default 'REQUESTED',result jsonb);
 create function leader20_schedule() returns jsonb language sql as 'select ''{"legacy30m":true}''::jsonb';
 create function leader20_entry_authority(uuid) returns jsonb language sql as 'select ''{"allowed":true}''::jsonb';
 create table edge_internal_tokens(name text,token text);
 insert into edge_internal_tokens values('v10-lane-signal-generator','fixture-token');
 create schema net;
 create table net.requests(id bigserial primary key,body jsonb);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$
 declare n bigint;begin insert into net.requests(body) values(body) returning id into n;return n;end $$;
 create function leader20_materialize_event(uuid,jsonb) returns jsonb language sql as 'select ''{"created":false}''::jsonb';`);
 await db.exec(await readFile(migration,'utf8'));
 const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const rpc=async(n,a=[]) => (await q(`select public.${n}(${a.map((_,i)=>'$'+(i+1)).join(',')}) r`,a))[0].r;
 const reserve=(k,provider='deepseek',purpose='ENTRY',amount=.01)=>rpc('ai_call_reserve',[k,provider,provider==='deepseek'?'deepseek-flash':'gpt-5.4-mini-2026-03-17',purpose,k,k,amount]);
 await t.test('installation is disabled and legacy cadence is untouched',async()=>{
  assert.equal((await reserve('off')).reason,'PROVIDER_LEDGER_DISABLED');
  assert.equal((await rpc('leader20_schedule')).legacy30m,true);
  assert.equal((await q("select count(*)::int n from pg_class where relname in ('ai_provider_limits','ai_call_ledger','leader20_batches','leader20_batch_control') and relrowsecurity"))[0].n,4);
  const grant=(await q("select has_function_privilege('anon','public.ai_call_reserve(text,text,text,text,text,text,numeric)','execute') allowed"))[0];assert.equal(grant.allowed,false);
 });
 await t.test('history is neither erased nor counted twice on provider separation',async()=>{
  await q("insert into gpt_final_entry_reviews(job_key,model,budget_day,settled_usd,reserved_usd,record) values('historic','deepseek-flash',current_date,.123,.25,'{}')");
  const ds=Number(await rpc('ai_provider_month_used',['deepseek'])),gpt=Number(await rpc('ai_provider_month_used',['openai']));
  assert.equal(ds,.123);assert.ok(Math.abs(ds+gpt-40.13311308)<1e-10);
 });
 await db.exec('update ai_provider_limits set enabled=true');
 await t.test('one reservation; owner CAS; exactly once settlement; cache usage retained',async()=>{
  const c=await reserve('same');assert.equal(c.created,true);assert.equal((await reserve('same')).created,false);
  await assert.rejects(rpc('ai_call_transition',['same',crypto.randomUUID(),'DISPATCHED']),/API_CALL_OWNER/);
  await rpc('ai_call_transition',['same',c.row.owner,'DISPATCHED']);
  await rpc('ai_call_transition',['same',c.row.owner,'SETTLED',{input_tokens:20000,output_tokens:2000,cached_input_tokens:0},'r',1234]);
  assert.equal((await rpc('ai_call_transition',['same',c.row.owner,'SETTLED'])).duplicate,true);
  assert.equal(Number((await q("select actual_usd from ai_call_ledger where call_key='same'"))[0].actual_usd),.0084);
  await assert.rejects(rpc('ai_call_transition',['same',c.row.owner,'CANCELLED']),/API_CALL_TRANSITION/);
 });
 await t.test('pre-dispatch cancellation releases; ambiguous dispatch retains until usage arrives',async()=>{
  const a=await reserve('cancel'),b=await reserve('timeout');
  await rpc('ai_call_transition',['cancel',a.row.owner,'CANCELLED']);
  await rpc('ai_call_transition',['timeout',b.row.owner,'DISPATCHED']);await rpc('ai_call_transition',['timeout',b.row.owner,'UNKNOWN']);
  await assert.rejects(rpc('ai_call_transition',['timeout',b.row.owner,'CANCELLED']),/API_CALL_TRANSITION/);
  assert.equal(Number((await q("select coalesce(actual_usd,reserved_usd) v from ai_call_ledger where call_key='timeout'"))[0].v),.01);
  await rpc('ai_call_transition',['timeout',b.row.owner,'SETTLED',{input_tokens:1000,output_tokens:100,cached_input_tokens:0}]);
 });
 await t.test('entry cap reports budget exhaustion while protected HOLD has room',async()=>{
  await q("update ai_provider_limits set daily_usd=.6 where provider='deepseek'");
  assert.equal((await reserve('entry-cap','deepseek','ENTRY',.15)).reason,'API_BUDGET_EXHAUSTED');
  assert.equal((await reserve('protect','deepseek','HOLD',.15)).created,true);
  await q("update ai_provider_limits set monthly_usd=.13 where provider='deepseek'");
  assert.equal((await reserve('month','deepseek','HOLD',.1)).reason,'API_BUDGET_EXHAUSTED');
  await q("update ai_provider_limits set monthly_usd=100,daily_usd=100.0/31 where provider='deepseek'");
 });
 await t.test('null/old/incomplete account evidence cannot create slots; pending orders reserve all entry',async()=>{
  assert.equal((await rpc('leader20_batch_capacity')).available,0);
  await q("insert into trading_account_snapshots values('binance_futures',clock_timestamp(),true,350,'[]')");
  assert.equal((await rpc('leader20_batch_capacity')).available,2);
  await q("insert into v11_long_regime_orders values('DISPATCHED','{}')");
  assert.equal((await rpc('leader20_batch_capacity')).available,0);
  await q("update v11_long_regime_orders set response_payload='{"+'"v18ExposureFinal":true'+"}'");
  assert.equal((await rpc('leader20_batch_capacity')).available,2);
 });
 const epoch=crypto.randomUUID();await q("insert into leader20_control values(true,$1,3,true,'LEADER20_DYNAMIC_1')",[epoch]);
 for(let i=0;i<10;i++)await q('insert into leader20_members values($1,$2,$3)',[epoch,'S'+i,i+1]);
 const packet=(v='one')=>({epoch_id:epoch,generation:3,as_of_ms:Date.now(),batch_hash:v,
  evidence:Array.from({length:10},(_,i)=>['S'+i,100,1,.1]),symbols:Array.from({length:10},(_,i)=>({id:'S'+i,state:'READY',data_version:v+i,last_ms:Date.now()-1000}))});
 await t.test('5m batch bypasses global 30m gate; duplicate and in-flight calls coalesce',async()=>{
  await assert.rejects(q('update leader20_batch_control set enabled=true'),/batch_release_requires_evidence/);
  await q(`update leader20_batch_control set enabled=true,release_receipt='{"budget_verified":true,"recall_verified":true,"concurrency_verified":true,"protection_verified":true}'`);
  assert.equal((await rpc('leader20_schedule')).reason,'BATCH_SCHEDULER_OWNS_ENTRY');
  const p=packet(),a=await rpc('leader20_batch_claim',[p,'e',false]);assert.equal(a.created,true);
  await q("update leader20_batch_control set last_requested_at=clock_timestamp()-interval '5 minutes'");
  assert.equal((await rpc('leader20_batch_claim',[packet('two'),'e2',false])).reason,'BATCH_IN_FLIGHT');
  await rpc('leader20_batch_start',[a.row.id,a.row.owner]);
  const results=p.symbols.map(s=>({id:s.id,version:s.data_version,last_ms:s.last_ms,decision:'PASS',valid:true}));
  results.pop();results.push(results[0]);
  assert.equal((await rpc('leader20_batch_finish',[a.row.id,a.row.owner,{results}])).events,8);
  assert.equal((await rpc('leader20_batch_finish',[a.row.id,a.row.owner,{results}])).duplicate,true);
  assert.equal((await rpc('leader20_batch_claim',[p,'e',false])).reason,'DUPLICATE_CAPTURE');
  assert.equal((await rpc('leader20_batch_claim',[packet('two'),'e2',false])).created,true);
 });
 await t.test('1→0 blocks late results; 0→1 requests fresh data without 5m wait',async()=>{
  await q("update leader20_batches set state='DONE'");
  await q("update trading_account_snapshots set available_quote=0,captured_at=clock_timestamp()");
  await rpc('leader20_batch_note_full');
  assert.equal((await rpc('leader20_batch_claim',[packet('full'),'e3',false])).reason,'NO_ENTRY_CAPACITY');
  await q("update trading_account_snapshots set available_quote=160,captured_at=clock_timestamp()");
  assert.equal((await q('select count(*)::int n from net.requests'))[0].n,1);
  const a=await rpc('leader20_batch_claim',[packet('freed'),'e4',false]);assert.equal(a.created,true);assert.equal(a.row.reason,'SLOT_RELEASED');
  await rpc('leader20_batch_start',[a.row.id,a.row.owner]);
  await q("insert into v11_long_regime_orders values('PLANNED','{}')");
  assert.equal((await rpc('leader20_batch_finish',[a.row.id,a.row.owner,{results:[]}])).reason,'CAPACITY_OR_VERSION_CHANGED');
 });
 await t.test('new parent mode requires metered transport, never debits the legacy parent reservation',async()=>{
  await assert.rejects(rpc('gpt_final_review_claim',['unmetered',{api_approval_ref:'test'},3,100,.25]),/API_UNMETERED_CALLER/);
  const c=await rpc('gpt_final_review_claim',['metered',{api_approval_ref:'test',transport_version:'AI_PROVIDER_LEDGER_1',purpose:'PRODUCTION'},3,100,.25]);
  assert.equal(c.created,true);assert.equal(c.row.provider_ledger,true);assert.equal(c.row.reserved_usd,null);
  assert.equal((await rpc('gpt_final_review_claim',['metered',{},3,100,.25])).created,false);
 });
 await t.test('stale approval cannot be inherited across a new batch',async()=>{
  const signal=crypto.randomUUID();await q(`insert into v11_long_regime_signals values($1,'{"leader20":{"batch_id":"invalid","batch_advice":{"decision":"PASS"}}}')`,[signal]);
  assert.equal((await rpc('leader20_entry_authority',[signal])).reason,'BATCH_APPROVAL_SUPERSEDED_OR_EXPIRED');
 });
 await t.test('forecasts retain unresolved costs and update from the measured rate',async()=>{
  const p=(await rpc('ai_provider_budget_status')).providers;assert.equal(p.length,2);
  for(const r of p){assert.ok(Number(r.month_used_usd)>=0);assert.ok(Math.abs(Number(r.run_rate_31d_usd)-31*Number(r.last24h_usd))<1e-10);}
 });
});
