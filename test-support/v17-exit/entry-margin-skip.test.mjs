// A fully deployed account has no free margin for another 40 USDT slot. That is a normal
// state, not a fault, but openBull threw on it: the exception escaped run(), so the whole
// executor cycle returned 500 and set last_error, and the still-fresh signal was burned as
// REJECTED. 45 signals took that path on 2026-09-09 while a manual MAGMAUSDT position held
// ~55 USDT of margin.
//
// The gate itself must not move -- entering without the cash is what it exists to prevent.
// Only its failure MODE changes: skip gracefully and hand the claim back so a slot freeing
// inside the 120s entry window can still be used.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {POLICY, entryFresh} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';

const source = readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
// Use the real sizeEntry, so the margin figures under test are the production ones.
const sizeEntrySrc = source.slice(source.indexOf('function sizeEntry('), source.indexOf('async function closePos('));
const code = sizeEntrySrc + source.slice(source.indexOf('async function openBull('), source.indexOf('// Best-effort feed for the decision-only exit shadow.'));

const MARGIN = 40, LEV = 3, NOTIONAL = MARGIN * LEV;

function make({available}) {
  const now = Date.now();
  const features = {
    strategy: 'LEADER_MOMENTUM_V17', signal5Close: now - 1000, referenceClose: 100, atr: 1, bbPos: 0,
    exitPolicy: {stopPct: .025, trailArmPct: .03, trailGapPct: .015, staleMs: POLICY.staleMs, maxHoldMs: POLICY.maxHoldMs},
  };
  const ctx = {
    Date, Number, Math, Error, Promise, String, Object, console, POLICY, entryFresh,
    STRATEGY: 'LEADER_MOMENTUM_V17', MARGIN, LEV, NOTIONAL, MAX_SLOTS: 10,
    NOTIONAL_BUFFER_USDT: .12, MAX_MARGIN_BUFFER_USDT: .25, ENTRY_CASH_BUFFER_USDT: .10,
    SPREAD_MAX: 25, IOC_BASE_BPS: 3, IOC_MAX_BPS: 12,
    rec: x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    sym: p => String(p?.market ?? p?.symbol ?? '').toUpperCase(),
    ceilStep: (v, s) => Math.ceil(v / s) * s, addStep: (v, s) => v + s,
    floorStep: (v, s) => Math.floor(v / s) * s,
    cid: () => 'tb-v11e-x', terminal: () => false, fill: () => ({qty: 0, avg: 0, status: 'NEW'}),
    classifyPortfolio:()=>({ok:true}),readOpsOrders:async()=>[],opsGateway:()=>ctx.gateway,
    portfolioMatches: () => ({ok: true, ext: []}),
    manualPositionAllowances: async () => [],
    requireLeaderEntryControls: async () => {},
    circuit: async () => { throw Error('circuit must not open on a normal capital condition'); },
    verifyExecutionLease: async () => {},
    snap: async () => ({available_quote: available, ageMs: 0}),
    gateway: async c => {
      if (c.action === 'p10_portfolio') return {positions: [], positions_complete: true, available_quote: available};
      if (c.action === 'quote') return {best_bid: 99.9, best_ask: 100};
      if (c.action === 'symbol_info') return {quantity_step: 0.001, min_notional: 5};
      throw Error(`no order may be placed: ${c.action}`);
    },
  };
  Object.assign(ctx,{classifyPortfolio:()=>({ok:true}),readOpsOrders:async()=>[],opsGateway:()=>ctx.gateway});
  vm.createContext(ctx);
  vm.runInContext(code + ';this.openBull=openBull;', ctx);
  return {ctx, signal: {id: 's1', symbol: 'FORMUSDT', features}};
}

test('insufficient margin skips gracefully instead of throwing', async () => {
  const {ctx, signal} = make({available: 3.5});
  const out = await ctx.openBull({from: () => { throw Error('no DB write on a skip'); }}, signal, [], []);
  assert.equal(out.entered, false);
  assert.match(out.reason, /^ENTRY_MARGIN_INSUFFICIENT:3\.5000:40\./);
  assert.equal(out.releaseClaim, true, 'the claim must be handed back, not burned');
});

test('the gate still refuses to enter without the cash', async () => {
  // gateway() throws on any create_order, so reaching one would fail the test.
  const {ctx, signal} = make({available: 39.9 });
  const out = await ctx.openBull({from: () => { throw Error('no DB write on a skip'); }}, signal, [], []);
  assert.equal(out.entered, false);
  assert.equal(out.releaseClaim, true);
});

test('an unreadable balance is still a hard fault, not a skip', async () => {
  const {ctx, signal} = make({available: NaN});
  await assert.rejects(
    () => ctx.openBull({from: () => { throw Error('unreached'); }}, signal, [], []),
    /ENTRY_AVAILABLE_BALANCE_UNREADABLE/);
});

test('the executor hands a skipped claim back to NEW', async () => {
  const run = source.slice(source.indexOf('async function run(db)'), source.indexOf('async function requireLeaderEntryControls'));
  assert.match(run, /entry\?\.releaseClaim===true/, 'run() must react to the skip marker');
  assert.match(run, /status:"NEW"[\s\S]{0,120}\.eq\("status","CLAIMED"\)/,
    'the release must be a guarded CLAIMED -> NEW transition');
  // and it must not be routed through the reject path that burns the signal
  const releaseIdx = run.indexOf('releaseClaim===true');
  assert.ok(releaseIdx > 0 && releaseIdx < run.indexOf('catch(e)', releaseIdx),
    'the release runs on the success path, before the catch');
});
