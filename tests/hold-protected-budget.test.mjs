import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {BATCH_INTERVAL_MS} from '../supabase/functions/_shared/leader20/batch.mjs';
const migration=new URL('../supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql',import.meta.url);
test('protected monthly and daily budget leaves HOLD/EXIT admitted after ENTRY blocks',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href), db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table gpt_final_entry_reviews(job_key text primary key,owner uuid default gen_random_uuid(),state text,record jsonb,purpose text,
 budget_day date,reserved_usd numeric,settled_usd numeric,model text,signal_id text,symbol text,created_at timestamptz default clock_timestamp());
 create table gpt_final_review_control(singleton boolean,mode text,enforce_approved boolean,approval_ref text,budget_effective_day date,daily_spend_offset numeric,daily_call_offset integer,max_calls_per_day integer);
 insert into gpt_final_review_control values(true,'ENFORCE',true,'test',current_date,0,0,100);
 create table gpt_final_review_daily_budget(utc_day date,reserved_usd numeric,calls integer);
 create function ai_monthly_spend_used(date default current_date) returns numeric language sql as 'select 0::numeric';
 create function leader20_entry_budget_limits() returns jsonb language sql as 'select ''{"protected_usd":0.5}''::jsonb';
 create function gpt_final_review_claim(text,jsonb,numeric,integer,numeric) returns jsonb language sql as 'select ''{"legacy":true}''::jsonb';
 create table leader20_control(singleton boolean,epoch_id uuid,generation bigint,observation_enabled boolean,active_strategy text);
 create table leader20_members(epoch_id uuid,symbol text,rank int);
 create table trading_account_snapshots(exchange text,captured_at timestamptz,positions_complete boolean,available_quote numeric,positions jsonb);
 create table v11_long_regime_positions(symbol text,state text,remaining_quantity numeric,metadata jsonb);
 create table v11_long_regime_orders(state text,response_payload jsonb,signal_id uuid,intent text);
 create table v11_long_regime_signals(id uuid primary key,features jsonb);
 create table leader20_review_events(id uuid default gen_random_uuid(),epoch_id uuid,symbol text,generation bigint,requested_at timestamptz,
 snapshot_end_ms bigint,snapshot_hash text,reason text,priority int,state text default 'REQUESTED',result jsonb,signal_id uuid);
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

 await db.exec(await readFile(new URL('../supabase/migrations/20260928152753_hold_thesis_protection.sql',import.meta.url),'utf8'));
 await q("update ai_provider_limits set enabled=true,monthly_usd=100,daily_usd=100");
 for(const [provider,spent,amount]of [['openai',79.95,.1],['deepseek',94.99,.02]]){
  await q("insert into ai_call_ledger(call_key,provider,model,purpose,parent_key,data_version,state,reserved_usd,actual_usd) select $1||i,$2,$3,'ENTRY',$1||i,'v','SETTLED',$4::numeric/100,$4::numeric/100 from generate_series(1,100) i",['spent-'+provider,provider,provider==='openai'?'gpt-5.4-mini-2026-03-17':'deepseek-flash',spent]);
  const blocked=await reserve('entry-'+provider,provider,'ENTRY',amount);assert.equal(blocked.created,false);assert.equal(blocked.reason,'API_PROTECTED_POSITION_RESERVE');
  assert.equal((await reserve('hold-'+provider,provider,'HOLD',amount)).created,true);
  assert.equal((await reserve('exit-'+provider,provider,'EXIT',amount)).created,true);
  assert.equal((await reserve('research-'+provider,provider,'VERIFICATION',amount)).reason,'API_PROTECTED_POSITION_RESERVE');
 }
 await q('delete from ai_call_ledger');await q("update ai_provider_limits set daily_usd=5 where provider='openai'");
 await q("insert into ai_call_ledger(call_key,provider,model,purpose,parent_key,data_version,state,reserved_usd,actual_usd) values('used','openai','gpt-5.4-mini-2026-03-17','ENTRY','used','v','UNKNOWN',4,null)");
 assert.equal((await reserve('entry-day','openai','ENTRY',.1)).reason,'API_PROTECTED_POSITION_RESERVE');
 assert.equal((await reserve('hold-day','openai','HOLD',.1)).created,true);
 assert.equal((await reserve('hold-too-much','openai','HOLD',1)).reason,'API_BUDGET_EXHAUSTED');
 assert.deepEqual((await q('select monthly_usd from ai_provider_limits')).map(r=>Number(r.monthly_usd)),[100,100]);
 assert.equal((await q("select has_function_privilege('anon','public.ai_call_reserve(text,text,text,text,text,text,numeric)','execute') ok"))[0].ok,false);
});
