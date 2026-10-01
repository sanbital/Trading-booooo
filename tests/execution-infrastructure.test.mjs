import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {classifyEntryOrderState} from '../supabase/functions/_shared/entry-order-state.mjs';
import {planAggressiveIocRetry} from '../supabase/functions/v10-lane-executor/entry-ioc-retry.mjs';
import {prioritizeSignal} from '../supabase/functions/v10-lane-executor/execution-dispatch.mjs';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const state=(requestedQty,executedQty,remainingQty,rawStatus,reconciledPositionQty)=>classifyEntryOrderState({
  requestedQty,executedQty,remainingQty,rawStatus,reconciledPositionQty,positionReconciled:true,
  fills:executedQty?[{qty:String(executedQty),time:1}]:[],updateTime:1,
});
const quote={best_bid:9.99,best_ask:10,asks:[[10,200],[10.01,200]]};
const retry=filledQuantity=>planAggressiveIocRetry({quote,targetQuantity:100,filledQuantity,quantityStep:1,
  priceTick:.01,minNotionalUsdt:5,minQuantity:1,leverage:3,maxTotalMarginUsdt:400,
  currentPositionNotionalUsdt:filledQuantity*10});

test('TEST 1: requested 100 / executed 100 / raw FILLED is FILLED',()=>{
  assert.equal(state(100,100,0,'FILLED',100).state,'FILLED');
});
test('TEST 2: terminal IOC partial is not FILLED and its position quantity is the actual 20',()=>{
  const result=state(100,20,80,'EXPIRED',20);
  assert.equal(result.state,'PARTIALLY_FILLED_CANCELED');
  assert.equal(result.reconciliation.actualPositionQty,20);
  assert.notEqual(result.state,'FILLED');
});
test('TEST 3: zero-fill expiry is EXPIRED and does not imply a position',()=>{
  const result=state(100,0,100,'EXPIRED',0);
  assert.equal(result.state,'EXPIRED');assert.equal(result.reconciliation.actualPositionQty,0);
});
test('TEST 4: zero-fill then bounded retry partial records actual 20, never target 100',()=>{
  assert.equal(state(100,0,100,'EXPIRED',0).state,'EXPIRED');
  const plan=retry(0);assert.equal(plan.ok,true);assert.equal(plan.remainingQuantity,100);
  const second=state(100,20,80,'EXPIRED',20);
  assert.equal(second.reconciliation.actualPositionQty,20);assert.notEqual(second.reconciliation.actualPositionQty,100);
});
test('TEST 5: a 20 fill retries only the reconciled remaining target 80',()=>{
  const plan=retry(20);assert.equal(plan.ok,true);assert.equal(plan.remainingQuantity,80);
});
test('TEST 6: durable GPT BUY trigger dispatches immediate execution and exact signal is prioritized',async()=>{
  const [migration,executor]=await Promise.all([
    read('supabase/migrations/20260930115438_execution_dispatch_and_partial_fill_truth.sql'),
    read('supabase/functions/v10-lane-executor/index.ts')]);
  assert.match(migration,/after insert or update on public\.gpt_final_entry_reviews/);
  assert.match(migration,/net\.http_post[\s\S]+"?execute-ready"?/);
  assert.match(executor,/mode==="execute-ready"/);assert.match(executor,/runDispatchedEntry/);
  assert.deepEqual(prioritizeSignal([{id:'a'},{id:'b'}],'b').map(x=>x.id),['b','a']);
});
test('TEST 6B: execute-ready-any is a short outbox-only path with no GPT fallback',async()=>{
  const executor=await read('supabase/functions/v10-lane-executor/index.ts');
  assert.match(executor,/async function runExecutionDispatchOnly\(db,signalId=null\)/);
  assert.match(executor,/mode==="execute-ready-any"\)return res\(200,await runExecutionDispatchOnly\(db\)\)/);
  const start=executor.indexOf('async function runExecutionDispatchOnly');
  const end=executor.indexOf('async function runLeaseCycleWithDispatchPriority',start);
  assert.ok(start>=0&&end>start);
  assert.doesNotMatch(executor.slice(start,end),/runWithGptReview/);
});
test('TEST 6C: deployed durable BUY uses DB wake and never inherits review request lifetime',async()=>{
 const [executor,migration]=await Promise.all([
  read('supabase/functions/v10-lane-executor/index.ts'),
  read('supabase/migrations/20260930115438_execution_dispatch_and_partial_fill_truth.sql')]);
 assert.doesNotMatch(executor,/setImmediateExecutionWake\(db,/);
 assert.match(migration,/insert into public\.leader20_execution_dispatches/);
 assert.match(migration,/after insert or update on public\.gpt_final_entry_reviews/);
 assert.match(executor,/return await runWithLease\(db,\(\)=>drainExecutionDispatchesUnderAccountLease\(db,signalId\)\)/);
});
test('TEST 7, 10, 11: atomic signal claim, expired refusal, and live 30-second authority',async t=>{
  assert.ok(process.env.PGLITE_MODULE,'PGLITE_MODULE is required');
  const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table v11_long_regime_signals(id uuid primary key);
   create table v11_long_regime_orders(id uuid primary key);
   create table leader20_clock_executions(signal_id uuid primary key,executor_claimed_at timestamptz,
    terminal_reason text,execution_failure_reason text,order_sent_at timestamptz,updated_at timestamptz default clock_timestamp());`);
  const migration=await read('supabase/migrations/20260930115438_execution_dispatch_and_partial_fill_truth.sql');
  const dispatchSql=migration.slice(migration.indexOf('create table public.leader20_execution_dispatches'),
    migration.indexOf('create or replace function public.leader20_enqueue_execution'));
  await db.exec(dispatchSql);
  const signal=crypto.randomUUID(),ownerA=crypto.randomUUID(),ownerB=crypto.randomUUID(),now=Date.now();
  await db.query('insert into v11_long_regime_signals values($1)',[signal]);
  await db.query('insert into leader20_clock_executions(signal_id) values($1)',[signal]);
  await db.query(`insert into leader20_execution_dispatches(signal_id,symbol,state,gpt_completed_at,valid_until)
   values($1,'TESTUSDT','READY_TO_EXECUTE',$2,$3)`,[signal,new Date(now-1000),new Date(now+30000)]);
  const claim=async owner=>(await db.query('select leader20_execution_claim($1,$2,24000) r',[signal,owner])).rows[0].r;
  const [a,b]=await Promise.all([claim(ownerA),claim(ownerB)]);
  assert.equal([a,b].filter(x=>x.claimed).length,1,'two executors must produce exactly one claim');
  assert.ok([a,b].some(x=>x.reason==='EXECUTION_ALREADY_CLAIMED'));
  const expired=crypto.randomUUID();await db.query('insert into v11_long_regime_signals values($1)',[expired]);
  await db.query('insert into leader20_clock_executions(signal_id) values($1)',[expired]);
  await db.query(`insert into leader20_execution_dispatches(signal_id,symbol,state,gpt_completed_at,valid_until)
   values($1,'OLDUSDT','READY_TO_EXECUTE',$2,$3)`,[expired,new Date(now-30000),new Date(now-1000)]);
  const no=(await db.query('select leader20_execution_claim($1,$2,24000) r',[expired,crypto.randomUUID()])).rows[0].r;
  assert.equal(no.claimed,false);assert.equal(no.reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
  assert.equal(a.claimed||b.claimed,true,'30-second live authority must claim without a polling-cycle wait');
});
test('TEST 12: large telemetry reservation does not block a call below actual-use limits',async t=>{
  assert.ok(process.env.PGLITE_MODULE,'PGLITE_MODULE is required');
  const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table ai_provider_limits(provider text primary key,monthly_usd numeric,daily_usd numeric,enabled boolean);
   create table ai_call_ledger(call_key text primary key,provider text,model text,purpose text,parent_key text,data_version text,
    owner uuid default gen_random_uuid(),state text,reserved_usd numeric,actual_usd numeric,created_at timestamptz default clock_timestamp());
   create table leader20_batch_control(singleton boolean primary key,enabled boolean);insert into leader20_batch_control values(true,false);
   create table gpt_final_review_control(singleton boolean primary key,daily_cap_usd numeric,max_calls_per_day integer,
    budget_effective_day date,daily_spend_offset numeric);insert into gpt_final_review_control values(true,1,100,current_date,0);
   create table gpt_final_review_daily_budget(utc_day date,settled_usd numeric);insert into gpt_final_review_daily_budget values(current_date,0);
   create table v11_long_regime_positions(state text,remaining_quantity numeric,metadata jsonb);
   create function ai_legacy_deepseek_used(date,boolean default false) returns numeric language sql as 'select 0::numeric';
   create function ai_monthly_spend_used_before_provider_ledger(date default current_date) returns numeric language sql as 'select 0::numeric';
   create function leader20_batch_capacity() returns jsonb language sql as 'select ''{"available":1}''::jsonb';`);
  const migration=await read('supabase/migrations/20260930115438_execution_dispatch_and_partial_fill_truth.sql');
  await db.exec(migration.slice(migration.indexOf('create or replace function public.ai_provider_month_used')));
  await db.exec("insert into ai_provider_limits values('openai',10,1,true)");
  await db.exec("insert into ai_call_ledger(call_key,provider,model,purpose,parent_key,data_version,state,reserved_usd,actual_usd) values('old','openai','gpt-5.4-mini-2026-03-17','ENTRY','p','v','UNKNOWN',9,null)");
  const row=(await db.query("select ai_call_reserve('new','openai','gpt-5.4-mini-2026-03-17','ENTRY','p2','v2',9) r")).rows[0].r;
  assert.equal(row.created,true);assert.equal(row.accounting_basis,'ACTUAL_PLUS_MINIMAL_INFLIGHT');
});
