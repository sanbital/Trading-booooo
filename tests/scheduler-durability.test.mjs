import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
async function fixture(t) {
  const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec('create table v17_execution_infrastructure_control(singleton boolean,short_writer_enabled boolean,recovered_postmaster_at timestamptz);create table leader20_control(singleton boolean,observation_enabled boolean,clock_capture_enabled boolean);create function leader20_claim_execution_wake(text) returns boolean language sql as $$select false$$;');
  await db.exec(await readFile(new URL('../supabase/migrations/20261002101500_external_scheduler_expand.sql',import.meta.url),'utf8'));
  await db.exec(`insert into trading_scheduler_control(scheduler_key,enabled,recovery_complete,recovered_postmaster_at)
    values('test',true,true,pg_postmaster_start_time());
    insert into trading_scheduler_jobs(scheduler_key,job_key,enabled,period_ms,timeout_ms,recovery_mode,requires_recovery,target)
    values('test','signals',true,60000,5000,'CURRENT_ONLY',false,
      '{"endpoint":"market-v2-signal","body":{"action":"run","venue":"binance_futures"}}');`);
  const query=(sql,args=[])=>db.query(sql,args).then(r=>r.rows[0]);
  const owner=crypto.randomUUID();
  const lease=(await query('select trading_scheduler_lead($1,$2) r',['test',owner])).r;
  const claim=()=>query('select trading_scheduler_claim($1,$2,$3,$4) r',['test',owner,lease.fence,'signals']).then(r=>r.r);
  return{db,query,owner,lease,claim};
}
test('two scheduler machines have one DB leader and one deterministic tick',async t=>{
  const f=await fixture(t);
  assert.equal((await f.query('select trading_scheduler_lead($1,$2) r',['test',crypto.randomUUID()])).r,null);
  const results=await Promise.all([f.claim(),f.claim()]);assert.equal(results.filter(Boolean).length,1);
  const row=results.find(Boolean);assert.match(row.idempotency_key,/^test:signals:\d+$/);
});
test('tick admission rejects duplicate, wrong endpoint/body and legacy cron overlap',async t=>{
  const f=await fixture(t),claim=await f.claim();
  const body={action:'run',venue:'binance_futures'};
  const envelope={key:'test',job:'signals',tick:claim.tick,owner:f.owner,fence:f.lease.fence,idempotency_key:claim.idempotency_key};
  const admit=(endpoint,payload,w)=>f.query('select trading_scheduler_admit($1,$2,$3) r',[endpoint,payload,w]).then(r=>r.r);
  assert.equal(await admit('market-v2-signal',body,null),'EXTERNAL_SCHEDULER_REQUIRED');
  assert.equal(await admit('v10-lane-executor',body,envelope),'TICK_TARGET_MISMATCH');
  assert.equal(await admit('market-v2-signal',{action:'run',venue:'upbit_spot'},envelope),'TICK_TARGET_MISMATCH');
  assert.equal(await admit('market-v2-signal',body,envelope),'ACCEPTED');
  assert.equal(await admit('market-v2-signal',body,envelope),'DUPLICATE_OR_FENCED');
});
test('process restart cannot reclaim prior tick and stale leader cannot finish',async t=>{
  const f=await fixture(t),claim=await f.claim();
  await f.db.exec("update trading_scheduler_control set expires_at='-infinity'");
  const next=(await f.query('select trading_scheduler_lead($1,$2) r',['test',crypto.randomUUID()])).r;
  assert.equal(next.fence,f.lease.fence+1);
  await assert.rejects(f.claim(),/SCHEDULER_FENCED/);
  const finish=await f.query("select trading_scheduler_finish($1,$2,$3,$4,$5,'SUCCEEDED','OK') r",
    ['test','signals',claim.tick,f.owner,f.lease.fence]);assert.equal(finish.r,false);
});
test('durable cursor advances only after successful idempotent work; signals never gain cursor catchup',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.db.exec("update trading_scheduler_jobs set recovery_mode='DURABLE_CURSOR'"),/check constraint/);
  await f.db.exec("update trading_scheduler_jobs set recovery_mode='DURABLE_CURSOR',job_kind='ACCOUNTING',target='{}'");
  const c=await f.claim();
  await f.query("select trading_scheduler_finish($1,$2,$3,$4,$5,'SUCCEEDED','OK',0,false,$6)",
    ['test','signals',c.tick,f.owner,f.lease.fence,{fill_id:42}]);
  assert.deepEqual((await f.query('select cursor from trading_scheduler_jobs')).cursor,{fill_id:42});
});
test('cutover backs up exact live cron, blocks overlap and in-flight jobs, and rollback restores prior active state',async t=>{
  const f=await fixture(t);
  await f.db.exec(`create schema cron;
    create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,active boolean);
    create table cron.job_run_details(jobid bigint,status text);
    create function cron.alter_job(job_id bigint,active boolean) returns void language sql as
      'update cron.job set active=$2 where jobid=$1';
    insert into cron.job values(42,'live-signal','5 seconds','select existing_live_job()',true);
    update trading_scheduler_control set enabled=false;
    update trading_scheduler_jobs set legacy_cron_jobid=42;`);
  const manifest=[{jobid:42,jobname:'live-signal',schedule:'5 seconds',
    command_md5:(await f.query("select md5('select existing_live_job()') h")).h}];
  const pause=await f.query('select trading_scheduler_pause_cron($1,$2,$3,$4,clock_timestamp()) r',
    ['test','version-once',manifest,'a'.repeat(40)]);
  assert.equal(pause.r.phase,'PAUSED');assert.equal((await f.query('select active from cron.job')).active,false);
  await f.db.exec('update cron.job set active=true');
  await assert.rejects(f.query("select trading_scheduler_activate('test','version-once')"),/DUAL_SCHEDULER_BLOCKED/);
  await f.db.exec("update cron.job set active=false;insert into cron.job_run_details values(42,'running')");
  await assert.rejects(f.query("select trading_scheduler_activate('test','version-once')"),/OLD_CRON_STILL_RUNNING/);
  await f.db.exec('delete from cron.job_run_details');
  assert.equal((await f.query("select trading_scheduler_activate('test','version-once') r")).r,true);
  await assert.rejects(f.query("select trading_scheduler_rollback('test','version-once',false)"),/STOP_FLY_BEFORE_CRON_RESTORE/);
  assert.equal((await f.query("select trading_scheduler_rollback('test','version-once',true) r")).r,true);
  assert.equal((await f.query('select active from cron.job')).active,true);
  assert.equal((await f.query('select enabled from trading_scheduler_control')).enabled,false);
  await assert.rejects(f.query('select trading_scheduler_pause_cron($1,$2,$3,$4,clock_timestamp())',
    ['test','version-once',manifest,'a'.repeat(40)]),/CUTOVER_VERSION_ALREADY_USED/);
});

