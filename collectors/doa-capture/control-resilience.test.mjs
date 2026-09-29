import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {controlBackoffMs,controlDisposition,CONTROL_RECOVERY} from './core.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');

test('a transport failure backs off and never ends the process',async t=>{
 await t.test('backoff grows exponentially and is capped',()=>{
  const mid=n=>controlBackoffMs(n,CONTROL_RECOVERY,()=>.5);
  assert.equal(mid(1),1000);assert.equal(mid(2),2000);assert.equal(mid(3),4000);
  assert.equal(mid(6),30000,'capped at maxMs');assert.equal(mid(500),30000,'and stays capped');
  assert.equal(controlBackoffMs(0),0);assert.equal(controlBackoffMs(-1),0);
  assert.equal(controlBackoffMs(1.5),0,'a non-integer attempt count is not a wait');
 });
 await t.test('jitter spreads retries so a fleet does not reconnect in lockstep',()=>{
  assert.equal(controlBackoffMs(3,CONTROL_RECOVERY,()=>0),3000);
  assert.equal(controlBackoffMs(3,CONTROL_RECOVERY,()=>1),5000);
  const many=new Set(Array.from({length:200},()=>controlBackoffMs(4)));
  assert.ok(many.size>50,'jittered');
  for(const v of many)assert.ok(v>=6000&&v<=10000,'within +/-25% of 8000, got '+v);
 });
 await t.test('only a signal, a crash or the resource cap exits',()=>{
  assert.deepEqual(controlDisposition({}),{action:'run',code:null,reason:null});
  assert.equal(controlDisposition({signalled:true}).action,'exit');
  assert.equal(controlDisposition({signalled:true}).code,0);
  assert.equal(controlDisposition({crashed:true}).action,'exit');
  assert.equal(controlDisposition({crashed:true}).code,1,'a crash asks for a fresh process');
  assert.equal(controlDisposition({overResourceCap:true}).code,1);
 });
 await t.test('a lost control plane keeps the last watch set streaming while retries back off',()=>{
  // This is the exact 2026-09-29 case: 90s without a control response.
  const d=controlDisposition({stopped:true});
  assert.equal(d.action,'run');assert.equal(d.code,null);
  assert.equal(d.reason,'CONTROL_UNAVAILABLE');
  assert.notEqual(d.action,'idle','a DB/Edge outage must not close market-data sockets');
  assert.notEqual(d.action,'exit','a brief Edge outage must not end market surveillance');
 });
 await t.test('a disabled or ended window idles, so re-enabling needs no deploy',()=>{
  assert.equal(controlDisposition({disabled:true}).action,'idle');
  assert.equal(controlDisposition({pastDeadline:true}).action,'idle');
 });
 await t.test('a signal still wins over every degraded state',()=>{
  assert.equal(controlDisposition({signalled:true,stopped:true,disabled:true,crashed:true}).reason,'SIGNAL');
  assert.equal(controlDisposition({crashed:true,stopped:true,disabled:true}).reason,'CRASHED');
 });
});

test('the worker no longer carries any path that ends capture on a transport failure',async t=>{
 const worker=read('./worker.mjs');
 await t.test('the 90-second self-kill is gone',()=>{
  assert.equal(/now-lastControl>90000\?'CONTROL_STALE'/.test(worker),false);
  assert.equal(worker.includes("process.exit(stop?0:1)"),false,'exit code now follows intent');
  assert.ok(worker.includes('controlDisposition('),'the decision is the tested policy');
 });
 await t.test('a 5xx and a rate limit back off instead of stopping',()=>{
  assert.equal(worker.includes("stop=true;throw Error('RATE_LIMIT_STOP')"),false);
  assert.ok(worker.includes('RATE_LIMIT_PAUSE'));
  assert.ok(worker.includes('controlFail('),'every transport failure feeds the backoff');
 });
 await t.test('startup waits out an Edge outage instead of throwing',()=>{
  assert.equal(worker.includes('LEASE_START_TIMEOUT'),false);
 });
 await t.test('only an explicit control decision disables capture',()=>{
  assert.ok(worker.includes("disabled=true;log('CONTROL_DISABLED'"));
  assert.ok(worker.includes('CONTROL_REENABLED'),'and it can be handed back');
 });
 await t.test('ingest backlog is bounded by eviction, not process death',()=>{
  assert.ok(worker.includes('const PERSIST_QUEUE_CAP=1200'));
  assert.ok(worker.includes("log('PERSIST_QUEUE_EVICT'"));
  assert.equal(worker.includes("throw Error('PERSIST_QUEUE_CAP')"),false);
  assert.ok(worker.includes('buffer_dropped_rows:bufferDrops'));
 });
});

