import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {rawCapture,validCapture} from '../test-support/dynamic-fixtures.mjs';
import {captureForInference} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {batchMomentum} from '../supabase/functions/_shared/leader20/batch-runtime.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');

test('real PostgreSQL: fixed periodic clock, fresh candidates, WAIT continuity, capacity and daily caps',async t=>{
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
 await db.exec(`create trigger campaign_review after update of state on gpt_final_entry_reviews
  for each row when(new.state='DONE' and old.state is distinct from new.state) execute function leader20_record_review();
 update leader20_batch_control set enabled=true,release_receipt='{"budget_verified":true,"recall_verified":true,"concurrency_verified":true,"protection_verified":true}';
 update ai_provider_limits set enabled=true,daily_usd=case when provider='openai' then 50 else 100 end,
  monthly_usd=case when provider='openai' then 1550 else 3100 end;
 update gpt_final_review_control set daily_cap_usd=50,monthly_cap_usd=1550,max_calls_per_day=10000;`);
 const epoch=crypto.randomUUID();
 await q("insert into leader20_control(singleton,epoch_id,generation,observation_enabled,active_strategy) values(true,$1,3,true,'LEADER20_DYNAMIC_1')",[epoch]);
 await q("insert into leader20_epochs values($1,clock_timestamp()+interval '6 hours')",[epoch]);
 await q("insert into trading_account_snapshots values('binance_futures',clock_timestamp(),true,500,'[]')");
 const symbols=Array.from({length:10},(_,i)=>'C'+i+'USDT');
 for(const [i,s] of symbols.entries()){
  await q('insert into leader20_members values($1,$2,$3)',[epoch,s,i+1]);
  await q('insert into leader20_campaigns(symbol,epoch_id) values($1,$2)',[s,epoch]);
  await q('insert into fixture_capture values($1,$2)',[s,rawCapture(Date.now())]);
 }
 const packet=key=>({version:'TOP10_DEEPSEEK_BATCH_3',epoch_id:epoch,generation:3,as_of_ms:Date.now(),batch_hash:key,
  evidence:symbols.map(s=>[s,1,10,0.3]),symbols:symbols.map(s=>({id:s,state:'READY',data_version:key+s,last_ms:Date.now()-500}))});
 let batch,firstSignal,firstEvent;
 const finish=async(p,decision)=>{
  const r=await rpc('leader20_batch_claim',[p,p.batch_hash,true]);assert.equal(r.created,true,JSON.stringify(r));
  await rpc('leader20_batch_start',[r.row.id,r.row.owner]);
  await rpc('leader20_batch_finish',[r.row.id,r.row.owner,{results:p.symbols.map(s=>({id:s.id,version:s.data_version,last_ms:s.last_ms,
   decision,valid:true,grounding:'SYMBOL_CELLS_VERIFIED_V2'}))}]);return r.row;
 };
 await t.test('a ten-symbol periodic batch updates all WAIT campaigns and its successor clock',async()=>{
  batch=await finish(packet('initial'),'WAIT');assert.equal(batch.reason,'TEN_MINUTE');
  assert.equal((await q("select count(*)::int n from leader20_campaigns where state='WATCHING' and last_decision='WAIT' and review_due_at is not null"))[0].n,10);
  assert.equal((await rpc('leader20_batch_claim',[packet('duplicate'),'x',true])).reason,'NOT_DUE');
 });
 await t.test('fast review cannot postpone next periodic slot; concurrent claims coalesce',async()=>{
  const before=(await q('select next_periodic_at from leader20_batch_control'))[0].next_periodic_at;
  await q("update leader20_batch_control set last_slots=0");
  batch=await finish(packet('wake'),'PASS');assert.equal(batch.reason,'SLOT_RELEASED');
  assert.deepEqual((await q('select next_periodic_at from leader20_batch_control'))[0].next_periodic_at,before);
  assert.equal((await q("select count(*)::int n from leader20_review_events where state='REQUESTED'"))[0].n,10);
 });
 const features=()=>({referenceClose:2,execution_snapshot:{complete:true,causal:true,bucket_count:24,end_ms:Date.now()-500,
  start_ms:Date.now()-120500,captured_at_ms:Date.now(),trajectory_hash:'fresh-capture'}});
 await t.test('materialization requires a fresh capture and writes NEW identity/timestamps',async()=>{
  firstEvent=(await q("select * from leader20_review_events where symbol='C0USDT'"))[0];
  const stale=features();stale.execution_snapshot.end_ms-=600000;
  assert.equal((await rpc('leader20_materialize_event',[firstEvent.id,stale])).reason,'FRESH_EXECUTION_CAPTURE_REQUIRED');
  const f=features();firstSignal=(await rpc('leader20_materialize_event',[firstEvent.id,f])).signal_id;
  assert.ok(firstSignal);assert.equal((await rpc('leader20_materialize_event',[firstEvent.id,f])).created,false);
  assert.equal((await rpc('leader20_entry_authority',[firstSignal])).allowed,true);
  const row=(await q('select * from v11_long_regime_signals where id=$1',[firstSignal]))[0];
  assert.equal(row.features.referenceClose,2);assert.equal(row.features.leader20.snapshot_end_ms,f.execution_snapshot.end_ms);
  assert.equal(row.features.leader20.expires_at_ms-row.features.leader20.requested_at_ms,120000);
 });
 await t.test('WAIT followed by stale candidate keeps campaign; a new batch yields a new candidate',async()=>{
  const row=(await q('select * from v11_long_regime_signals where id=$1',[firstSignal]))[0];
  await q("insert into gpt_final_entry_reviews(job_key,state,record) values('wait','RUNNING',$1)",[
   {identity:{signal_id:firstSignal},packet:{task:'ENTRY',leader20:row.features.leader20},result:{valid:true,decision:'WAIT',answer:{action:'DEFER'}}}]);
  await q("update gpt_final_entry_reviews set state='DONE' where job_key='wait'");
  assert.equal((await q("select state from leader20_campaigns where symbol='C0USDT'"))[0].state,'WATCHING');
  await q("update v11_long_regime_signals set status='REJECTED',reject_reason='SIGNAL_STALE_OR_FUTURE' where id=$1",[firstSignal]);
  await q("update leader20_control set last_scheduler_at=null");await rpc('leader20_schedule');
  assert.equal((await rpc('leader20_entry_authority',[firstSignal])).allowed,false);
  await q("update leader20_batch_control set last_periodic_slot=last_periodic_slot-interval '10 minutes'");
  // Historical slot is moved for a synthetic clock boundary; unique production slots remain immutable.
  await q("update leader20_batches set periodic_slot=periodic_slot-interval '10 minutes' where periodic_slot is not null");
  const next=await finish(packet('new-cycle'),'PASS');assert.equal(next.reason,'TEN_MINUTE');
  const event=(await q("select * from leader20_review_events where symbol='C0USDT' and state='REQUESTED'"))[0];
  const id=(await rpc('leader20_materialize_event',[event.id,features()])).signal_id;
  assert.notEqual(id,firstSignal);assert.equal((await rpc('leader20_entry_authority',[id])).allowed,true);
  assert.equal((await q('select count(*)::int n from v11_long_regime_signals where symbol=$1',['C0USDT']))[0].n,2);
 });
 await t.test('budget over legacy three dollars works; provider daily cap remains a hard limit',async()=>{
  await q("insert into ai_call_ledger(call_key,provider,model,purpose,parent_key,data_version,state,reserved_usd,actual_usd) values('spent','openai','gpt-5.4-mini-2026-03-17','ENTRY','spent','spent','SETTLED',4,4)");
  const reserve=k=>rpc('ai_call_reserve',[k,'openai','gpt-5.4-mini-2026-03-17','RECHECK',k,k,.1]);
  assert.equal((await reserve('over-three')).created,true);
  await q("update ai_provider_limits set daily_usd=4.15 where provider='openai'");
  assert.equal((await reserve('over-cap')).reason,'API_BUDGET_EXHAUSTED');
  await q("update trading_account_snapshots set available_quote=0");
  assert.equal((await rpc('leader20_batch_claim',[packet('full'),'full',true])).created,false);
 });
});

