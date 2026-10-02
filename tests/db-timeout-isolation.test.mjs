import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireCycleLease } from '../supabase/functions/market-autotrader/cycle-lease-retry.mjs';
import { createTokenReader } from '../supabase/functions/doa-capture-ingest/token-read.mjs';

const lease = { name: 'autotrader-monitor', owner: 'fixed-owner', ttlSeconds: 150, timeoutMs: 1800, sleep: async () => {} };
test('normal lease has one call and busy lease never retries', async () => {
  let calls = 0;
  assert.equal(await acquireCycleLease(async () => { calls++; return true; }, lease), true);
  assert.equal(calls, 1);
  assert.equal(await acquireCycleLease(async () => { calls++; return false; }, lease), false);
  assert.equal(calls, 2);
});
test('an 800 ms lease response completes without retry', async () => {
  let calls = 0;
  const start = Date.now();
  assert.equal(await acquireCycleLease(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return true;
  }, lease), true);
  assert.equal(calls, 1);
  assert.ok(Date.now() - start >= 800);
});
test('concurrent owners cannot both pass a contended lease', async () => {
  let owner = null;
  const rpc = async (_name, args) => {
    if (owner && owner !== args.p_owner) return false;
    owner = args.p_owner;
    return true;
  };
  const result = await Promise.all([
    acquireCycleLease(rpc, { ...lease, owner: 'first' }),
    acquireCycleLease(rpc, { ...lease, owner: 'second' }),
  ]);
  assert.deepEqual(result, [true, false]);
});
test('uncertain production lease acknowledgement fails closed without immediate retry amplification', async () => {
  const seen = [];
  const rpc = async (_name, args, timeout) => {
    seen.push({ ...args, timeout });
    if (seen.length === 1) throw Error('Signal timed out.');
    return true;
  };
  await assert.rejects(acquireCycleLease(rpc, lease), /timed out/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].p_owner, lease.owner);
  await assert.rejects(acquireCycleLease(async () => { throw Error('Signal timed out.'); }, lease), /timed out/);
});
test('non-transient lease error never retries', async () => {
  let calls = 0;
  await assert.rejects(acquireCycleLease(async () => { calls++; throw Error('DATABASE 403'); }, lease), /403/);
  assert.equal(calls, 1);
});
test('token read singleflights concurrent requests, retries transient failures, and caches verified token', async () => {
  let reads = 0, time = 1000;
  const getToken = createTokenReader(async () => {
    reads++;
    if (reads === 1) throw Error('Signal timed out.');
    return 'verified';
  }, { now: () => time, sleep: async () => {} });
  assert.deepEqual(await Promise.all([getToken(), getToken(), getToken()]), ['verified', 'verified', 'verified']);
  assert.equal(reads, 2);
  time += 1000;
  assert.equal(await getToken(), 'verified');
  assert.equal(reads, 2);
});
test('token read never uses expired cache or retries authentication rejection', async () => {
  let reads = 0, time = 1;
  const getToken = createTokenReader(async () => {
    reads++;
    if (reads > 1) throw Error('DATABASE_401');
    return 'verified';
  }, { now: () => time, ttlMs: 100, sleep: async () => {} });
  assert.equal(await getToken(), 'verified');
  time = 102;
  await assert.rejects(getToken(), /401/);
  assert.equal(reads, 2);
});