test('the supervisor cannot destroy the collector on exit',async t=>{
 const deploy=read('./deploy.mjs');
 await t.test('provisioning restarts instead of removing the machine',()=>{
  assert.equal(/'--restart','no'/.test(deploy),false);
  assert.equal(deploy.includes("'--rm'"),false,'--rm deleted the machine on any exit');
  assert.ok(/'--restart','always'/.test(deploy));
 });
 await t.test('a release repairs the policy on the machine that is already live',()=>{
  const release=readFileSync(new URL('../../ops/leader20/clock-release.mjs',import.meta.url),'utf8');
  assert.ok(release.includes("restart:{policy:'always'}"));
  assert.ok(release.includes('auto_destroy:false'));
  assert.ok(release.includes('COLLECTOR_SUPERVISION_NOT_APPLIED'),'and proves it applied');
 });
});

test('the protocol contract matches the deployed behaviour',async t=>{
 const proto=read('./PROTOCOL.md');
 await t.test('the document no longer promises the design that caused the outage',()=>{
  assert.equal(proto.includes('no restart, auto-destroy on exit'),false);
  assert.equal(proto.includes('no autonomous restart'),false);
  assert.equal(proto.includes('A 429/418 still stops the process'),false);
  assert.ok(proto.includes('restart policy always and auto-destroy off'));
  assert.ok(proto.includes('three-layered'));
 });
 await t.test('a protocol change rolls the hash in the DB and the machine together',()=>{
  const boot=readFileSync(new URL('../../ops/leader20/book-bootstrap-release.mjs',import.meta.url),'utf8');
  assert.ok(boot.includes('PROTOCOL_SHA256:protocol'),'machine env rolls');
  assert.ok(boot.includes("update doa_capture.control set protocol_sha256="),'and the DB rolls with it');
  assert.ok(boot.includes("restart:{policy:'always'}"),'and supervision is repaired on the same lease');
 });
});

test('an external watchdog recovers a machine that is gone or wedged',async t=>{
 const wd=readFileSync(new URL('../../ops/leader20/collector-watchdog.mjs',import.meta.url),'utf8');
 const wf=readFileSync(new URL('../../.github/workflows/collector-watchdog.yml',import.meta.url),'utf8');
 await t.test('it runs on a schedule, outside the worker and outside Fly',()=>{
  assert.ok(wf.includes('schedule:'));assert.ok(wf.includes("cron: '*/5 * * * *'"));
  assert.ok(wf.includes('FLY_API_TOKEN'));assert.ok(wf.includes('SUPABASE_ACCESS_TOKEN'));
 });
 await t.test('it judges on the heartbeat, and restarts a started-but-silent machine',()=>{
  assert.ok(wd.includes('heartbeat_age_ms'));
  assert.ok(wd.includes("m.state==='started'?'RESTART':'START'"));
  assert.ok(wd.includes('COLLECTOR_DID_NOT_RESUME'),'recovery counts only when the heartbeat moves');
 });
 await t.test('it never fights the operator, and never touches trading state',()=>{
  assert.ok(wd.includes('COLLECTOR_DISABLED_BY_OPERATOR'));
  assert.ok(wd.includes('CAPTURE_WINDOW_ENDED'));
  assert.ok(wd.includes('WATCHDOG_STALE_MS_TOO_TIGHT'),'a too-tight threshold is refused');
  for(const forbidden of ['leader20_batch_capacity','leader20_reserve_entry_slot',
   'v11_long_regime_orders','entry_capture_slot_ms','leader20_batch_claim'])
   assert.equal(wd.includes(forbidden),false,'watchdog must not touch '+forbidden);
 });
});
