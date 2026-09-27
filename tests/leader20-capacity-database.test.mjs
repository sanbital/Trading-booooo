import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {selectEpoch} from '../supabase/functions/_shared/leader20/universe.mjs';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
test('monthly budget and bounded private archive PostgreSQL transitions',async t=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE).href:'@electric-sql/pglite');
 const db=new PGlite();t.after(()=>db.close());
 const sql=async path=>readFile(new URL('../'+path,import.meta.url),'utf8');
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.v11_long_regime_signals(id uuid primary key default gen_random_uuid(),revision text,lane text,symbol text,side text,
      signal_bar_at timestamptz,entry_bar_at timestamptz,features jsonb,status text,reject_reason text,updated_at timestamptz);
    create table public.v11_long_regime_positions(id uuid primary key default gen_random_uuid(),symbol text,state text,remaining_quantity numeric,
      closed_at timestamptz,metadata jsonb default '{}',entry_atr numeric not null default 1);
    create schema doa_capture;
    create table doa_capture.live_micro(symbol text,at timestamptz,received_at timestamptz,payload jsonb);

    create table public.test_context(symbol text primary key,payload jsonb);
    create function public.doa_context_for_role_v1(text,timestamptz,text,uuid) returns jsonb language sql as
      'select payload from public.test_context where symbol=$1';
    create function public.doa_capture_rpc(text,jsonb default '{}') returns jsonb language sql as
      'select jsonb_build_object(''enabled'',true,''watch'',jsonb_build_array(jsonb_build_object(''symbol'',''OLDUSDT'',''roles'',jsonb_build_array(''TRADE_CANDIDATE''))))';`);
 await db.exec(await sql('development/gpt-final-review/sql/gpt_final_review_storage_no_trading_activation.APPLIED_20260923124239.sql'));
 await db.exec((await sql('development/gpt-final-review/sql/gpt_final_review_production_hardening.sql')).split('-- 5. Read-only')[0]);
 await db.exec(await sql('supabase/migrations/20260927121708_leader20_campaigns.sql'));
 await db.exec(await sql('supabase/migrations/20260927131311_leader20_unicode_symbols.sql'));
 await db.exec(await sql('supabase/migrations/20260927140218_leader20_capacity_and_retention.sql'));
 await db.exec(`create schema evolution_private; create table evolution_private.budget(day date primary key,spent numeric default 0,reserved numeric default 0);
  create table evolution_control(singleton boolean,daily_api_cap_usd numeric,max_daily_api_calls integer); insert into evolution_control values(true,10,600);
  create schema cron; create table cron.job(jobid bigint,jobname text); create function cron.alter_job(bigint,schedule text) returns void language sql as 'select';`);
 await db.exec(await sql('supabase/migrations/20260927145129_leader20_all_ai_monthly_budget.sql'));
 const q=async(s,a=[])=>(await db.query(s,a)).rows;
 const rpc=async(n,a)=>(await q(`select public.${n}(${a.map((_,i)=>'$'+(i+1)).join(',')}) r`,a))[0].r;
 const owner=crypto.randomUUID(),ref='USER-APPROVED-2026-09-27-MONTHLY50-AI40-STORAGE10';
 let seq=0;const claim=(record={},cap=1.25)=>rpc('gpt_final_review_claim',[(++seq).toString(16).padStart(64,'0'),{purpose:'PRODUCTION',api_approval_ref:ref,...record},cap,100,.1]);
 await db.exec("update gpt_final_review_control set mode='ENFORCE',enforce_approved=true; update leader20_control set observation_enabled=true");
 await t.test('approved monthly/daily caps and current control defeat stale client increases',async()=>{
  const ctl=(await q('select * from gpt_final_review_control'))[0];assert.equal(Number(ctl.monthly_cap_usd),40);assert.equal(Number(ctl.daily_cap_usd),1.25);
  const a=await claim({},5000);assert.equal(Number(a.row.reserved_usd),.25);
  const b=(await q('select * from gpt_final_review_daily_budget'))[0];assert.equal(Number(b.cap_usd),1.25);
  await assert.rejects(claim({api_approval_ref:'obsolete'}),/APPROVED_API_BUDGET_REQUIRED/);
  await claim();await assert.rejects(claim(),/API_BUDGET_EXHAUSTED/);
  const risk=await claim({identity:{position_id:'held'}});assert.equal(risk.created,true);
  await db.exec('update gpt_final_review_daily_budget set reserved_usd=1.2');await assert.rejects(claim({identity:{position_id:'held'}}),/API_BUDGET_EXHAUSTED/);
  await db.exec("update gpt_final_review_daily_budget set reserved_usd=0; update gpt_final_review_control set monthly_cap_usd=0.1");
  await assert.rejects(claim({identity:{position_id:'held'}}),/API_BUDGET_EXHAUSTED/);
  await db.exec('update gpt_final_review_control set monthly_cap_usd=40');
 });
 await t.test('another day in the same month consumes the shared monthly ceiling',async()=>{
  await db.exec("insert into gpt_final_review_daily_budget(utc_day,cap_usd,max_calls,reserved_usd,calls) values(case when extract(day from current_date)>1 then current_date-1 else current_date+1 end,40,100,39.9,1)");
  await assert.rejects(claim({identity:{position_id:'held'}}),/API_BUDGET_EXHAUSTED/);
  await db.exec('delete from gpt_final_review_daily_budget where utc_day<>current_date');
 });
 await t.test('historical research charges and uncertain reservations share the same monthly ceiling',async()=>{
  await db.exec('insert into evolution_private.budget values(current_date,30,9.9)');
  await assert.rejects(claim({identity:{position_id:'held'}}),/API_BUDGET_EXHAUSTED/);
  assert.equal(Number((await q('select public.ai_monthly_spend_used(current_date) used'))[0].used),39.9);
  await assert.rejects(db.exec('update evolution_control set daily_api_cap_usd=10'),/evolution_paid_research_monthly50_disabled/);
  await db.exec('delete from evolution_private.budget');
 });
 await t.test('the production service role can reserve without permission to edit controls',async()=>{
  await db.exec('set role service_role');
  const a=await claim({identity:{position_id:'held'}});assert.equal(a.created,true);
  await assert.rejects(db.exec('update gpt_final_review_control set monthly_cap_usd=1'),/permission denied/);
  await db.exec('reset role; update gpt_final_review_daily_budget set reserved_usd=0');
 });
 await t.test('known cost above reserve is charged in full; settlement is owner-bound exactly once',async()=>{
  const a=await claim({identity:{position_id:'held'}}),r={result:{attempted:true,api_cost_usd:.4}};
  await assert.rejects(rpc('gpt_final_review_complete',[a.row.job_key,crypto.randomUUID(),r]),/CAS/);
  const x=await rpc('gpt_final_review_complete',[a.row.job_key,a.row.owner,r]);assert.equal(Number(x.settled_usd),.4);
  await assert.rejects(rpc('gpt_final_review_complete',[a.row.job_key,a.row.owner,r]),/CAS/);
  assert.equal(Number((await q('select reserved_usd from gpt_final_review_daily_budget'))[0].reserved_usd),.4);
 });
 await t.test('archive retry lease, private access, verified-only 72h purge and 30d deletion',async()=>{
  await db.exec("insert into leader20_micro_archive(symbol,at,received_at,payload) values ('OLDUSDT',now()-interval '73 hours',now()-interval '73 hours','{}')");
  const a=await rpc('leader20_archive_maintenance',['claim',{owner}]);assert.equal(a.state,'UPLOAD');assert.equal(a.rows.length,1);
  assert.equal((await rpc('leader20_archive_maintenance',['claim',{owner:crypto.randomUUID()}])).state,'BUSY');
  const v={owner,id:a.object.id,row_count:1,bytes:100,raw_sha256:'a'.repeat(64),object_sha256:'b'.repeat(64)};
  await assert.rejects(rpc('leader20_archive_maintenance',['verified',{...v,owner:crypto.randomUUID()}]),/CAS/);
  assert.equal((await q('select count(*)::int n from leader20_micro_archive'))[0].n,1);
  await rpc('leader20_archive_maintenance',['verified',v]);
  assert.equal((await rpc('leader20_archive_maintenance',['claim',{owner}])).state,'IDLE');
  assert.equal((await q('select count(*)::int n from leader20_micro_archive'))[0].n,0);
  await assert.rejects(rpc('leader20_archive_maintenance',['deleted',{owner,id:a.object.id}]),/RETENTION/);
  await db.exec("update leader20_archive_objects set max_at=now()-interval '31 days',min_at=now()-interval '31 days'");
  const del=await rpc('leader20_archive_maintenance',['claim',{owner}]);assert.equal(del.state,'DELETE');
  await rpc('leader20_archive_maintenance',['deleted',{owner,id:del.object.id}]);
  assert.equal((await q('select state from leader20_archive_objects'))[0].state,'DELETED');
  assert.equal((await q("select has_table_privilege('anon','leader20_micro_archive','select') ok"))[0].ok,false);
  assert.equal((await q("select has_function_privilege('authenticated','public.leader20_archive_maintenance(text,jsonb)','execute') ok"))[0].ok,false);
 });
 await t.test('cold cap cannot delete unverified data or quietly continue a new live route',async()=>{
  await db.exec("update leader20_control set cold_archive_max_bytes=1,active_strategy='LEADER20_DYNAMIC_1'; insert into leader20_micro_archive(symbol,at,received_at,payload) values('NEWUSDT',now()-interval '73 hours',now(),'{}')");
  assert.equal((await rpc('leader20_archive_maintenance',['claim',{owner}])).state,'CAP_REACHED');
  assert.equal((await q('select active_strategy from leader20_control'))[0].active_strategy,'PAUSED');
  assert.equal((await q('select count(*)::int n from leader20_micro_archive'))[0].n,1);
 });
 await t.test('only Top10 is scheduled, globally paced, with held outside symbols retained',async()=>{
  const at=Date.now()-100,symbols=Array.from({length:25},(_,i)=>({symbol:`C${i}USDT`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',underlyingType:'COIN'}));
  const epoch=await selectEpoch({exchangeInfo:{symbols},tickers:symbols.map((s,i)=>({symbol:s.symbol,priceChangePercent:String(i),quoteVolume:'100',openTime:at-86400000,closeTime:at})),requestedAt:at,observedAt:at});
  await rpc('leader20_publish_epoch',[epoch,null]);
  await db.exec("update leader20_control set active_strategy='LEADER20_DYNAMIC_1',archive_state='READY',cold_archive_state='READY',archive_last_verified_at=now(); update gpt_final_review_daily_budget set reserved_usd=0,calls=0");
  const capture=rawCapture(Date.now());
  for(const symbol of ['C24USDT','C23USDT','C14USDT'])await q('insert into test_context values($1,$2)',[symbol,capture]);
  assert.equal((await rpc('leader20_schedule',[])).requests,1);
  assert.equal((await q('select count(*)::int n from leader20_review_events'))[0].n,1);
  assert.equal((await q("select state from leader20_campaigns where symbol='C14USDT'"))[0].state,'OUTSIDE_WATCH');
  await db.exec("update leader20_control set last_scheduler_at=now()-interval '61 seconds'");
  assert.equal((await rpc('leader20_schedule',[])).requests,0);
  const watch=await rpc('doa_capture_rpc',['watch',{}]);
  assert.equal(watch.watch.filter(x=>x.roles.includes('SCANNER_LEADER')).length,10);
 });
});
