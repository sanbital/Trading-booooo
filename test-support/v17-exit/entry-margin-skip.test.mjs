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
import {SLOT_SIZING_CONTRACT, ceilStep, ceilTick, floorStep, planSlotEntry, slotSizingBounds}
  from '../../supabase/functions/_shared/leader-slot-sizing.mjs';
import {ENFORCEMENT as BOO_ENFORCEMENT, evaluateBooEntry, finalizeBooEntry, loadBooGateContext,
  openRiskSummary, recordBooVerdict} from '../../supabase/functions/v10-lane-executor/boo-entry-adapter.mjs';
import {V24_ADAPTER_VERSION, v24EntryGate} from '../../supabase/functions/v10-lane-executor/v24-entry-adapter.mjs';
import {E1_POLICY} from '../../supabase/functions/_shared/leader-e1-runtime.mjs';
import * as pullbackSetup from '../../supabase/functions/_shared/leader-pullback-reaccel.mjs';
import {R1_VERSION} from '../../supabase/functions/_shared/boo/r1-strategy.mjs';
import {RISK_POLICY_VERSION} from '../../supabase/functions/_shared/boo/risk-policy.mjs';
import {RISK_BUDGET_VERSION} from '../../supabase/functions/_shared/boo/risk-budget.mjs';

const source = readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
// Use the real sizeEntry and the real gate helpers openBull calls, so the margin
// figures under test are the production ones rather than a copy of them.
const sizeEntrySrc = source.slice(source.indexOf('function symbolFilters('), source.indexOf('// --- BOO common entry gate'));
// The BOO gate block through booGate itself: openBull calls into all of it.
const gateSrc = source.slice(source.indexOf('// --- BOO common entry gate'), source.indexOf('async function openBull('));
const code = sizeEntrySrc + gateSrc +
  source.slice(source.indexOf('async function openBull('), source.indexOf('// Best-effort feed for the decision-only exit shadow.'));

// Slot geometry comes from the contract, like the executor's own does, so this
// harness cannot drift from production the way the four copies of it once did.
const MARGIN = SLOT_SIZING_CONTRACT.targetMarginUsdt, LEV = SLOT_SIZING_CONTRACT.leverage,
  NOTIONAL = MARGIN * LEV, MAX_ORDER_MARGIN_USDT = slotSizingBounds(SLOT_SIZING_CONTRACT).maxOrderMarginUsdt;

