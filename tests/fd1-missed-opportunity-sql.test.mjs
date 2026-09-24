import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const dependency=process.env.PGLITE_MODULE;
if(!dependency)throw Error('Set PGLITE_MODULE to @electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(dependency).href);
const migration=readFileSync(new URL('../supabase/migrations/20260924090000_fd1_execution_retry_missed_journal.sql',import.meta.url),'utf8');
const signalId='11111111-1111-4111-8111-111111111111';

test('missed-opportunity migration records both IOC attempts and a protected partial fill',async()=>{
  const pg=new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema cron;
    create table cron.jobs(name text primary key,schedule text,command text);
    create function cron.schedule(p_name text,p_schedule text,p_command text) returns integer
      language plpgsql as $$ begin insert into cron.jobs values(p_name,p_schedule,p_command); return 1; end $$;
    create function public.http_set_curlopt(p_option text,p_value text) returns void
      language plpgsql as $$ begin return; end $$;
    create function public.http_get(p_url text) returns table(status integer,content text)
      language sql as $$ select 200, (select jsonb_agg(jsonb_build_array('0','0','102','98','101') order by i)
        from generate_series(0,60) i)::text $$;
    create table public.fd1_final_recheck_log(signal_id text,created_at timestamptz default now(),
      pre_dispatch_snapshot jsonb,recheck_triggered boolean,recheck_reasons text[],deltas jsonb,
      final_gpt_decision text,final_gpt_at timestamptz,final_error text);
    create table public.v11_long_regime_signals(id uuid primary key,symbol text,created_at timestamptz,
      updated_at timestamptz,entry_bar_at timestamptz,features jsonb,status text,reject_reason text);
    create table public.gpt_final_entry_reviews(signal_id text,purpose text,decision text,
      completed_at timestamptz,snapshot_at timestamptz,record jsonb,created_at timestamptz);
    create table public.v11_long_regime_orders(id uuid,signal_id uuid,intent text,created_at timestamptz,
      request_payload jsonb,response_payload jsonb,client_order_id text,exchange_order_id text,
      requested_quantity numeric,state text,reject_reason text);
    create table public.v11_long_regime_positions(id uuid,signal_id uuid,entry_at timestamptz,
      original_quantity numeric,entry_price numeric,realized_pnl_usdt numeric,state text);
  `);
  const at=Date.now()-90*60_000;
  await pg.query(`insert into public.v11_long_regime_signals values($1,'NOMUSDT',now()-interval '90 minutes',now(),now()-interval '90 minutes',$2,'FILLED',null)`,
    [signalId,{referenceClose:100,targetMarginUsdt:150,leverage:3,exitPolicy:{stopPct:.025},
      v17Setup:{triggerAt:at,triggerClose:100}}]);
  await pg.query(`insert into public.gpt_final_entry_reviews values($1,'PRODUCTION','BUY',now()-interval '89 minutes',now()-interval '89 minutes','{"kind":"INITIAL"}'::jsonb,now()-interval '89 minutes')`,[signalId]);
  await pg.query(`insert into public.fd1_final_recheck_log(signal_id,pre_dispatch_snapshot,recheck_triggered,recheck_reasons,deltas,final_gpt_decision,final_gpt_at)
    values($1,'{"ask":100}'::jsonb,true,array['ENTRY_DRIFT'],'{"askBps":10}'::jsonb,'BUY',now()-interval '88 minutes')`,[signalId]);
  await pg.query(`insert into public.v11_long_regime_orders values
    ('22222222-2222-4222-8222-222222222222',$1,'OPEN_LONG',now()-interval '87 minutes',
      '{"entry_ioc_attempt":1,"order":{"price":100}}'::jsonb,'{"order":{"executedQty":"5"}}'::jsonb,
      'client-1','exchange-1',10,'FILLED',null),
    ('33333333-3333-4333-8333-333333333333',$1,'OPEN_LONG',now()-interval '86 minutes',
      '{"entry_ioc_attempt":2,"order":{"price":100.05}}'::jsonb,'{"order":{"executedQty":"0"}}'::jsonb,
      'client-2','exchange-2',5,'REJECTED','IOC_NO_FILL:EXPIRED')`,[signalId]);
  await pg.query(`insert into public.v11_long_regime_positions values
    ('44444444-4444-4444-8444-444444444444',$1,now()-interval '87 minutes',5,100,null,'OPEN')`,[signalId]);
  try{
    await pg.exec(migration);
    const row=(await pg.query(`select signal_status,reject_reason,execution_attempt_count,
      jsonb_array_length(execution_attempts) as legs,fill_quantity::float8 as filled,
      target_margin_usdt::float8 as margin,initial_gpt_decision,final_gpt_decision
      from public.missed_opportunity_journal where signal_id=$1`,[signalId])).rows[0];
    assert.deepEqual(row,{signal_status:'FILLED',reject_reason:'PARTIAL_FILL_ABORT:IOC_RETRY_EXHAUSTED',
      execution_attempt_count:2,legs:2,filled:5,margin:150,initial_gpt_decision:'BUY',final_gpt_decision:'BUY'});
    assert.equal((await pg.query(`select relrowsecurity from pg_class where relname='missed_opportunity_journal'`)).rows[0].relrowsecurity,true);
    assert.equal((await pg.query(`select count(*)::integer as n from cron.jobs where name='missed-opportunity-sync-track-5m'`)).rows[0].n,1);
    assert.equal((await pg.query('select public.missed_opportunity_track(30) as n')).rows[0].n,1);
    const tracked=(await pg.query(`select high_5m::float8 as high,close_60m::float8 as close,
      mfe_5::float8 as mfe,reconstructed_net_usdt::float8 as net,outcome_tracked_at is not null as done
      from public.missed_opportunity_journal where signal_id=$1`,[signalId])).rows[0];
    assert.equal(tracked.high,102);assert.equal(tracked.close,101);
    assert.ok(Math.abs(tracked.mfe-.02)<1e-10);assert.ok(Math.abs(tracked.net-4.05)<1e-10);
    assert.equal(tracked.done,true);
    await pg.exec('set role anon');
    await assert.rejects(pg.query('select * from public.missed_opportunity_journal'),/permission denied/);
    await pg.exec('reset role');
    await pg.query(`update public.v11_long_regime_signals set status='CLOSED' where id=$1`,[signalId]);
    await pg.query('select public.missed_opportunity_sync(10000)');
    assert.equal((await pg.query(`select signal_status from public.missed_opportunity_journal where signal_id=$1`,[signalId])).rows[0].signal_status,'CLOSED');
    assert.equal((await pg.query('select count(*)::integer as n from public.missed_opportunity_journal')).rows[0].n,1);
  }finally{await pg.close();}
});
