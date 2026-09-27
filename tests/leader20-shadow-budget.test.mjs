import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

test('monthly ceiling counts settled shadow cost once and preserves uncertain reservations',async t=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE).href:'@electric-sql/pglite');
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table public.gpt_final_review_daily_budget(utc_day date,reserved_usd numeric);
 create schema evolution_private;create table evolution_private.budget(day date,spent numeric,reserved numeric);
 create schema shadow_le;create table shadow_le.control(singleton boolean,enabled boolean,gpt_enabled boolean,
 v2_discovery_gpt boolean,v2_parity_enabled boolean,set_by text,reason text,updated_at timestamptz);
 insert into shadow_le.control values(true,true,true,true,true,null,null,now());
 create table shadow_le.budget(entry_id bigint,utc_day date,kind text,reservation_id bigint,usd numeric);
 create table shadow_le.v2_budget(like shadow_le.budget);
 create table shadow_le.fd1_thesis_reviews(created_at timestamptz,cost_usd numeric);
 create schema cron;create table cron.job(jobid bigint,jobname text,active boolean default true);
 insert into cron.job(jobid,jobname) values(1,'boo-r1-shadow-20260916'),(2,'v11-long-regime-executor'),(3,'leader20-private-archive');
 create function cron.alter_job(bigint,active boolean) returns void language sql as 'update cron.job set active=$2 where jobid=$1';`);
 await db.exec(await readFile(new URL('../supabase/migrations/20260927150852_leader20_legacy_shadow_cost_closure.sql',import.meta.url),'utf8'));
 await db.exec(`insert into gpt_final_review_daily_budget values('2026-09-27',30),('2026-10-01',999);
 insert into evolution_private.budget values('2026-09-27',1,2);
 insert into shadow_le.budget values(1,'2026-09-27','RESERVE',null,.1),(2,'2026-09-27','SETTLE',1,.04),(3,'2026-09-27','RESERVE',null,.1);
 insert into shadow_le.v2_budget values(1,'2026-09-27','RESERVE',null,.2),(2,'2026-09-27','SETTLE',1,.05),(3,'2026-09-27','RESERVE',null,.2);
 insert into shadow_le.fd1_thesis_reviews values('2026-09-27T12:00:00Z',.03),('2026-09-27T12:00:00Z',null),('2026-10-01T00:00:00Z',999);`);
 const used=(await db.query("select ai_monthly_spend_used('2026-09-27') used")).rows[0].used;
 assert.equal(Number(used),33.432);
 assert.deepEqual((await db.query('select active from cron.job order by jobid')).rows.map(r=>r.active),[false,true,true]);
 await assert.rejects(db.exec('update shadow_le.control set v2_parity_enabled=true'),/leader20_monthly50_shadow_disabled/);
 assert.equal((await db.query("select has_function_privilege('anon','public.ai_monthly_spend_used(date)','execute') ok")).rows[0].ok,false);
});
