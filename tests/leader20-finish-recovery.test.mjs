import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
import {finishEntryBatch} from '../supabase/functions/_shared/leader20/batch-runtime.mjs';
import {validateBatchResponse} from '../supabase/functions/_shared/leader20/batch.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const fixture=JSON.parse(await read('test-support/production-batch-finish-20260928.json'));
const result=structuredClone(fixture.batch.result);delete result.blocked_reason; // server terminal diagnostic, not provider output
test('production batch finish replay, owner recovery and unchanged safety in PostgreSQL',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const rpc=async(n,a=[]) => (await q(`select public.${n}(${a.map((_,i)=>'$'+(i+1)).join(',')}) r`,a))[0].r;
 await db.exec(await read('test-support/leader20-ledger-schema.sql'));
 await db.exec(await read('supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql'));
 await db.exec(`
 alter table leader20_control add column watch_limit integer default 10,add column archive_state text default 'READY',
  add column cold_archive_state text default 'READY',add column archive_max_bytes bigint default 10000,
  add column archive_last_verified_at timestamptz default now(),add column last_scheduler_at timestamptz;
 create table leader20_epochs(id uuid primary key,next_refresh_at timestamptz);
 create table leader20_campaigns(symbol text primary key,epoch_id uuid,state text default 'WATCHING',reason text,
  bucket_count integer,last_bucket_at timestamptz,last_decision text,last_requested_at timestamptz,
  next_review_conditions jsonb,updated_at timestamptz);
 alter table leader20_review_events add column expires_at timestamptz;
 create unique index campaign_single_flight on leader20_review_events(symbol) where state in ('REQUESTED','REVIEWING');
 alter table v11_long_regime_positions add column closed_at timestamptz;
 alter table v11_long_regime_signals alter column id set default gen_random_uuid(),add column revision text,
  add column lane text,add column symbol text,add column side text,add column signal_bar_at timestamptz,
  add column entry_bar_at timestamptz,add column status text,add column reject_reason text,add column updated_at timestamptz;
 alter table gpt_final_review_control add column daily_cap_usd numeric default 3 constraint gpt_final_review_control_daily_cap_usd_check check(daily_cap_usd<=3),
  add column monthly_cap_usd numeric default 95 constraint gpt_final_review_control_monthly_cap_usd_check check(monthly_cap_usd<=95),
  add constraint gpt_final_review_control_max_calls_per_day_check check(max_calls_per_day<=100);
 create table fixture_capture(symbol text,payload jsonb);
 create function doa_context_for_role_v1(text,timestamptz,text,uuid) returns jsonb language sql as 'select payload from public.fixture_capture where symbol=$1';
 `);
 await db.exec(await read('test-support/leader20-production-baseline.sql'));
 await db.exec(await read('supabase/migrations/20260928032022_leader20_campaign_execution_lifecycle.sql'));
 await db.exec(await read('supabase/migrations/20260928034100_leader20_transient_capacity_pause.sql'));
 await db.exec(`alter table gpt_final_entry_reviews add column completed_at timestamptz,add column prompt_hash text,
  add column schema_hash text,add column source_commit text,add column candidate_id text,add column snapshot_hash text,
  add column decision text,add column valid boolean,add column error text,add column attempted boolean,
  add column request_id text,add column input_tokens integer,add column cached_input_tokens integer,add column output_tokens integer,
  add column api_cost_usd numeric,add column cost_basis text,add column latency_ms integer,add column api_started_at timestamptz,
  add column api_completed_at timestamptz,add column snapshot_at timestamptz;
  alter table gpt_final_review_daily_budget add column settled_usd numeric default 0;`);
 await db.exec(await read('supabase/migrations/20260928034900_leader20_review_completion_concurrency.sql'));
 await db.exec(await read('supabase/migrations/20260928035300_leader20_owned_provider_reservation.sql'));
 await db.exec(`create trigger campaign_review after update of state on gpt_final_entry_reviews
  for each row when(new.state='DONE' and old.state is distinct from new.state) execute function leader20_record_review();
 update leader20_batch_control set enabled=true,release_receipt='{"budget_verified":true,"recall_verified":true,"concurrency_verified":true,"protection_verified":true}';
 update ai_provider_limits set enabled=true,daily_usd=case when provider='openai' then 50 else 100 end,
  monthly_usd=100;
 update gpt_final_review_control set daily_cap_usd=50,monthly_cap_usd=100,max_calls_per_day=10000;`);
 const epoch=crypto.randomUUID();
 await q("insert into leader20_control(singleton,epoch_id,generation,observation_enabled,active_strategy) values(true,$1,3,true,'LEADER20_DYNAMIC_1')",[epoch]);
 await q("insert into leader20_epochs values($1,clock_timestamp()+interval '6 hours')",[epoch]);
 await q("insert into trading_account_snapshots values('binance_futures',clock_timestamp(),true,500,'[]')");
 const symbols=fixture.batch.packet.symbols.map(s=>s.id);
 for(const [i,s] of symbols.entries()){
  await q('insert into leader20_members values($1,$2,$3)',[epoch,s,i+1]);
  await q('insert into leader20_campaigns(symbol,epoch_id) values($1,$2)',[s,epoch]);
  await q('insert into fixture_capture values($1,$2)',[s,rawCapture(Date.now())]);
 }

 await db.exec('alter table trading_account_snapshots add column id bigserial;');
 await db.exec(fixture.capacity_sql);await db.exec(fixture.before_finish_sql);
 const reset=async()=>{
  await db.exec("delete from leader20_review_events;delete from leader20_batches;delete from v11_long_regime_orders;delete from v11_long_regime_positions;");
  await q("update trading_account_snapshots set captured_at=clock_timestamp(),positions_complete=true,available_quote=500,positions='[]'");
  await q("update leader20_control set generation=3,epoch_id=$1",[epoch]);
  await q("update leader20_batch_control set enabled=true");
 };
 const make=async()=>{
  const p={...fixture.batch.packet,epoch_id:epoch};
  return (await q("insert into leader20_batches(epoch_id,generation,data_version,state,reason,packet) values($1,3,$2,'DISPATCHED','TEN_MINUTE',$3) returning *",[epoch,crypto.randomUUID(),p]))[0];
 };
 const finish=(b,r=result)=>rpc('leader20_batch_finish',[b.id,b.owner,r]);
 const row=async b=>(await q('select * from leader20_batches where id=$1',[b.id]))[0];
 await t.test('old production function discards eight valid rows during the account90s publication gap',async()=>{
  await reset();const b=await make();
  assert.equal(validateBatchResponse(result.raw_content,fixture.batch.packet).results.filter(r=>r.valid).length,8);
  await q("update trading_account_snapshots set captured_at=clock_timestamp()-interval '92 seconds'");
  assert.equal((await finish(b)).reason,'CAPACITY_OR_VERSION_CHANGED');assert.equal((await row(b)).state,'SUPERSEDED');
 });
 await db.exec(await read('supabase/migrations/20260928092014_leader20_batch_finish_account_recovery.sql'));
 await t.test('same original result and expiry survive stale account; recovery only finishes and queues the eight READY IDs',async()=>{
  await reset();const b=await make(),ledger=await q('select * from ai_call_ledger');
  await q("update trading_account_snapshots set captured_at=clock_timestamp()-interval '92 seconds'");
  const pending=await finish(b);assert.equal(pending.pending,true);assert.equal(pending.reason,'ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE');
  const saved=await row(b);assert.equal(saved.state,'DISPATCHED');assert.deepEqual(saved.expires_at,b.expires_at);
  const {finish_gate,...body}=saved.result;assert.deepEqual(body,result);assert.equal(finish_gate.last.capacity.available,0);
  assert.equal((await q('select count(*)::int n from leader20_review_events'))[0].n,0);
  let calls=0,sleeps=0;
  const client={rpc:async(_n,args)=>{calls++;return {data:await rpc('leader20_batch_finish',[args.p_id,args.p_owner,args.p_result])};}};
  const done=await finishEntryBatch(client,b,result,{sleep:async ms=>{assert.equal(ms,1000);sleeps++;await q("update trading_account_snapshots set captured_at=clock_timestamp()");}});
  assert.equal(done.events,8);assert.equal(calls,2);assert.equal(sleeps,1);
  const final=await row(b);assert.equal(final.state,'DONE');assert.deepEqual(final.expires_at,b.expires_at);
  assert.deepEqual(final.result.results,result.results);assert.equal(final.result.finish_gate.checks,3);
  assert.equal(final.result.finish_gate.first_blocked.reason,'ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE');
  assert.equal(final.result.finish_gate.last.capacity.available,3);
  const events=await q('select symbol,result from leader20_review_events');
  assert.deepEqual(events.map(e=>e.symbol).sort(),fixture.batch.packet.symbols.filter(s=>s.state==='READY').map(s=>s.id).sort());
  assert.ok(events.every(e=>e.result.batch_advice.id===e.symbol));
  assert.deepEqual(await q('select * from ai_call_ledger'),ledger);
  assert.equal((await q('select count(*)::int n from v11_long_regime_orders'))[0].n,0);
  assert.equal((await finish(b)).duplicate,true);
 });
 await t.test('wrong owner and altered stored result cannot complete, concurrent owners cannot duplicate events',async()=>{
  await reset();const b=await make();await q("update trading_account_snapshots set positions_complete=false");await finish(b);
  await assert.rejects(rpc('leader20_batch_finish',[b.id,crypto.randomUUID(),result]),/BATCH_FINISH_OWNER/);
  await assert.rejects(finish(b,{...result,raw_content:'changed'}),/BATCH_FINISH_RESULT_MISMATCH/);
  await q("update trading_account_snapshots set positions_complete=true,captured_at=clock_timestamp()");
  const done=await Promise.all([finish(b),finish(b)]);assert.equal(done.reduce((n,r)=>n+r.events,0),8);
  assert.equal((await q('select count(*)::int n from leader20_review_events'))[0].n,8);
 });
 for(const [name,mutation,reason] of [
  ['expired',"update leader20_batches set expires_at=clock_timestamp()-interval '1 second'",'BATCH_EXPIRED'],
  ['version changed',"update leader20_control set generation=4",'BATCH_VERSION_CHANGED'],
  ['disabled',"update leader20_batch_control set enabled=false",'BATCH_DISABLED'],
  ['full capital',"update trading_account_snapshots set available_quote=0",'NO_ENTRY_CAPACITY'],
  ['pending order',"insert into v11_long_regime_orders(state,response_payload) values('DISPATCHED','{}')",'PENDING_CAPITAL_RESERVED'],
  ['unreadable account',"update trading_account_snapshots set available_quote=null",'ACCOUNT_SNAPSHOT_UNREADABLE']]){
  await t.test(name+' remains terminal and records the exact reason',async()=>{
   await reset();const b=await make();await q(mutation);const done=await finish(b);
   assert.equal(done.pending,false);assert.equal(done.reason,reason);assert.equal((await row(b)).result.finish_gate.last.reason,reason);
   assert.equal((await q('select count(*)::int n from leader20_review_events'))[0].n,0);
  });
 }
 await t.test('new batch supersedes pending result; an expired stored batch never revives',async()=>{
  await reset();const b=await make();await q("update trading_account_snapshots set positions_complete=false");await finish(b);
  await make();assert.equal((await finish(b)).reason,'NEWER_BATCH_EXISTS');
  await q("update trading_account_snapshots set positions_complete=true,captured_at=clock_timestamp()");
  assert.equal((await finish(b)).duplicate,true);
 });
 await t.test('persistent account failure stops at30seconds without extending90second expiry or spending',async()=>{
  await reset();const b=await make();await q("update trading_account_snapshots set positions_complete=false");await finish(b);
  await q("update leader20_batches set result=jsonb_set(result,'{finish_gate,first_blocked,checked_at}',to_jsonb(clock_timestamp()-interval '31 seconds')) where id=$1",[b.id]);
  const done=await finish(b);assert.equal(done.reason,'ACCOUNT_SNAPSHOT_WAIT_EXHAUSTED');assert.equal(done.pending,false);
  assert.deepEqual((await row(b)).expires_at,b.expires_at);
  assert.equal((await q('select count(*)::int n from leader20_review_events'))[0].n,0);
 });
 await t.test('service-only execute privileges and invoker security are retained',async()=>{
  assert.equal((await q("select has_function_privilege('anon','public.leader20_batch_finish(uuid,uuid,jsonb)','execute') p"))[0].p,false);
  assert.equal((await q("select has_function_privilege('service_role','public.leader20_batch_finish(uuid,uuid,jsonb)','execute') p"))[0].p,true);
  assert.equal((await q("select prosecdef from pg_proc where oid='public.leader20_batch_finish(uuid,uuid,jsonb)'::regprocedure"))[0].prosecdef,false);
 });
});
test('client loop is bounded and never retries non-transient capacity errors or database exceptions',async()=>{
 let n=0,sleeps=0;const b={id:'batch',owner:'owner'};
 const db={rpc:async()=>{n++;return{data:{pending:true,reason:'ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE'}};}};
 const out=await finishEntryBatch(db,b,result,{sleep:async()=>{sleeps++;}});
 assert.equal(n,32);assert.equal(sleeps,31);assert.equal(out.reason,'BATCH_FINISH_RETRY_LIMIT');
 n=0;db.rpc=async()=>{n++;return{data:{pending:false,reason:'PENDING_CAPITAL_RESERVED'}};};
 assert.equal((await finishEntryBatch(db,b,result)).reason,'PENDING_CAPITAL_RESERVED');assert.equal(n,1);
 db.rpc=async()=>({error:{message:'RPC_FAILED'}});
 await assert.rejects(finishEntryBatch(db,b,result),/BATCH_FINISH:RPC_FAILED/);
});
