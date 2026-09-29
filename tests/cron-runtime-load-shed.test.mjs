import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const sql=readFileSync(new URL('../supabase/migrations/20260929100200_pg_cron_runtime_load_shed.sql',import.meta.url),'utf8');

test('emergency cron load shedding removes only deferrable database pressure',async t=>{
 await t.test('the synchronous missed-opportunity HTTP trackers are disabled',()=>{
  assert.ok(sql.includes("command ilike '%missed_opportunity_track(%'"));
  assert.ok(sql.includes("command ilike '%missed_opportunity_track_lane(%'"));
  assert.ok(sql.includes('cron.alter_job(j.jobid, active := false)'));
 });
 await t.test('two 10-second telemetry expiry jobs become one one-minute maintenance job',()=>{
  assert.ok(sql.includes("'leader20-clock-telemetry-expiry'"));
  assert.ok(sql.includes("'leader20-clock-execution-expiry'"));
  assert.ok(sql.includes("'leader20-clock-telemetry-maintenance-1m'"));
  assert.ok(sql.includes("'* * * * *'"));
  assert.ok(sql.includes('perform public.leader20_clock_expire()'));
  assert.ok(sql.includes('perform public.leader20_clock_execution_expire()'));
 });
 await t.test('finite replay workers are disabled only after every replay job is done',()=>{
  assert.ok(sql.includes("where state is distinct from 'DONE'"));
  assert.ok(sql.includes("'fd1-replay-30s','fd1-replay-30s-b'"));
 });
 await t.test('the migration does not alter capital, order, entry or exit policy',()=>{
  for(const forbidden of [
   'update public.trading_settings',
   'update public.v11_long_regime_orders',
   'insert into public.v11_long_regime_orders',
   'leader20_batch_capacity(',
   'leader20_reserve_entry_slot(',
   'risk_per_trade_pct',
   'max_open_positions'
  ]) assert.equal(sql.toLowerCase().includes(forbidden.toLowerCase()),false,'must not touch '+forbidden);
 });
 await t.test('the migration fails fast under contention',()=>{
  assert.ok(sql.includes("set local lock_timeout = '1s'"));
  assert.ok(sql.includes("set local statement_timeout = '10s'"));
 });
});
