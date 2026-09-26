/**
 * An order the gateway never sent must not hold the account forever.
 *
 * 2026-09-18, the first order the repaired entry pipeline produced:
 *
 *   10:21:09  DYDXUSDT OPEN_LONG, 691.5 @ 3x, notional 90.1716, intent persisted
 *   10:21:09  GW_400: Binance futures entry requires at least 40 USDT margin
 *             (120 USDT notional at 3x); got 90.1716      <- the gateway's OWN floor,
 *                                                            refused before signing
 *                                                            any Binance request
 *   10:21:10  order -> RECONCILIATION_FAILED, circuit opened, ACCOUNT_ENTRY_HOLD
 *   10:22:05  incident KNOWN_ORDER_PENDING_RECONCILIATION, generation 112
 *   11:10:08  still held. Flat DB, flat exchange, 38.369902 USDT untouched, and
 *             reconcileOps re-querying the same non-existent order every minute.
 *
 * The deadlock is structural: reconciliation asks Binance about the order, Binance
 * answers -2013 "Order does not exist", and that THROWS -- correctly, because for an
 * order that really was sent, -2013 proves nothing. So riskOrders never empties,
 * recoveryEvidence is never eligible, and the circuit never closes.
 *
 * The escape below is proof, not assumption, and these tests pin every way it must
 * refuse to give one. Nothing here relaxes the ambiguity handling: an entry whose
 * outcome is genuinely unknown still halts the account, which is the whole point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {retryProofCandidate} from '../../supabase/functions/v10-lane-executor/entry-retry-reconciliation.mjs';

const SRC = readFileSync(
  new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
const FN = SRC.slice(SRC.indexOf('const NEVER_PLACED_PROOF_MAX_AGE_MS'),
  SRC.indexOf('async function reconcileOps('));

/** settleNeverPlacedEntry, lifted into a sandbox with its collaborators stubbed. */
function harness({ proof, proofThrows = null, fatal = () => ({ fatal: false }) }) {
  const writes = [];
  const audits = [];
  const table = (name) => {
    const st = { patch: null, filters: {} };
    const b = {
      update: (patch) => { st.patch = patch; return b; },
      eq: (k, v) => { st.filters[k] = v; return b; },
      neq: (k, v) => { st.filters['neq:' + k] = v; return b; },
      insert: async (row) => { writes.push({ table: name, insert: row }); return { error: null }; },
      then: (resolve, reject) => {
        writes.push({ table: name, patch: st.patch, filters: { ...st.filters } });
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  const ctx = {
    Number, Math, Date, String, Object, Error, Promise, JSON, console,
    retryProofCandidate,
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    rec: (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    classifyFailure: fatal,
    verifyExecutionLease: async () => {},
    audit: async (...a) => { audits.push(a); },
    db: { from: table },
    gw: async (cmd) => {
      if (proofThrows) throw Object.assign(Error(proofThrows), { name: 'Error' });
      ctx.lastCommand = cmd;
      return proof;
    },
    writes, audits, lastCommand: null,
  };
  vm.createContext(ctx);
  vm.runInContext(FN, ctx);
  return ctx;
}

const PROVEN = {
  proven: true, found: false, lookup_code: -2013, position_quantity: 0,
  recent_trade_count: 0, position_read_ok: true, trade_read_ok: true,
  source: 'BINANCE_FUTURES_ORDER_AND_POSITION_REST', observed_at_ms: 1789726869000,
};

const ORDER = {
  id: '8a196874-bd24-436e-a15e-0105395f14a1',
  signal_id: 'sig-dydx',
  symbol: 'DYDXUSDT',
  intent: 'OPEN_LONG',
  state: 'RECONCILIATION_FAILED',
  exchange_order_id: null,
  client_order_id: 'tb-v11e-92df114d5fc748699f89c8fc',
  created_at: new Date(Date.now() - 45 * 60_000).toISOString(),
  reject_reason: 'GW_400:Binance futures entry requires at least 40 USDT margin ' +
    '(120 USDT notional at 3x); got 90.1716',
  response_payload: {},
};
const NOT_FOUND = Error('GW_400:-2013 Order does not exist.');

test('the exact production intent settles once the exchange proves it never existed', async () => {
  const ctx = harness({ proof: PROVEN });
  const out = await ctx.settleNeverPlacedEntry(ctx.db, ORDER, NOT_FOUND, ctx.gw);
  assert.equal(out.outcome, 'RESOLVED');
  assert.equal(out.reason, 'ORDER_NEVER_PLACED');
  assert.equal(out.executedQuantity, 0, 'settlement must book no fill');
  assert.equal(out.accountingComplete, true);
  // It asked the exchange about this exact identity, read-only.
  // Compared field by field: the command is built inside the vm realm, so its
  // prototype is not this realm's Object.
  assert.equal(ctx.lastCommand.action, 'v18_entry_never_placed_proof');
  assert.equal(ctx.lastCommand.market, 'DYDXUSDT');
  assert.equal(ctx.lastCommand.identifier, 'tb-v11e-92df114d5fc748699f89c8fc');
  assert.deepEqual(Object.keys(ctx.lastCommand).sort(),
    ['action', 'identifier', 'market'], 'the proof command carries nothing else');
  const order = ctx.writes.find(w => w.table === 'v11_long_regime_orders');
  assert.equal(order.patch.state, 'REJECTED');
  assert.match(order.patch.reject_reason, /^ORDER_NEVER_PLACED:GW_400/);
  // v18ExposureFinal is what riskOrders reads; it is the flag that lets the account
  // resume, so it must be written only together with the evidence that earned it.
  assert.equal(order.patch.response_payload.v18ExposureFinal, true);
  assert.equal(order.patch.response_payload.v18EntryNeverPlaced.neverPlaced, true);
  assert.equal(order.patch.response_payload.v18EntryNeverPlaced.positionQuantity, 0);
  assert.equal(order.patch.response_payload.v18EntryNeverPlaced.lookupCode, -2013);
  // CAS on the state it read, so a concurrent transition cannot be overwritten.
  assert.equal(order.filters.state, 'RECONCILIATION_FAILED');
  assert.equal(order.filters.id, ORDER.id);
  // No position is created anywhere.
  assert.ok(!ctx.writes.some(w => w.table === 'v11_long_regime_positions'));
  // The signal is retired so the candidate is not re-offered and re-refused.
  const signal = ctx.writes.find(w => w.table === 'v11_long_regime_signals');
  assert.equal(signal.patch.status, 'REJECTED');
  assert.equal(signal.filters.id, 'sig-dydx');
  assert.equal(ctx.audits.at(-1)[5], 'ORDER_NEVER_PLACED');
});

test('an exit intent is never settled this way', async () => {
  // A position may be live and unprotected; refusing to reconcile it must keep the
  // account held. That is the opposite risk and it wins.
  for (const intent of ['CLOSE_LONG', 'PARTIAL_CLOSE']) {
    const ctx = harness({ proof: PROVEN });
    assert.equal(await ctx.settleNeverPlacedEntry(ctx.db, { ...ORDER, intent }, NOT_FOUND, ctx.gw), null);
    assert.equal(ctx.writes.length, 0);
  }
});

test('an order the exchange ever acknowledged is never settled this way', async () => {
  const ctx = harness({ proof: PROVEN });
  const acked = { ...ORDER, exchange_order_id: '123456789' };
  assert.equal(await ctx.settleNeverPlacedEntry(ctx.db, acked, NOT_FOUND, ctx.gw), null);
  assert.equal(ctx.writes.length, 0);
});

test('only a DEFINITIVE not-found opens this path', async () => {
  for (const message of [
    'GW_500:internal error',
    'GW_408:timed out',
    'GW_401:Signature for this request is not valid',
    'FetchError: network',
    'GW_400:-1021 Timestamp for this request is outside of the recvWindow',
  ]) {
    const ctx = harness({ proof: PROVEN });
    assert.equal(await ctx.settleNeverPlacedEntry(ctx.db, ORDER, Error(message), ctx.gw), null,
      `${message} must stay unknown`);
    assert.equal(ctx.writes.length, 0);
  }
});

test('an intent older than the retention window cannot use a not-found as proof', async () => {
  // Binance answers -2013 for BOTH "never accepted" and "too old to query". The age
  // bound is what keeps those apart; without it this path would eventually settle a
  // real order that had simply aged out.
  const max = Number(SRC.match(/const NEVER_PLACED_PROOF_MAX_AGE_MS=([^;]+);/)[1]
    .replace(/[^\d*]/g, '').split('*').reduce((a, b) => a * Number(b), 1));
  assert.ok(max > 0 && max <= 24 * 3600_000, `${max}ms must be well inside Binance retention`);
  const ctx = harness({ proof: PROVEN });
  const old = { ...ORDER, created_at: new Date(Date.now() - max - 60_000).toISOString() };
  assert.equal(await ctx.settleNeverPlacedEntry(ctx.db, old, NOT_FOUND, ctx.gw), null);
  assert.equal(ctx.writes.length, 0);
});

test('a proof short of proven leaves the order exactly where it is', async () => {
  const partials = [
    { ...PROVEN, proven: false },
    { ...PROVEN, found: null },
    { ...PROVEN, found: true },
    { ...PROVEN, position_quantity: 691.5 },
    { ...PROVEN, position_quantity: null, position_read_ok: false },
    { ...PROVEN, trade_read_ok: false },
  ];
  for (const proof of partials) {
    const ctx = harness({ proof });
    const out = await ctx.settleNeverPlacedEntry(ctx.db, ORDER, NOT_FOUND, ctx.gw);
    assert.equal(out.outcome, 'UNRESOLVED', JSON.stringify(proof));
    assert.equal(out.reason, 'NEVER_PLACED_NOT_PROVEN');
    assert.equal(out.evidenceSecured, false);
    assert.equal(ctx.writes.length, 0, 'nothing may be written without the full proof');
  }
});

test('an unreachable gateway reports the failure and settles nothing', async () => {
  const ctx = harness({ proof: PROVEN, proofThrows: 'GW_502:bad gateway' });
  const out = await ctx.settleNeverPlacedEntry(ctx.db, ORDER, NOT_FOUND, ctx.gw);
  assert.match(out.error, /^NEVER_PLACED_PROOF_UNAVAILABLE:/);
  assert.equal(ctx.writes.length, 0);
});

test('a fatal failure still propagates rather than being absorbed', async () => {
  const ctx = harness({
    proof: PROVEN, proofThrows: 'LEASE_LOST', fatal: () => ({ fatal: true }),
  });
  await assert.rejects(() => ctx.settleNeverPlacedEntry(ctx.db, ORDER, NOT_FOUND, ctx.gw),
    /LEASE_LOST/);
  assert.equal(ctx.writes.length, 0);
});

test('reconcileOps routes its failures here instead of only logging them', () => {
  const ops = SRC.slice(SRC.indexOf('async function reconcileOps('));
  assert.match(ops, /const settled=await settleNeverPlacedEntry\(db,o,e,gw\);/);
  assert.match(ops, /results\.push\(settled\?\?\{orderId:o\.id,error:String\(e\.message\?\?e\)\}\);/,
    'an unproven order must still be reported as the error it was');
  // The fatal check still runs first: a lost lease is not a reconciliation outcome.
  const at = ops.indexOf('settleNeverPlacedEntry');
  assert.ok(ops.indexOf('if(classifyFailure(e).fatal)throw e;') < at && at > 0);
});

test('the account resumes through the ordinary recovery gate, not around it', () => {
  // Settlement only clears riskOrders. Closing the circuit is still recoveryEvidence's
  // decision, under the operator flags, a matching portfolio and protected positions.
  assert.ok(!SRC.includes('circuit_open:false'), 'nothing here may write circuit_open');
  assert.ok(!/settleNeverPlacedEntry[\s\S]{0,2000}v19_account_recovery_observation/.test(SRC),
    'settlement must not call the recovery CAS itself');
  const isolation = readFileSync(new URL(
    '../../supabase/functions/_shared/leader-ops-isolation.mjs', import.meta.url), 'utf8');
  assert.match(isolation, /'RECONCILIATION_FAILED','RECONCILIATION_PENDING'\]\.includes\(o\.state\)&&\s*\n?\s*o\.response_payload\?\.v18ExposureFinal!==true/,
    'v18ExposureFinal is exactly what removes a settled order from riskOrders');
});
