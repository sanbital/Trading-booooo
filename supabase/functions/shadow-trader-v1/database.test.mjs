import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const dependency = process.env.PGLITE_MODULE;
if (!dependency) throw new Error('PGLITE_MODULE is required');
const { PGlite } = await import(pathToFileURL(dependency).href);

async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema extensions;
    create function extensions.gen_random_bytes(integer) returns bytea language sql immutable
      as 'select decode(repeat(''ab'',$1),''hex'')';
    create schema cron;
    create table cron.job(jobid bigint generated always as identity primary key,jobname text,schedule text,command text,active boolean default true);
    create function cron.schedule(text,text,text) returns bigint language plpgsql as $$
    declare j bigint;begin insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid into j;return j;end $$;
    create function cron.unschedule(bigint) returns boolean language sql as 'delete from cron.job where jobid=$1 returning true';
    create schema net;
    create function net.http_post(url text,headers jsonb default '{}'::jsonb,body jsonb default '{}'::jsonb,timeout_milliseconds integer default 1000)
      returns bigint language sql as 'select 1::bigint';
    create table public.edge_internal_tokens(name text primary key,token text not null,created_at timestamptz not null default now(),rotated_at timestamptz not null default now());
    create table public.manual_trade_ledger(
      market text,exchange_order_id text,exchange_trade_id bigint,executed_at timestamptz,price numeric,quantity numeric,
      leverage numeric,strategy_tag text,source_classification text,side text,event_type text
    );
    create table public.manual_trade_outcomes(
      market text,entry_order_id text,exit_at timestamptz,holding_seconds bigint,return_pct numeric,roi_pct numeric,
      mfe_pct numeric,mae_pct numeric,profit_giveback_pct numeric
    );
  `);
  const migration = await readFile(new URL('../../migrations/20261005120324_shadow_trader_v1.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  const hardening = await readFile(new URL('../../migrations/20261005122247_shadow_trader_v1_hardening.sql', import.meta.url), 'utf8');
  await db.exec(hardening);
  return db;
}

const snapshot = {
  mark_price: 100, index_price: 100,
  candles: { m1: {}, m5: {}, m15: {}, h1: {} }, chart: {}, technical: {}, derivatives: {},
  microstructure: { best_bid: 99.9, best_ask: 100, spread_bps: 10, bid_depth: 1000, ask_depth: 1000, book_imbalance: 0, estimated_slippage_bps: 1 },
};

test('migration installs locked shadow-only configuration and a five-second schedule', async (t) => {
  const db = await setup(t);
  const configs = await db.query('select strategy_key,shadow_only,order_capability,hard_stop_underlying_pct from shadow_strategy_configs order by strategy_key');
  assert.equal(configs.rows.length, 2);
  assert.ok(configs.rows.every((row) => row.shadow_only === true && row.order_capability === false));
  assert.ok(configs.rows.every((row) => Number(row.hard_stop_underlying_pct) === -5));
  const jobs = await db.query("select schedule,command from cron.job where jobname='shadow-trader-v1-5s'");
  assert.equal(jobs.rows[0].schedule, '5 seconds');
  assert.match(jobs.rows[0].command, /shadow-trader-v1/);
});

test('virtual entry, restart-safe hold and -5 percent hard stop never touch production tables', async (t) => {
  const db = await setup(t);
  const owner = '00000000-0000-4000-8000-000000000001';
  const clock = await db.query('select clock_timestamp() tick');
  const tick = new Date(clock.rows[0].tick).toISOString();
  const claim = await db.query('select shadow_claim_runtime_v1($1,$2) result', [owner, tick]);
  assert.equal(claim.rows[0].result.acquired, true);
  const run = await db.query(`insert into shadow_strategy_runs(run_key,tick_at,scan_slot,run_kind,status)
    values('test-run',$1,$1,'SCAN','RUNNING') returning id`, [tick]);
  const runId = run.rows[0].id;
  const candidate = await db.query(`insert into shadow_trade_candidates(
    run_id,strategy_key,market,candidate_decision_at,expires_at,reference_price,outcome_due_at,stage,decision)
    values($1,'SHADOW_TREND_LONG_V1','TESTUSDT',$2,$2::timestamptz+interval '5 minutes',100,
      $2::timestamptz+interval '121 minutes','SHORTLISTED','WAIT') returning id`, [runId, tick]);
  const candidateId = candidate.rows[0].id;
  await db.query(`insert into shadow_trade_snapshots(
    snapshot_key,candidate_id,run_id,strategy_key,market,snapshot_type,captured_at,
    best_bid,best_ask,spread_bps,bid_depth,ask_depth,book_imbalance,estimated_slippage_bps,microstructure)
    values('decision-test',$1,$2,'SHADOW_TREND_LONG_V1','TESTUSDT','ENTRY_DECISION',$3,
      99.9,100,10,1000,900,0.05,1,'{"best_bid":99.9,"best_ask":100}'::jsonb)`, [candidateId, runId, tick]);
  const opened = await db.query(`select shadow_open_position_v1($1,$2,$3,100,100,4.5,150,450,3,0.225,0,$4::jsonb) result`,
    [candidateId, runId, tick, JSON.stringify(snapshot)]);
  assert.equal(opened.rows[0].result.opened, true);
  const enteredCandidate = await db.query('select decision,rejection_reasons,best_bid,best_ask from shadow_trade_candidates where id=$1', [candidateId]);
  assert.equal(enteredCandidate.rows[0].decision, 'BUY');
  assert.deepEqual(enteredCandidate.rows[0].rejection_reasons, []);
  assert.equal(Number(enteredCandidate.rows[0].best_bid), 99.9);
  const positionId = opened.rows[0].result.position_id;
  assert.equal(Number(opened.rows[0].result.hard_stop_price), 95);

  await db.query(`select shadow_record_position_tick_v1($1,$2,$3,'HOLD',101,null,null,0,'TREND_THESIS_INTACT',$4::jsonb)`,
    [positionId, runId, new Date(Date.parse(tick) + 5000).toISOString(), JSON.stringify(snapshot)]);
  await db.query(`select shadow_record_position_tick_v1($1,$2,$3,'HOLD',95,94.9,null,0.213525,'UNDERLYING_HARD_STOP_MINUS_5_PCT',$4::jsonb)`,
    [positionId, runId, new Date(Date.parse(tick) + 10_000).toISOString(), JSON.stringify(snapshot)]);
  const position = await db.query('select status,remaining_quantity,exit_reason,mfe_pct,mae_pct from shadow_positions where id=$1', [positionId]);
  assert.equal(position.rows[0].status, 'CLOSED');
  assert.equal(Number(position.rows[0].remaining_quantity), 0);
  assert.equal(position.rows[0].exit_reason, 'UNDERLYING_HARD_STOP_MINUS_5_PCT');
  const outcome = await db.query('select hard_stop,underlying_return_pct,levered_return_pct from shadow_trade_outcomes where position_id=$1', [positionId]);
  assert.equal(outcome.rows[0].hard_stop, true);
  assert.ok(Number(outcome.rows[0].underlying_return_pct) < -5);
  assert.ok(Number(outcome.rows[0].levered_return_pct) < -15);
});

test('candidate rejection outcomes are isolated and idempotent', async (t) => {
  const db = await setup(t);
  const run = await db.query(`insert into shadow_strategy_runs(run_key,tick_at,run_kind,status)
    values('candidate-outcome',now(),'SCAN','COMPLETED') returning id`);
  const candidate = await db.query(`insert into shadow_trade_candidates(
    run_id,strategy_key,market,candidate_decision_at,expires_at,reference_price,outcome_due_at,
    stage,decision,rejection_reasons)
    values($1,'SHADOW_SHORT_SQUEEZE_LONG_V1','TESTUSDT',now()-interval '3 hours',now()-interval '2 hours',
      100,now()-interval '59 minutes','FUNDING_NOT_EXTREME','SKIP',array['FUNDING_NOT_EXTREME']) returning id`, [run.rows[0].id]);
  await db.query(`insert into shadow_candidate_outcomes(
    candidate_id,strategy_key,market,candidate_decision_at,reference_price,evaluated_at,
    forward_120m_pct,mfe_2h_pct,mae_2h_pct,was_entered,terminal_stage,rejection_reasons)
    values($1,'SHADOW_SHORT_SQUEEZE_LONG_V1','TESTUSDT',now()-interval '3 hours',100,now(),2.5,3,-1,
      false,'FUNDING_NOT_EXTREME',array['FUNDING_NOT_EXTREME'])`, [candidate.rows[0].id]);
  await assert.rejects(() => db.query(`insert into shadow_candidate_outcomes(
    candidate_id,strategy_key,market,candidate_decision_at,reference_price,evaluated_at,
    was_entered,terminal_stage) values($1,'SHADOW_SHORT_SQUEEZE_LONG_V1','TESTUSDT',now(),100,now(),false,'DUPLICATE')`, [candidate.rows[0].id]));
});

test('database constraints reject any order-capable runtime state', async (t) => {
  const db = await setup(t);
  await assert.rejects(() => db.query('update shadow_runtime_state set order_capability=true where id=1'));
  await assert.rejects(() => db.query("insert into shadow_strategy_runs(run_key,tick_at,run_kind,status,order_capability) values('unsafe',now(),'MICRO','RUNNING',true)"));
});