function make({available, setupCutover = Number.MAX_SAFE_INTEGER}) {
  const now = Date.now();
  const features = {
    strategy: 'LEADER_MOMENTUM_V17', signal5Close: now - 1000, referenceClose: 100, atr: 1, bbPos: 0,
    exitPolicy: {stopPct: .025, trailArmPct: .03, trailGapPct: .015, staleMs: POLICY.staleMs, maxHoldMs: POLICY.maxHoldMs},
  };
  const ctx = {
    Date, Number, Math, Error, Promise, String, Object, console, POLICY, entryFresh,
    STRATEGY: 'LEADER_MOMENTUM_V17', MARGIN, LEV, NOTIONAL, MAX_SLOTS: 10,
    MAX_ORDER_MARGIN_USDT, ENTRY_CASH_BUFFER_USDT: .10,
    SPREAD_MAX: 25, IOC_BASE_BPS: SLOT_SIZING_CONTRACT.iocBaseBps,
    IOC_MAX_BPS: SLOT_SIZING_CONTRACT.iocMaxBps,
    SLOT_SIZING_CONTRACT, planSlotEntry, slotSizingBounds, ceilTick,
    RELEASE_SCOPE: {SYMBOL: 'SYMBOL', ACCOUNT: 'ACCOUNT'},
    CONTROL_SCOPE: {SYMBOL_QUARANTINE: 'SYMBOL_QUARANTINE'},
    // The executor's module top level is not evaluated here -- only openBull is --
    // so the gates it calls are stubbed at their real signatures. BOO observes.
    BOO_ENFORCEMENT, evaluateBooEntry, finalizeBooEntry, loadBooGateContext, openRiskSummary,
    recordBooVerdict, V24_ADAPTER_VERSION, v24EntryGate,
    R1_VERSION, RISK_POLICY_VERSION, RISK_BUDGET_VERSION, E1_POLICY, crypto, TextEncoder,
    NATIVE_STOP_ENABLED: false, REVISION: 'V11-LONG-REGIME-1.0.1', PATCH: 'TEST',
    ...pullbackSetup, setupIsTerminal: pullbackSetup.isTerminal,
    // These fixtures exercise the LEGACY immediate-entry path -- the capital and
    // balance rules, which are shared by both entry timings. Putting the cutover
    // beyond every fixture is how a signal is made legacy; `setupCutover` below
    // moves it so the same harness can drive the pullback path too.
    SETUP_LIVE_CUTOVER: setupCutover,
    SETUP_MAX_CONCURRENT: 2,
    ENTRY_EXECUTION_POLICY_VERSION: 'TEST', MAX_GAP_ATR: .5, QV3_VERSION: 'TEST',
    QV3_ACTIVATION_BASIS: 'TEST', X1_POLICY_VERSION: 'TEST', EXIT_REVIEW_R5: {policyVersion: 'TEST'},
    // BOO reads the operator's control rows. OBSERVE is the production posture.
    opsControls: async () => ({runtime: {circuit_open: false}, settings: {mode: 'LIVE_LIMITED'},
      operator: {entry_enabled: true}}),
    audit: async () => {}, active: p => (Array.isArray(p?.positions) ? p.positions : []),
    V24_ENTRY_GATE_ENABLED: false, E1_ENABLED: false, X1_ENABLED: false,
    QV3_LIVE_CUTOVER: null, OPERATOR_OVERRIDE: {basis: 'TEST'},
    Deno: {env: {get: () => undefined}},
    rec: x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    sym: p => String(p?.market ?? p?.symbol ?? '').toUpperCase(),
    active: p => Array.isArray(p?.positions) ? p.positions : [],
    // The real rounding, not a re-implementation of it.
    ceilStep, floorStep,
    cid: () => 'tb-v11e-x', terminal: () => false, fill: () => ({qty: 0, avg: 0, status: 'NEW'}),
    classifyPortfolio:()=>({ok:true}),readOpsOrders:async()=>[],opsGateway:()=>ctx.gateway,
    readOpsPair:async()=>({pf:{positions:[],positions_complete:true,available_quote:available,total_equity_quote:available,
      total_initial_margin_quote:0},positions:[],manual:[],orders:[],quarantines:[],match:{ok:true,issues:[],accounting:[]}}),
    withCandidateOrders:async(_db,pair)=>pair,
    decideEntry:async()=>({allowed:true,scope:'NORMAL',reasons:[],evidence:{}}),persistDecisionRisk:async()=>{},
    recordMismatch:async()=>[],
    portfolioMatches: () => ({ok: true, ext: []}),
    manualPositionAllowances: async () => [],
    requireLeaderEntryControls: async () => {},
    circuit: async () => { throw Error('circuit must not open on a normal capital condition'); },
    verifyExecutionLease: async () => {},
    snap: async () => ({available_quote: available, ageMs: 0}),
    gateway: async c => {
      if (c.action === 'p10_portfolio') return {positions: [], positions_complete: true, available_quote: available};
      if (c.action === 'v18_open_orders') return {complete:true,orders:[],algos:[],observed_at_ms:Date.now()};
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

// The BOO gate observes every admission and records its verdict before sizing is
// even reached, so a DB that throws on ANY access no longer isolates the capital
// path. This stub keeps the property the tests are actually about -- a capital
// shortfall writes no ORDER and no SIGNAL state -- while letting the gate observe.
function observeOnlyDb(enforcement = 'OBSERVE') {
  const forbidden = ['v11_long_regime_orders', 'v11_long_regime_positions', 'v11_long_regime_signals'];
  const rows = {boo_entry_gate_control: {singleton: true, enforcement}};
  function builder(table) {
    const b = {
      select: () => b, eq: () => b, gte: () => b, order: () => b, limit: () => b,
      insert: () => b, update: () => b, upsert: () => b,
      maybeSingle: async () => ({data: rows[table] ?? null, error: null}),
      single: async () => ({data: rows[table] ?? null, error: null}),
      then: (res, rej) => Promise.resolve({data: [], error: null}).then(res, rej),
    };
    return b;
  }
  return {from: (table) => {
    if (forbidden.includes(table)) throw Error(`no ${table} write on a capital skip`);
    return builder(table);
  }};
}

test('insufficient margin skips gracefully instead of throwing', async () => {
  const {ctx, signal} = make({available: 3.5});
  const out = await ctx.openBull(observeOnlyDb(), signal, [], []);
  assert.equal(out.entered, false);
  assert.match(out.reason, new RegExp(`^ENTRY_MARGIN_INSUFFICIENT:3\\.5000:${MARGIN}\\.`));
  assert.equal(out.releaseClaim, true, 'the claim must be handed back, not burned');
  // And it is the ACCOUNT's answer: no other symbol can do better this cycle, so
  // this one release must still end the run.
  assert.notEqual(out.releaseScope, 'SYMBOL', 'a capital shortfall is account-wide');
});

test('the gate still refuses to enter without the cash', async () => {
  // gateway() throws on any create_order, so reaching one would fail the test.
  const {ctx, signal} = make({available: MARGIN - 0.1});
  const out = await ctx.openBull(observeOnlyDb(), signal, [], []);
  assert.equal(out.entered, false);
  assert.equal(out.releaseClaim, true);
});

test('an unreadable balance is still a hard fault, not a skip', async () => {
  const {ctx, signal} = make({available: NaN});
  await assert.rejects(() => ctx.openBull(observeOnlyDb(), signal, [], []),
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

test('once the cutover has passed, an untriggered signal cannot enter at all', async () => {
  // The same fixture that enters on the legacy path is refused on the pullback path
  // until its setup has actually triggered. This is the load-bearing property of the
  // whole change: a leader signal no longer buys on sight.
  const {ctx, signal} = make({available: 500, setupCutover: 0});
  await assert.rejects(() => ctx.openBull(observeOnlyDb(), signal, [], []),
    /V17_SETUP_NOT_TRIGGERED/);
});