test('missing capture pauses and recovers within a bounded window without synthesizing buckets',async()=>{
 let at=1800000000200,reads=0;const missing={status:'UNAVAILABLE',reason:'TEMPORARY_GAP'};
 const c=await captureForInference('ABCUSDT',missing,{now:()=>at,sleep:async ms=>{at+=ms;},
  read:async()=>{reads++;return validCapture(at);}});
 assert.equal(c.complete,true);assert.equal(c.causal,true);assert.equal(c.trajectory.length,24);assert.ok(reads>0);
 const start=at,blocked=await captureForInference('ABCUSDT',missing,{now:()=>at,sleep:async ms=>{at+=ms;},read:async()=>missing});
 assert.equal(blocked.reason,'INFERENCE_CAPTURE_NOT_READY');assert.ok(at-start<=6500);
});

test('batch momentum rejects future/incomplete candles and preserves source time',async()=>{
 const at=1800000000200,end=Math.floor(at/60000)*60000-1;
 const rows=Array.from({length:6},(_,i)=>[0,0,0,0,100+i,0,end-(5-i)*60000]);
 const result=await batchMomentum('ABCUSDT',at,async()=>Response.json(rows));
 assert.equal(result.closed_at_ms,end);assert.equal(result.return_5m,105/100-1);
 rows[5][6]=at+1;assert.equal((await batchMomentum('ABCUSDT',at,async()=>Response.json(rows))).status,'UNAVAILABLE');
});