test('DB restart retires old leader immediately and requires current writer recovery before entry',async t=>{
 const f=await fixture(t);await f.db.exec("update trading_scheduler_control set lease_postmaster_at=pg_postmaster_start_time()-interval '1 minute'");
 assert.equal((await f.query('select trading_scheduler_heartbeat($1,$2,$3) r',['test',f.owner,f.lease.fence])).r,false);
 await assert.rejects(f.claim(),/SCHEDULER_FENCED/);
 const next=(await f.query('select trading_scheduler_lead($1,$2) r',['test',crypto.randomUUID()])).r;
 assert.equal(next.fence,2);
 const args=['test',next.owner,next.fence,'binance_futures:futures'];
 assert.equal((await f.query('select trading_scheduler_recovered($1,$2,$3,$4) r',args)).r,false);
 await f.db.exec('insert into v17_execution_infrastructure_control values(true,true,pg_postmaster_start_time())');
 assert.equal((await f.query('select trading_scheduler_recovered($1,$2,$3,$4) r',args)).r,true);
});
test('offset signal cron never replays a missed hour at scheduler recovery',async t=>{
 const f=await fixture(t);await f.db.exec("update trading_scheduler_jobs set period_ms=3600000,offset_ms=(mod(floor(extract(epoch from clock_timestamp())*1000)::bigint,3600000)+1800000)%3600000");
 assert.equal(await f.claim(),null);
 await f.db.exec("update trading_scheduler_jobs set offset_ms=mod(floor(extract(epoch from clock_timestamp())*1000)::bigint,3600000)::integer");
 assert.ok(await f.claim());assert.equal(await f.claim(),null);
});

test('retry repeats only an unaccepted current tick; accepted timeout cannot start another side effect',async t=>{
 const f=await fixture(t),c=await f.claim(),args=['test','signals',c.tick,f.owner,f.lease.fence];
 await f.query("select trading_scheduler_finish($1,$2,$3,$4,$5,'FAILED','HTTP_503',1)",args);
 await f.db.exec("update trading_scheduler_jobs set retry_at=clock_timestamp()-interval '1 second'");
 const retry=await f.claim();assert.equal(retry.idempotency_key,c.idempotency_key);
 assert.equal((await f.query('select attempt_count from trading_scheduler_ticks')).attempt_count,2);
 assert.equal((await f.query('select trading_scheduler_accept($1,$2,$3,$4,$5) r',args)).r,true);
 await f.query("select trading_scheduler_finish($1,$2,$3,$4,$5,'UNKNOWN','RESPONSE_TIMEOUT',1)",args);
 await f.db.exec("update trading_scheduler_jobs set retry_at=clock_timestamp()-interval '1 second'");
 assert.equal(await f.claim(),null);
});
