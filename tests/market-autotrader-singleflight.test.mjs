import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src=readFileSync(new URL('../supabase/functions/market-autotrader/index.ts',import.meta.url),'utf8');
const handler=src.slice(src.indexOf('Deno.serve(async (request: Request) => {'));

test('recurring autotrader cycles acquire their lease before settings and never wait',()=>{
  const actionAt=handler.indexOf('action = String(body.action || "status").toLowerCase()');
  const acquireAt=handler.indexOf('rpc("acquire_trading_lease"',actionAt);
  const settingsAt=handler.indexOf('let settings = await loadSettings()',actionAt);
  assert.ok(actionAt>=0 && acquireAt>actionAt && settingsAt>acquireAt,
    'scan/monitor must acquire before the first settings read');
  assert.ok(handler.includes('reason: "SKIPPED_ALREADY_RUNNING"'));
  assert.ok(handler.includes('status: "DB_DEGRADED"'));
  assert.equal(handler.includes('waitMs: SCAN_LEASE_WAIT_MS'),false,
    'scheduled scan must not wait behind the running invocation');
});

test('lightweight DB admission and settings reads are bounded separately from executor/AI timeouts',()=>{
  assert.match(src,/const DB_LIGHT_TIMEOUT_MS = 3_000;/);
  assert.match(src,/AUTOTRADER_CYCLE_LEASE_TTL_SECONDS = 150/);
  assert.match(src,/AUTOTRADER_CYCLE_LEASE_RENEW_MS = 30_000/);
  assert.match(src,/trading_settings\?id=eq\.1&select=\*", \{\}, DB_LIGHT_TIMEOUT_MS/);
  assert.match(src,/p_seconds: AUTOTRADER_CYCLE_LEASE_TTL_SECONDS/);
  assert.match(src,/DB_LIGHT_TIMEOUT_MS\) === true/);
});

test('a DB outage cannot recursively amplify itself through settings telemetry writes',()=>{
  const catchAt=handler.indexOf('const databaseFailure =');
  const finishAt=handler.indexOf('console.error("market-autotrader failed"',catchAt);
  const block=handler.slice(catchAt,finishAt);
  assert.ok(block.includes('if (databaseFailure)'));
  assert.ok(block.includes('event: "DB_DEGRADED"'));
  const dbBranch=block.slice(block.indexOf('if (databaseFailure)'),block.indexOf('} else if (availabilityFailure)'));
  assert.equal(dbBranch.includes('loadSettings()'),false);
  assert.equal(dbBranch.includes('patch("trading_settings"'),false);
});

test('monitor and scan keep their separate safety lanes while each lane is single-flight',()=>{
  const monitorAt=handler.lastIndexOf('if (action === "monitor")');
  const scanAt=handler.lastIndexOf('if (action === "scan")');
  const monitor=handler.slice(monitorAt,scanAt);
  const scan=handler.slice(scanAt,handler.indexOf('await finishCycle(cycleId, "FAILED"',scanAt));
  assert.ok(monitorAt>=0&&scanAt>monitorAt);
  assert.ok(monitor.includes('await monitorCycle(cycleId, settings)'));
  assert.equal(monitor.includes('withLease('),false);
  assert.ok(scan.includes('await scanCycle(cycleId, settings)'));
  assert.equal(scan.includes('runWithContendedLease('),false);
});
