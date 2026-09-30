import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {controlDisposition} from '../collectors/doa-capture/core.mjs';

const autotrader=readFileSync(new URL('../supabase/functions/market-autotrader/index.ts',import.meta.url),'utf8');
const collector=readFileSync(new URL('../collectors/doa-capture/worker.mjs',import.meta.url),'utf8');
const ingest=readFileSync(new URL('../supabase/functions/doa-capture-ingest/index.ts',import.meta.url),'utf8');

class Lease {
  constructor(ttlMs=150000){this.ttlMs=ttlMs;this.owner=null;this.expires=0;}
  acquire(owner,now){
    if(this.owner && this.expires>now && this.owner!==owner)return false;
    this.owner=owner;this.expires=now+this.ttlMs;return true;
  }
  release(owner){if(this.owner===owner){this.owner=null;this.expires=0;return true;}return false;}
}
function simulate({runtimeMs,cronMs=30000,throughMs=180000,crash=false}){
  const lease=new Lease(),active=[],started=[],skipped=[];
  let running=null;
  for(let now=0;now<=throughMs;now+=cronMs){
    if(running && !crash && running.finish<=now){lease.release(running.owner);running=null;}
    const owner='i'+now;
    if(!lease.acquire(owner,now)){skipped.push(now);continue;}
    started.push(now);running={owner,finish:now+runtimeMs};active.push({start:now,end:crash?lease.expires:now+runtimeMs});
    if(runtimeMs===0&&!crash){lease.release(owner);running=null;}
  }
  let max=0;
  for(const p of active){
    let n=0;for(const q of active)if(q.start<p.end&&q.end>p.start)n++;
    max=Math.max(max,n);
  }
  return {started,skipped,max};
}

test('A: 5s executor fits 30s cadence without skips',()=>{
  const r=simulate({runtimeMs:5000,throughMs:90000});
  assert.equal(r.max,1);assert.equal(r.skipped.length,0);assert.deepEqual(r.started,[0,30000,60000,90000]);
});
test('B: 60s executor skips the overlapping 30s invocation',()=>{
  const r=simulate({runtimeMs:60000,throughMs:120000});
  assert.equal(r.max,1);assert.ok(r.skipped.includes(30000));assert.ok(r.started.includes(60000));
});
test('C: 110s executor never exceeds one active owner',()=>{
  const r=simulate({runtimeMs:110000,throughMs:240000});
  assert.equal(r.max,1);assert.ok(r.skipped.length>=2);
});
test('D: crashed owner is recovered by the bounded 150s TTL',()=>{
  const r=simulate({runtimeMs:110000,throughMs:210000,crash:true});
  assert.deepEqual(r.started.slice(0,2),[0,150000]);assert.equal(r.max,1);
});

test('single-flight is acquired before loadSettings and never waits for the old scan gap',()=>{
  const handler=autotrader.indexOf('Deno.serve(async (request: Request) =>');
  const acquire=autotrader.indexOf('event: "EXECUTOR_LEASE_ACQUIRED"',handler);
  const settings=autotrader.indexOf('let settings = await loadSettings()',handler);
  assert.ok(handler>=0&&acquire>handler&&settings>acquire,'lease must precede settings');
  assert.ok(autotrader.includes('reason: "SKIPPED_ALREADY_RUNNING"'));
  const scan=autotrader.slice(autotrader.lastIndexOf('if (action === "scan")'));
  assert.equal(scan.includes('runWithContendedLease('),false,'overlap invocation must not wait in a queue');
});

test('E/F/G: DB degradation is bounded, fail-fast and does not amplify settings writes',()=>{
  assert.ok(autotrader.includes('const DB_LIGHT_TIMEOUT_MS = 3_000'));
  assert.ok(autotrader.includes('status: "DB_DEGRADED"'));
  const catchAt=autotrader.lastIndexOf('const databaseFailure =');
  const dbBranch=autotrader.slice(catchAt,autotrader.indexOf('} else if (availabilityFailure)',catchAt));
  assert.equal(dbBranch.includes('loadSettings()'),false);
  assert.equal(dbBranch.includes('patch("trading_settings"'),false);
  assert.equal(/for\s*\([^)]*databaseFailure/.test(dbBranch),false);
});

test('J: collector keeps market streams alive when control/ingest is unavailable',()=>{
  const d=controlDisposition({stopped:true});
  assert.equal(d.action,'run');assert.equal(d.reason,'CONTROL_UNAVAILABLE');
  assert.equal(collector.includes("throw Error('PERSIST_QUEUE_CAP')"),false);
  assert.ok(collector.includes("log('PERSIST_QUEUE_EVICT'"));
});

test('collector buffer and ingest DB calls are bounded',()=>{
  assert.ok(collector.includes('const PERSIST_QUEUE_CAP=1200'));
  assert.ok(collector.includes('buffer_dropped_rows:bufferDrops'));
  assert.ok(ingest.includes('DB_LIGHT_TIMEOUT_MS=3000'));
  assert.ok(ingest.includes('DB_RPC_TIMEOUT_MS=5000'));
  assert.ok(ingest.includes('TOKEN_CACHE_MS=30000'));
});

test('production_continuous telemetry follows the actual persistence contract',()=>{
  assert.ok(collector.includes('pending.metrics.production_continuous=production;'));
  assert.ok(collector.includes('pending.metrics.clock_window_active=!!clockWindow;'));
  assert.equal(collector.includes('production_continuous=production&&!clockWindow'),false);
});

test('K/L: DB outage path cannot create an order and monitor remains an independent cycle',()=>{
  const handler=autotrader.slice(autotrader.indexOf('Deno.serve(async (request: Request) =>'));
  const degraded=handler.indexOf('status: "DB_DEGRADED"');
  const begin=handler.indexOf('cycleId = await beginCycle');
  assert.ok(degraded>=0&&begin>degraded,'DB-degraded lease path returns before a trading cycle begins');
  assert.ok(autotrader.includes('if (action === "monitor")'));
  assert.ok(autotrader.includes('const result = await monitorCycle(cycleId, settings);'));
});

test('H/I: infrastructure patch contains no AI timeout or authority rewrite',()=>{
  for(const forbidden of [
    'OPENAI_TIMEOUT_MS = 3000','DEEPSEEK_TIMEOUT_MS = 3000',
    'simulateEntryTimeout:true','simulateFinalTimeout:true',
    'AI_SKIP_ON_DB_DEGRADED','AUTO_BUY_BEFORE_AI'
  ]) assert.equal(autotrader.includes(forbidden),false,forbidden);
});
