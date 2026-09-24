// Every signal from one 5m bar expires together at signal5Close+120s, but the executor runs
// once a minute and used to price exactly one candidate per run. So one refusal killed the
// whole bar: on 2026-09-09 13:30 IOSTUSDT no-filled at 13:31, and BULLAUSDT and XTZUSDT were
// then rejected as stale at 13:32 and 13:33 without ever being priced. 44 signals died that
// way over two days.
//
// (2026-09-25) A run now opens as many positions as the account has capacity for: GPT BUY
// candidates are admitted one at a time and the account is read again after every fill
// (entry-capacity.mjs). The stop conditions are pinned as hard as the continue conditions: an
// account-wide refusal, an unreadable account after a fill, no capacity, or a cycle budget that
// cannot finish another attempt all end the run, and a dispatched failure still halts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8').replace(/\r\n/g,'\n');
const run = source.slice(source.indexOf('async function run(db)'), source.indexOf('async function requireLeaderEntryControls'));

test('the run admits by capacity and the cycle budget, never by a fixed attempt count', () => {
  assert.ok(!/ENTRY_ATTEMPTS_PER_RUN/.test(source), 'no fixed number of attempts per run');
  assert.match(run, /if\(cap\.capacity<1&&/, 'account capacity bounds the run');
  assert.match(run, /budgetCovers\(cycleBudgets\.get\(db\),ENTRY_ATTEMPT_RESERVE\)/,
    'a new attempt starts only when the lease budget can finish it');
  const reserve = source.match(/const ENTRY_ATTEMPT_RESERVE=Object\.freeze\(\{ms:(\d+),calls:(\d+)\}\);/);
  assert.ok(reserve, 'the attempt reserve is declared');
  const lease = source.match(/cycleBudgets\.set\(db,createBudget\(\{ms:(\d+),calls:(\d+)\}\)\)/);
  assert.ok(Number(reserve[1]) < Number(lease[1]) && Number(reserve[2]) < Number(lease[2]),
    'one attempt fits inside one cycle budget');
  // The wall clock still bounds the run as well: an E1 fast-weak watch can wait per attempt.
  assert.match(run, /Date\.now\(\)>=runDeadline/, 'the run needs a wall-clock bound too');
  const budget = Number(source.match(/const ENTRY_RUN_BUDGET_MS=(\d+);/)[1]);
  assert.ok(budget > 0 && budget < 60000, `${budget}ms must fit inside the cadence`);
});

test('a symbol never occupies more than one place in the queue', () => {
  // Otherwise a symbol that keeps re-signalling holds every attempt of the cycle
  // while other symbols wait, which is the same starvation by another route.
  assert.match(run, /seenSymbols\.has\(key\)/);
  assert.match(run, /SUPERSEDED_BY_FRESHER_SIGNAL/,
    'the older duplicates must be retired, not left NEW to come back next cycle');
});

test('already-expired candidates are retired without any gateway work', () => {
  // The age policy itself is untouched: POLICY.maxEntryAgeMs, same comparison
  // entryFresh makes. Only the cost of reaching the verdict changes.
  assert.match(run, /now-close>POLICY\.maxEntryAgeMs/);
  const stale = run.indexOf('POLICY.maxEntryAgeMs');
  const claim = run.indexOf('status:"CLAIMED"');
  assert.ok(stale > 0 && stale < claim,
    'expiry must be checked before a candidate is claimed and priced');
});

test('a soft defer stops the run only when it was the ACCOUNT that refused', () => {
  assert.match(run, /if\(releaseStopsRun\(entry\)\)\{stop=\{reason:accountStopReason\(entry\.reason\)[^\n]*\n\s*await noteRest\(index\+1,[^\n]*break\}/);
  assert.match(source, /function releaseStopsRun\(entry\)\{return entry\?\.releaseScope!==RELEASE_SCOPE\.SYMBOL\}/,
    'an unlabelled release must keep the old halting behaviour -- fail closed');
  // Every account-wide refusal must stay unlabelled or explicitly ACCOUNT.
  const open = source.slice(source.indexOf('async function openBull('));
  for (const accountWide of ['ENTRY_MARGIN_INSUFFICIENT', 'PORTFOLIO_CHANGED_DURING_E1']) {
    const at = open.indexOf(accountWide);
    assert.ok(at > 0, `${accountWide} must still exist`);
    const tail = open.slice(at, open.indexOf('}', open.indexOf('releaseClaim:true', at)));
    assert.ok(!/releaseScope:RELEASE_SCOPE\.SYMBOL/.test(tail),
      `${accountWide} is account-wide and must not be marked symbol-scoped`);
  }
});

test('candidates are ordered newest bar first, then by scanner rank', () => {
  assert.match(run, /Date\.parse\(b\.entry_bar_at\)-Date\.parse\(a\.entry_bar_at\)\|\|N\(rec\(a\.features\)\.rank,999\)-N\(rec\(b\.features\)\.rank,999\)/,
    'a bar’s strongest leader must be priced before its weaker ones');
});

test('a dispatched order always stops the run', () => {
  // The load-bearing safety property: once an order has left the process we cannot know
  // whether a position exists, so no second entry may be attempted.
  assert.match(run, /if\(attempt\.dispatched\)throw e;/);
  const idx = run.indexOf('if(attempt.dispatched)throw e;');
  const scoped = run.indexOf('ENTRY_SKIP_SYMBOL_SCOPED.test(msg)');
  assert.ok(idx > 0 && scoped > idx,
    'the dispatched guard must be evaluated BEFORE the symbol-scoped allowance');
});

test('openBull marks dispatch at the order call, not earlier or later', () => {
  const open = source.slice(source.indexOf('async function openBull('), source.indexOf('// Best-effort feed for the decision-only exit shadow.'));
  assert.match(open, /attempt\.dispatched=true;\s*const first=await dispatchEntryIocAttempt\(db,s,gateway/,
    'the flag must be set immediately before the first IOC attempt');
  const flag = open.indexOf('attempt.dispatched=true');
  // everything that can refuse an entry without sending anything must come first
  for (const pre of ['ENTRY_SPREAD', 'QTY_INVALID', 'ENTRY_MARGIN_INSUFFICIENT', 'ENTRY_GRANULARITY_BPS']) {
    assert.ok(open.indexOf(pre) < flag, `${pre} must be raised before dispatch`);
  }
  // and the post-fill validations must come after, so they can never be treated as skippable
  for (const post of ['STOP_POLICY_INVALID', 'STOP_INVALID']) {
    const settle=source.slice(source.indexOf('async function settleKnownEntry('),source.indexOf('async function readOpsPositions('));
    assert.ok(open.indexOf('settleKnownEntry(db,first.oi,first.settledRaw,gateway')>flag&&settle.includes(post), `${post} is checked in post-dispatch settlement`);
  }
});

test('post-fill failures are never in the symbol-scoped skip list', () => {
  const re = source.match(/const ENTRY_SKIP_SYMBOL_SCOPED=(\/\^\([^;]+\)\/);/)[1];
  for (const post of ['STOP_POLICY_INVALID', 'STOP_INVALID', 'IOC_PENDING', 'EXCHANGE_MISMATCH',
                      'EXTERNAL_POSITION', 'ENTRY_AVAILABLE_BALANCE_UNREADABLE', 'V17_EXECUTION_LEASE_EXPIRED']) {
    assert.ok(!re.includes(post), `${post} must not be skippable`);
  }
});

test('the symbol-scoped list matches only pre-dispatch refusals it declares', () => {
  const src = source.match(/const ENTRY_SKIP_SYMBOL_SCOPED=(\/\^\([^;]+\)\/);/)[1];
  const re = new RegExp(src.slice(1, src.lastIndexOf('/')));
  for (const ok of ['SIGNAL_STALE_OR_FUTURE', 'ENTRY_DRIFT', 'ENTRY_SPREAD:412', 'QTY_INVALID',
                    'MANUAL_SYMBOL_LOCKED', 'ENTRY_GRANULARITY_BPS:14.2']) {
    assert.ok(re.test(ok), `${ok} should let the next candidate be priced`);
  }
  for (const halt of ['STOP_INVALID', 'IOC_PENDING:NEW', 'EXTERNAL_POSITION',
                      'ENTRY_AVAILABLE_BALANCE_UNREADABLE', 'GATEWAY_CONFIG', 'POSITION:boom']) {
    assert.ok(!re.test(halt), `${halt} must halt the run`);
  }
});

test('a fill re-reads the account and continues; an exhausted account stops the queue', () => {
  const at = run.indexOf('if(entry?.entered===true){');
  assert.ok(at > 0);
  const block = run.slice(at, run.indexOf('continue;', at) + 'continue;'.length);
  const book = block.indexOf('ledger.push(ledgerEntry(entry,Date.now()))'), refresh = block.indexOf('refreshCapacityInputs(db)');
  assert.ok(book > 0 && refresh > book, 'the fill is booked before the account is read again');
  assert.match(block, /catch\(error\)\{[\s\S]*ACCOUNT_SAFETY_BLOCK[\s\S]*break;/, 'an unreadable account after a fill fails closed');
  assert.ok(!/openBull|status:"CLAIMED"/.test(block), 'nothing is priced before the next loop turn re-checks capacity');
  const rel = run.indexOf('releaseClaim===true');
  const tail = run.slice(rel, run.indexOf('continue;', rel));
  assert.ok(tail.includes('break'), 'insufficient capital must stop the queue, not retry per symbol');
  assert.ok(tail.includes('status:"NEW"'), 'the claim must be released');
});

test('a claim race skips that candidate rather than ending the run', () => {
  assert.match(run, /if\(!cl\.data\)\{entry=\{entered:false,reason:"CLAIM_RACE"\};continue\}/);
});

// The static assertions above pin structure. This one runs the real run() loop, because a
// misplaced edit inside closePos (which shares openBull's dispatch line verbatim) once put
// `attempt.dispatched=true` where no `attempt` exists -- a ReferenceError on every exit that
// only an executing test catches.
import vm from 'node:vm';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {SETUP_POLICY, SETUP_REASON, SETUP_STATE, isTerminal as setupIsTerminal}
  from '../../supabase/functions/_shared/leader-pullback-reaccel.mjs';
import {lifecycleNote, gptTerminalReason} from '../../supabase/functions/v10-lane-executor/entry-lifecycle.mjs';
import * as capacity from '../../supabase/functions/v10-lane-executor/entry-capacity.mjs';
import {CONTROL_SCOPE} from '../../supabase/functions/_shared/leader-entry-control.mjs';
import {SLOT_SIZING_CONTRACT, slotSizingBounds} from '../../supabase/functions/_shared/leader-slot-sizing.mjs';

/** A fixed clock, so a test's verdict never depends on when the suite is run. */
function clockAt(fixed) {
  return new Proxy(Date, { get: (t, k) => (k === "now" ? () => fixed : Reflect.get(t, k)) });
}
/** Current entry candidates carry a triggered setup; legacy rows are retired by B06133. */
const LEGACY_CLOSE = Date.parse("2026-09-17T12:00:00.000Z");
const LEGACY_NOW = LEGACY_CLOSE + 30_000;
/** Post-cutover: these are governed by the pullback setup. */
const SETUP_CLOSE = Date.parse("2026-09-17T12:00:00.000Z");
const SETUP_NOW = SETUP_CLOSE + 30_000;

/** A Binance account kept in step with the fills the stubbed openBull makes: the executor's own
 * capacity helpers read it through readOpsPair/snap exactly as they read production. `lag` freezes
 * the exchange view, the DB view and the snapshot at their initial state (nothing a fill did is
 * visible), so only the run's own ledger can keep a filled slot from looking free. */
function accountModel({available = 10_000, open = [], pending = [], issues = [], lag = false, feeUsdt = 0.5} = {}) {
  const m = {available, positions: open.map(symbol => ({symbol, quantity: 1})),
    db: open.map(symbol => ({symbol, state: 'OPEN'})), orders: [...pending], issues, lag, reads: 0, fail: null, fills: []};
  const initial = {available, positions: [...m.positions], db: [...m.db]};
  m.fill = (symbol, margin) => {
    m.fills.push({symbol, margin});
    m.available -= margin + feeUsdt;
    m.positions.push({symbol, quantity: 1});
    m.db.push({symbol, state: 'OPEN'});
  };
  m.pair = () => ({pf: {available_quote: m.lag ? initial.available : m.available, positions: m.lag ? initial.positions : m.positions},
    positions: m.lag ? initial.db : m.db, orders: m.orders, match: {issues: m.issues}});
  // The account snapshot job: fresh (captured now, after every fill so far) unless lagging.
  m.snapshot = () => ({available_quote: m.lag ? initial.available : m.available,
    captured_at: new Date(m.lag ? 0 : m.clock?.now ?? 0).toISOString()});
  return m;
}
// The executor's own capacity constants, read from its source so the harness cannot drift.
const constOf = (re) => { const m = source.match(re); if (!m) throw new Error('constant moved: ' + re); return m; };
const MAX_SLOTS = Number(constOf(/const MAX_SLOTS=(\d+),ENTRY_CASH_BUFFER_USDT=/)[1]);
const CASH_BUFFER = Number(constOf(/ENTRY_CASH_BUFFER_USDT=([\d.]+),/)[1]);
const ATTEMPT_RESERVE = (([, ms, calls]) => ({ms: Number(ms), calls: Number(calls)}))(
  constOf(/const ENTRY_ATTEMPT_RESERVE=Object\.freeze\(\{ms:(\d+),calls:(\d+)\}\);/));
const FEE_RATE = Number(constOf(/ENTRY_SLOT_COST_USDT=slotCostUsdt\(\{maxOrderMarginUsdt:MAX_ORDER_MARGIN_USDT,leverage:LEV,takerFeeRate:([\d.]+),iocMaxBps:IOC_MAX_BPS\}\)/)[1]);
const SLOT_COST = capacity.slotCostUsdt({maxOrderMarginUsdt: slotSizingBounds(SLOT_SIZING_CONTRACT).maxOrderMarginUsdt,
  leverage: SLOT_SIZING_CONTRACT.leverage, takerFeeRate: FEE_RATE, iocMaxBps: SLOT_SIZING_CONTRACT.iocMaxBps});

function harness({outcomes, rows: extraRows = null, now = LEGACY_NOW, setups = {}, setupMaxConcurrent = MAX_SLOTS,
  reviews = null, followUp = false, account = null, budget = null, policyOpen = 0}) {
  const seen = [];
  const audits = [];
  const notes = [];
  const terminals = [];
  const attempts = [];
  const model = account ?? accountModel();
  let inFlight = 0, maxInFlight = 0;
  // A clock the stubs can move: a slow first entry is what closes a later candidate's window.
  const clock = {now};
  model.clock = clock;
  // signal5Close is now load-bearing: the queue retires already-expired candidates
  // before claiming them, so a fixture must be inside POLICY.maxEntryAgeMs to be
  // priced at all. `bar` shifts a row's age for the expiry tests below.
  const fresh = LEGACY_CLOSE;
  const rows = extraRows ?? [
    {id: 'a', symbol: 'IOSTUSDT', entry_bar_at: '2026-09-09T13:30:00Z', features: {rank: 1, signal5Close: fresh}},
    {id: 'b', symbol: 'BULLAUSDT', entry_bar_at: '2026-09-09T13:30:00Z', features: {rank: 6, signal5Close: fresh}},
    {id: 'c', symbol: 'XTZUSDT', entry_bar_at: '2026-09-09T13:30:00Z', features: {rank: 8, signal5Close: fresh}},
  ];
  // A chainable stub: every builder method returns the builder, and the terminals resolve.
  // `update()` records the status transition and which row id it was filtered to.
  function table(name) {
    const st = {patch: null, id: null};
    const b = {
      select: () => b, eq: (k, v) => { if (k === 'id') st.id = v; return b; },
      gte: () => b, order: () => b, neq: () => b,
      update: (patch) => { st.patch = patch; if (patch?.status === 'REJECTED') terminals.push({id: null, patch, st}); return b; },
      in: () => b,
      limit: async () => ({data: [], error: null}),
      maybeSingle: async () => {
        if (st.patch?.status) seen.push(`${st.id}:${st.patch.status}`);
        return {data: rows.find(r => r.id === st.id) || {}, error: null};
      },
      single: async () => ({data: {}, error: null}),
      // supabase-js builders are thenables: the claim release is awaited directly rather
      // than through maybeSingle(), so the stub has to record on await too.
      then: (resolve, reject) => {
        if (st.patch?.status) seen.push(`${st.id}:${st.patch.status}`);
        return Promise.resolve({data: null, error: null}).then(resolve, reject);
      },
    };
    return b;
  }
  const db = {from: table};
  const ctx = {
    audit: async (...args) => { audits.push(args); }, audits,
    Date: new Proxy(Date, {get: (t, k) => (k === 'now' ? () => clock.now : Reflect.get(t, k))}),
    Number, Math, Error, Promise, String, Object, Set, Map, Array, console, JSON, clock,
    ENTRY_RUN_BUDGET_MS: 40000,
    SETUP_POLICY, SETUP_REASON, SETUP_STATE, SETUP_MAX_CONCURRENT: setupMaxConcurrent,
    SETUP_ADVANCE_BUDGET_MS: 12000,
    setupIsTerminal,
    // The real predicate: a signal is setup-governed only from the fixed cutover on.
    setupGoverns: (row) => {
      const close = Number(row?.features?.signal5Close);
      return Number.isSafeInteger(close) && close >= Date.parse("2026-09-17T00:00:00.000Z");
    },
    setupScopedOpen: () => Array.from({length: policyOpen}, (_, i) => ({id: 'held' + i})),
    // Stubbed at its real signature. `setups` maps a row id to the state the setup
    // reaches on this cycle, so the queue's handling of each outcome is testable
    // without a market fetch.
    advanceSignalSetup: async (_db, row) => {
      const state = setups[row.id] === undefined ? stateOf(SETUP_STATE.TRIGGERED,
        {triggerAt: now, triggerExpiresAt: now + 60_000, triggerClose: 100.25}) : setups[row.id];
      return { row, state, changed: Boolean(state), reason: state?.terminalReason ?? SETUP_REASON.HOLD };
    },
    applyB06133Selection: async (_db, row) => ({allowed:true,row}),
    applyCec0040Selection: async (_db, row) => ({allowed:true,row}),
    POLICY,
    RELEASE_SCOPE: {SYMBOL: 'SYMBOL', ACCOUNT: 'ACCOUNT'},
    releaseStopsRun: (entry) => entry?.releaseScope !== 'SYMBOL',
    ENTRY_SKIP_SYMBOL_SCOPED: /^(SIGNAL_STALE_OR_FUTURE|ENTRY_DRIFT|ENTRY_SPREAD)/,
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    rec: x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    openNow: model.pair().positions, manual: [], sgRows: rows, seen,
    gptFilterExecutable: async (_db, executable) => reviews ? reviews(executable) :
      ({candidates: executable, reason: 'TEST_GPT_PASS', reviews: executable.map(s => ({signalId: s.id, allowed: true}))}),
    lifecycleNote, gptTerminalReason, notes, terminals, attempts, model,
    noteEntryLifecycle: async (_db, row, note) => { notes.push({id: row.id, ...note}); return row; },
    gptArmFollowUp: (_db, rest) => followUp && rest.length > 0,
    // Entry capacity: the real module and the executor's real helpers (sliced below), reading the
    // account model through the same readOpsPair/snap seams production uses.
    ...capacity, CONTROL_SCOPE, MAX_SLOTS, ENTRY_CASH_BUFFER_USDT: CASH_BUFFER, ENTRY_SLOT_COST_USDT: SLOT_COST,
    ENTRY_ATTEMPT_RESERVE: ATTEMPT_RESERVE, cycleBudgets: new Map(budget ? [[db, budget]] : []),
    pair: model.pair(),
    readOpsPair: async () => { model.reads++; if (model.fail) throw new Error(model.fail); return model.pair(); },
    snap: async () => model.snapshot(),
    freshPortfolio: (pf) => pf?.stale !== true,
    openBull: async (_db, sig, _o, _m, attempt) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        attempts.push({symbol: sig.symbol, capacity: attempt.capacity, readsBefore: model.reads, fillsBefore: model.fills.length});
        // Yield: a second openBull started without awaiting this one would overlap here.
        await new Promise(r => setImmediate(r));
        const spec = outcomes[sig.symbol];
        const o = typeof spec === 'function' ? spec({model, attempt, clock}) : spec;
        if (o.dispatch) attempt.dispatched = true;
        if (o.throw) throw Error(o.throw);
        if (o.result?.entered !== true) return o.result;
        // The exchange answers the order, then time moves on: a snapshot read after this contains it.
        model.fill(sig.symbol, o.margin ?? 150);
        const respondedAt = clock.now; clock.now += 1;
        return {symbol: sig.symbol, sizedMarginUsdt: o.margin ?? 150, entryFinality: {respondedAt}, ...o.result};
      } finally { inFlight--; }
    },
    maxInFlight: () => maxInFlight,
    db,
  };
  vm.createContext(ctx);
  const helpers = source.slice(source.indexOf('// Account state the entry capacity is computed from'), source.indexOf('async function runEntryQueue('));
  if (!helpers.includes('function refreshCapacityInputs(db)')) throw new Error('the capacity helpers moved');
  vm.runInContext(helpers, ctx);
  const loop = source.slice(source.indexOf('const openSymbols=new Set(openNow'), source.indexOf('\n}\n\nasync function requireLeaderEntryControls',source.indexOf('async function runEntryQueue')));
  if (!loop.includes('for(const [index,s] of queued.entries())')) throw new Error('the entry loop was reshaped');
  vm.runInContext(`this.go=async function(){let entry={entered:false,reason:"V17_NO_ENTRY"};const sg={data:sgRows,error:null};const out=await (async()=>{${loop}\n})();return {entry:out,seen}}`, ctx);
  return ctx;
}

test('a symbol-specific no-fill lets the next candidate be priced in the same run', async () => {
  const ctx = harness({outcomes: {
    IOSTUSDT: {dispatch: true, result: {entered: false, reason: 'IOC_NO_FILL:CANCELED'}},
    BULLAUSDT: {dispatch: true, result: {entered: true, positionId: 'p1'}},
    XTZUSDT: {dispatch: false, result: {entered: false}},
  }});
  const {entry, seen} = await ctx.go();
  assert.equal(entry.entered, true, 'the second candidate was entered');
  assert.ok(seen.includes('a:CLAIMED') && seen.includes('b:CLAIMED'), 'both were claimed');
  // (2026-09-25) An entry no longer ends the run: with capacity left, the third is priced too,
  // after the account was read again.
  assert.ok(seen.includes('c:CLAIMED'), 'capacity remained, so the next BUY was priced');
  assert.equal(ctx.attempts.find(a => a.symbol === 'XTZUSDT').readsBefore, 1, 'after a fresh account read');
  assert.equal(entry.entryCount, 1);
});

test('rank order decides which candidate of a bar is priced first', async () => {
  const ctx = harness({outcomes: {
    IOSTUSDT: {dispatch: true, result: {entered: true}},
    BULLAUSDT: {dispatch: false, result: {entered: false}},
    XTZUSDT: {dispatch: false, result: {entered: false}},
  }});
  const {seen} = await ctx.go();
  assert.equal(seen[0], 'a:CLAIMED', 'rank 1 is priced before rank 6 and 8');
});

test('a dispatched failure halts the run even though it is symbol-specific text', async () => {
  const ctx = harness({outcomes: {
    IOSTUSDT: {dispatch: true, throw: 'ENTRY_SPREAD:999'},
    BULLAUSDT: {dispatch: false, result: {entered: true}},
    XTZUSDT: {dispatch: false, result: {entered: false}},
  }});
  await assert.rejects(() => ctx.go(), /ENTRY_SPREAD/,
    'once an order was sent, a matching skip reason must NOT let a second entry through');
});

test('a pre-dispatch refusal continues, a systemic one halts', async () => {
  const cont = harness({outcomes: {
    IOSTUSDT: {dispatch: false, throw: 'SIGNAL_STALE_OR_FUTURE'},
    BULLAUSDT: {dispatch: true, result: {entered: true}},
    XTZUSDT: {dispatch: false, result: {entered: false}},
  }});
  assert.equal((await cont.go()).entry.entered, true);

  const halt = harness({outcomes: {
    IOSTUSDT: {dispatch: false, throw: 'ENTRY_AVAILABLE_BALANCE_UNREADABLE'},
    BULLAUSDT: {dispatch: false, result: {entered: true}},
    XTZUSDT: {dispatch: false, result: {entered: false}},
  }});
  await assert.rejects(() => halt.go(), /ENTRY_AVAILABLE_BALANCE_UNREADABLE/);
});

test('insufficient capital stops the queue instead of retrying every symbol', async () => {
  const ctx = harness({outcomes: {
    IOSTUSDT: {dispatch: false, result: {entered: false, reason: 'ENTRY_MARGIN_INSUFFICIENT:3:40', releaseClaim: true}},
    BULLAUSDT: {dispatch: false, result: {entered: true}},
    XTZUSDT: {dispatch: false, result: {entered: false}},
  }});
  const {entry, seen} = await ctx.go();
  assert.equal(entry.entered, false);
  assert.ok(seen.includes('a:NEW'), 'the claim was handed back');
  assert.ok(!seen.includes('b:CLAIMED'), 'no further symbol was tried on a capital shortfall');
});

// ---------------------------------------------------------------------------
// The 2026-09-17 starvation, as behaviour rather than structure.
//
// In production the first candidate of nearly every cycle deferred on
// E1_QUOTE_UNKNOWN -- a symbol-scoped answer about that symbol's quote -- and the
// run ended there. Every other candidate of that 5m bar was left untouched until it
// aged past POLICY.maxEntryAgeMs and was retired in a batch: 102 of 144 rejections.
// ---------------------------------------------------------------------------

test('CASE 18: a symbol-scoped defer lets the next fresh candidate be priced now', async () => {
  const ctx = harness({outcomes: {
    // Exactly the production shape: E1 cannot read a fresh enough quote for IOST.
    IOSTUSDT: {dispatch: false, result: {entered: false, reason: 'UNKNOWN:E1_QUOTE_UNKNOWN',
      releaseClaim: true, releaseScope: 'SYMBOL'}},
    BULLAUSDT: {dispatch: true, result: {entered: true, positionId: 'p1'}},
    XTZUSDT: {dispatch: false, result: {entered: false}},
  }});
  const {entry, seen} = await ctx.go();
  assert.ok(seen.includes('a:NEW'), 'the deferred claim is handed back');
  assert.ok(seen.includes('b:CLAIMED'),
    'the next candidate of the same bar must be priced in the SAME run');
  assert.equal(entry.entered, true);
});

test('CASE 18: three symbol-scoped defers do not exceed the attempt bound', async () => {
  const defer = {dispatch: false, result: {entered: false, reason: 'UNKNOWN:E1_QUOTE_UNKNOWN',
    releaseClaim: true, releaseScope: 'SYMBOL'}};
  const ctx = harness({outcomes: {IOSTUSDT: defer, BULLAUSDT: defer, XTZUSDT: defer}});
  const {seen} = await ctx.go();
  assert.equal(seen.filter(s => s.endsWith(':CLAIMED')).length, 3,
    'all three fresh candidates are evaluated, and no more than the bound allows');
  assert.equal(seen.filter(s => s.endsWith(':NEW')).length, 3, 'and every claim is returned');
});

test('CASE 19: a candidate already past the entry age is retired without pricing it', async () => {
  const old = LEGACY_CLOSE - SETUP_POLICY.setupTtlMs - 61_000, fresh = LEGACY_CLOSE;
  const ctx = harness({
    rows: [
      {id: 'a', symbol: 'IOSTUSDT', entry_bar_at: '2026-09-09T13:30:00Z',
        features: {rank: 1, signal5Close: old}},
      {id: 'b', symbol: 'BULLAUSDT', entry_bar_at: '2026-09-09T13:30:00Z',
        features: {rank: 6, signal5Close: fresh}},
    ],
    outcomes: {
      IOSTUSDT: {dispatch: false, throw: 'must never be priced'},
      BULLAUSDT: {dispatch: true, result: {entered: true}},
    },
  });
  const {entry, seen} = await ctx.go();
  assert.ok(!seen.includes('a:CLAIMED'), 'an expired candidate costs no gateway or E1 work');
  assert.ok(seen.includes('a:REJECTED'), 'it is retired with the same verdict openBull would reach');
  assert.equal(entry.entered, true, 'and the fresh candidate behind it is still entered');
});

test('CASE 18: a repeat signal on one symbol cannot hold the whole queue', async () => {
  const fresh = LEGACY_CLOSE;
  const ctx = harness({
    rows: [
      // Three bars of the same symbol ahead of one other candidate. Before the
      // collapse, these would have consumed every attempt of the cycle.
      {id: 'a1', symbol: 'IOSTUSDT', entry_bar_at: '2026-09-09T13:30:00Z',
        features: {rank: 1, signal5Close: fresh}},
      {id: 'a2', symbol: 'IOSTUSDT', entry_bar_at: '2026-09-09T13:25:00Z',
        features: {rank: 1, signal5Close: fresh}},
      {id: 'a3', symbol: 'IOSTUSDT', entry_bar_at: '2026-09-09T13:20:00Z',
        features: {rank: 1, signal5Close: fresh}},
      {id: 'b', symbol: 'BULLAUSDT', entry_bar_at: '2026-09-09T13:20:00Z',
        features: {rank: 2, signal5Close: fresh}},
    ],
    outcomes: {
      IOSTUSDT: {dispatch: false, result: {entered: false, reason: 'UNKNOWN:E1_QUOTE_UNKNOWN',
        releaseClaim: true, releaseScope: 'SYMBOL'}},
      BULLAUSDT: {dispatch: true, result: {entered: true}},
    },
  });
  const {entry, seen} = await ctx.go();
  assert.ok(seen.includes('a1:CLAIMED'), 'the freshest bar of the symbol is the one priced');
  assert.ok(!seen.includes('a2:CLAIMED') && !seen.includes('a3:CLAIMED'),
    'its older bars must not each consume an attempt');
  assert.ok(seen.includes('a2:REJECTED') && seen.includes('a3:REJECTED'),
    'and they are retired so they do not return next cycle either');
  assert.equal(entry.entered, true, 'the other symbol is reached');
});

test('CASE 20: a run where every candidate refuses is a normal run, not a fault', async () => {
  // The outage looked healthy precisely because it was: circuit closed, no error,
  // cycles completing. A queue that refuses everything must still report that way --
  // the release gate, not the circuit breaker, is what catches 100% refusal.
  const defer = {dispatch: false, result: {entered: false, reason: 'UNKNOWN:E1_QUOTE_UNKNOWN',
    releaseClaim: true, releaseScope: 'SYMBOL'}};
  const ctx = harness({outcomes: {IOSTUSDT: defer, BULLAUSDT: defer, XTZUSDT: defer}});
  const {entry} = await ctx.go();
  assert.equal(entry.entered, false);
  assert.ok(entry.reason, 'the run reports WHY, so the release gate can read it');
  // No throw: nothing here may open the circuit or fail the cycle.
  assert.doesNotMatch(String(entry.reason), /CIRCUIT|FAULT/);
});

// ---------------------------------------------------------------------------
// The pullback policy's queue behaviour. A signal governed by it does not buy on
// sight: it is watched, and only a TRIGGERED setup ever becomes a candidate.
// ---------------------------------------------------------------------------

function setupRow(id, symbol, rank) {
  return {id, symbol, entry_bar_at: '2026-09-17T12:00:00Z',
    features: {rank, signal5Close: SETUP_CLOSE}};
}
function stateOf(state, extra = {}) {
  return {policyVersion: SETUP_POLICY.version, state, referencePrice: 100,
    armedAt: SETUP_CLOSE, expiresAt: SETUP_CLOSE + SETUP_POLICY.setupTtlMs,
    transitions: [], terminalReason: null, ...extra};
}

test('an ARMED setup is watched, never claimed and never priced', async () => {
  const ctx = harness({
    now: SETUP_NOW,
    rows: [setupRow('a', 'IOSTUSDT', 1)],
    setups: {a: stateOf(SETUP_STATE.ARMED)},
    outcomes: {IOSTUSDT: {dispatch: false, throw: 'must never be priced'}},
  });
  const {entry, seen} = await ctx.go();
  assert.ok(!seen.includes('a:CLAIMED'), 'a watched setup consumes no attempt');
  assert.equal(entry.entered, false);
  assert.equal(entry.reason, SETUP_REASON.HOLD);
});

test('a PULLBACK_OBSERVED setup is still only watched', async () => {
  const ctx = harness({
    now: SETUP_NOW,
    rows: [setupRow('a', 'IOSTUSDT', 1)],
    setups: {a: stateOf(SETUP_STATE.PULLBACK_OBSERVED, {pullbackObserved: true, pullbackLow: 99.7})},
    outcomes: {IOSTUSDT: {dispatch: false, throw: 'must never be priced'}},
  });
  const {seen} = await ctx.go();
  assert.ok(!seen.includes('a:CLAIMED'));
});

test('only a TRIGGERED setup is claimed and priced', async () => {
  const ctx = harness({
    now: SETUP_NOW,
    rows: [setupRow('a', 'IOSTUSDT', 1)],
    setups: {a: stateOf(SETUP_STATE.TRIGGERED,
      {triggerAt: SETUP_NOW, triggerExpiresAt: SETUP_NOW + 60_000, triggerClose: 100.25})},
    outcomes: {IOSTUSDT: {dispatch: true, result: {entered: true, positionId: 'p1'}}},
  });
  const {entry, seen} = await ctx.go();
  assert.ok(seen.includes('a:CLAIMED'));
  assert.equal(entry.entered, true);
});

test('a terminal setup is retired with its own reason, not as a stale signal', async () => {
  for (const [state, reason] of [
    [SETUP_STATE.CHASE_EXPIRED, SETUP_REASON.CHASE_EXPIRED],
    [SETUP_STATE.EXPIRED_NO_PULLBACK, SETUP_REASON.SETUP_EXPIRED],
    [SETUP_STATE.EXPIRED_NO_REACCEL, SETUP_REASON.SETUP_EXPIRED],
  ]) {
    const ctx = harness({
      now: SETUP_NOW,
      rows: [setupRow('a', 'IOSTUSDT', 1)],
      setups: {a: stateOf(state, {terminalReason: reason})},
      outcomes: {IOSTUSDT: {dispatch: false, throw: 'must never be priced'}},
    });
    const {entry, seen} = await ctx.go();
    assert.ok(!seen.includes('a:CLAIMED'), `${state} must not be priced`);
    assert.equal(entry.reason, reason, `${state} must report ${reason}`);
  }
});

test('the policy-scoped admission limit counts held positions, never queued candidates', async () => {
  // (2026-09-25) The limit was 2, then 4, and it counted candidates still waiting for GPT against
  // it -- a hidden account cap below MAX_SLOTS. It is MAX_SLOTS now and counts held positions.
  const triggered = stateOf(SETUP_STATE.TRIGGERED,
    {triggerAt: SETUP_NOW, triggerExpiresAt: SETUP_NOW + 60_000, triggerClose: 100.25});
  const rows = [setupRow('a', 'IOSTUSDT', 1), setupRow('b', 'BULLAUSDT', 2), setupRow('c', 'XTZUSDT', 3),
    setupRow('d', 'QNTUSDT', 4), setupRow('e', 'TRBUSDT', 5)];
  const defer = {dispatch: false, result: {entered: false, reason: 'UNKNOWN:E1_QUOTE_UNKNOWN',
    releaseClaim: true, releaseScope: 'SYMBOL'}};
  const outcomes = Object.fromEntries(rows.map(r => [r.symbol, defer]));
  const ctx = harness({now: SETUP_NOW, policyOpen: 4, rows, setups: Object.fromEntries(rows.map(r => [r.id, triggered])), outcomes});
  const {seen} = await ctx.go();
  assert.equal(seen.filter(x => x.endsWith(':CLAIMED')).length, 5, 'four held positions leave six slots: all five are priced');
  const full = harness({now: SETUP_NOW, policyOpen: MAX_SLOTS, rows, setups: Object.fromEntries(rows.map(r => [r.id, triggered])),
    outcomes: Object.fromEntries(rows.map(r => [r.symbol, {throw: 'must never be priced'}]))});
  const blocked = await full.go();
  assert.ok(!blocked.seen.some(x => x.endsWith(':CLAIMED')), 'the policy holding MAX_SLOTS positions admits nothing');
  assert.ok(full.notes.every(n => n.reason === 'V17_SETUP_POLICY_SLOT_LIMIT'));
  const source = readFileSync(
    new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const SETUP_MAX_CONCURRENT=MAX_SLOTS;/);
  assert.match(source, /const MAX_SLOTS=10/, 'the account-wide slot limit is untouched');
});

test('a legacy signal keeps the legacy 120s deadline, side by side', async () => {
  // Same cycle, one pre-cutover row and one post-cutover row: they must not borrow
  // each other's deadline.
  const source = readFileSync(
    new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
  assert.match(source, /if\(!setupGoverns\(row\)\)\{\s*if\(now-close>POLICY\.maxEntryAgeMs\)/,
    'the legacy age rule must still apply to legacy signals');
  assert.match(source, /now-close>SETUP_POLICY\.setupTtlMs\+60000/,
    'and a setup-governed signal must be retired on the setup window instead');
  assert.equal(POLICY.maxEntryAgeMs, 120_000, 'the legacy deadline is not relaxed');
});

test('advancing setups is bounded on the wall clock as well as by queue size', () => {
  // Each advance is a klines read. Without a bound, a full queue of watched setups
  // could spend the whole run budget before a single entry is attempted.
  assert.match(run, /Date\.now\(\)>=setupDeadline/);
  const budget = Number(source.match(/const SETUP_ADVANCE_BUDGET_MS=(\d+);/)[1]);
  const runBudget = Number(source.match(/const ENTRY_RUN_BUDGET_MS=(\d+);/)[1]);
  assert.ok(budget > 0 && budget < runBudget,
    `${budget}ms of setup work must leave room inside the ${runBudget}ms run budget`);
  assert.ok(budget + runBudget < 60_000, 'and the two together must fit the cadence');
  // A setup that misses its turn is NOT dropped: it stays NEW for the next cycle.
  assert.ok(!/setupDeadline[\s\S]{0,200}status:"REJECTED"/.test(run),
    'the budget must never retire a setup it simply had no time for');
});

test('a setup is armed from its own bar close, never from when it was first seen', () => {
  // Otherwise a row that sat NEW -- a backlog, a restart, the first cycle after this
  // policy goes live -- would be handed a fresh 15 minutes measured from now, which
  // is a stale-signal extension wearing a setup's clothes.
  const advance = source.slice(source.indexOf('async function advanceSignalSetup('),
    source.indexOf('/** Positions opened under this entry timing'));
  assert.match(advance, /const armAt=N\(rec\(row\.features\)\.signal5Close,NaN\);/);
  assert.match(advance, /startPullbackSetup\(\{[\s\S]*?\},armAt,SETUP_POLICY\)/,
    'the arm time must be the bar close, not `now`');
  assert.ok(!/startPullbackSetup\(\{[\s\S]*?\},now,/.test(advance),
    'arming from the wall clock would extend a stale signal');
  // And a signal with no usable close is refused rather than armed from the clock.
  assert.match(advance, /if\(!Number\.isSafeInteger\(armAt\)\)return \{row,state:null/);
});

// ---------------------------------------------------------------------------
// Entry lifecycle (2026-09-25): no GPT-reviewed candidate ends without a terminal reason.
// ---------------------------------------------------------------------------
const liveTrigger = () => stateOf(SETUP_STATE.TRIGGERED,
  {triggerAt: SETUP_NOW, triggerExpiresAt: SETUP_NOW + 60_000, triggerClose: 100.25});

test('BUY orphan prevention: with capacity left, every GPT BUY of the run is priced in the same run', async () => {
  // (2026-09-25) Previously one entry ended the run and the other BUYs were only noted
  // (ENTRY_PER_RUN_LIMIT) for a follow-up cycle. Now the account is re-read and they are priced.
  const ctx = harness({now: SETUP_NOW, followUp: true,
    rows: [setupRow('a', 'QNTUSDT', 1), setupRow('b', 'TRBUSDT', 2), setupRow('c', 'XTZUSDT', 3)],
    setups: {a: liveTrigger(), b: liveTrigger(), c: liveTrigger()},
    outcomes: {QNTUSDT: {dispatch: true, result: {entered: true, positionId: 'p1'}},
      TRBUSDT: {dispatch: true, result: {entered: true, positionId: 'p2'}},
      XTZUSDT: {dispatch: true, result: {entered: true, positionId: 'p3'}}}});
  const {entry, seen} = await ctx.go();
  assert.equal(entry.entered, true);
  assert.deepEqual(Array.from(entry.entries, e => e.symbol), ['QNTUSDT', 'TRBUSDT', 'XTZUSDT']);
  assert.ok(['a', 'b', 'c'].every(id => seen.includes(`${id}:CLAIMED`)));
  assert.equal(entry.remainingGptBuys, 0);
  assert.equal(entry.followUpArmed, false, 'nothing was left for a follow-up');
  assert.ok(!ctx.notes.some(n => n.reason === 'ENTRY_PER_RUN_LIMIT'), 'no BUY is parked by a per-run limit');
});

test('GPT SKIP / ABSTAIN is terminal at once; a pending review is only noted', async () => {
  const ctx = harness({now: SETUP_NOW,
    rows: [setupRow('a', 'IOSTUSDT', 1), setupRow('b', 'BULLAUSDT', 2), setupRow('c', 'XTZUSDT', 3)],
    setups: {a: liveTrigger(), b: liveTrigger(), c: liveTrigger()},
    reviews: (ex) => ({candidates: [], reason: 'GPT_REVIEW_PENDING', reviews: [
      {signalId: ex[0].id, allowed: false, reason: 'GPT_SKIP', decision: 'SKIP', detail: 'EV_UNFAVORABLE'},
      {signalId: ex[1].id, allowed: false, reason: 'GPT_ABSTAIN', decision: 'ABSTAIN', detail: 'DATA_INSUFFICIENT'},
      {signalId: ex[2].id, allowed: false, reason: 'GPT_REVIEW_PENDING', decision: 'ABSTAIN'}]}),
    outcomes: {IOSTUSDT: {throw: 'no'}, BULLAUSDT: {throw: 'no'}, XTZUSDT: {throw: 'no'}}});
  const {entry} = await ctx.go();
  assert.equal(entry.entered, false);
  const terminal = Object.fromEntries(ctx.terminals.map(t => [t.st.id, t.patch.reject_reason]));
  assert.equal(terminal.a, 'GPT_SKIP:EV_UNFAVORABLE');
  assert.equal(terminal.b, 'GPT_ABSTAIN:DATA_INSUFFICIENT');
  assert.equal(terminal.c, undefined, 'a pending answer is not final');
  assert.deepEqual(ctx.notes.map(n => [n.id, n.stage, n.reason]), [['c', 'GPT_REVIEW', 'GPT_REVIEW_PENDING']]);
});

test('duplicate entry: an open duplicate is terminal; a full book returns the claim and stops the run', async () => {
  const ctx = harness({now: SETUP_NOW,
    rows: [setupRow('a', 'IOSTUSDT', 1), setupRow('b', 'BULLAUSDT', 2), setupRow('c', 'XTZUSDT', 3)],
    setups: {a: liveTrigger(), b: liveTrigger(), c: liveTrigger()},
    outcomes: {IOSTUSDT: {dispatch: false, result: {entered: false, reason: 'DUPLICATE_SYMBOL_OPEN',
      terminal: 'SLOT_UNAVAILABLE:DUPLICATE_SYMBOL_OPEN'}},
    BULLAUSDT: {dispatch: false, result: {entered: false, reason: 'V11_SLOT_FULL', releaseClaim: true}},
    XTZUSDT: {dispatch: false, throw: 'a full book must stop the run'}}});
  const {seen} = await ctx.go();
  assert.ok(seen.includes('a:REJECTED'), 'the duplicate is closed, never left CLAIMED');
  assert.equal(ctx.terminals.find(t => t.st.id === 'a').patch.reject_reason, 'SLOT_UNAVAILABLE:DUPLICATE_SYMBOL_OPEN');
  assert.ok(seen.includes('b:NEW'), 'a full book hands the claim back for the trigger window');
  assert.ok(!seen.includes('c:CLAIMED'), 'and ends the run: no slot is free for anyone');
});

test('a released claim records the refusal it came back with', async () => {
  const releases = [];
  const ctx = harness({now: SETUP_NOW,
    rows: [setupRow('a', 'IOSTUSDT', 1)], setups: {a: liveTrigger()},
    outcomes: {IOSTUSDT: {dispatch: false, result: {entered: false, reason: 'E1_DISPATCH_QUOTE_AGED:1400',
      releaseClaim: true, releaseScope: 'SYMBOL'}}}});
  const from = ctx.db.from;
  ctx.db.from = (name) => { const b = from(name), update = b.update;
    b.update = (patch) => { if (patch?.status === 'NEW') releases.push(patch); return update(patch); }; return b; };
  await ctx.go();
  assert.equal(releases.length, 1);
  assert.equal(releases[0].features.entryLifecycle.reason, 'E1_DISPATCH_QUOTE_AGED:1400');
  assert.equal(releases[0].features.entryLifecycle.gptDecision, 'BUY');
});

test('BUY but stale: a closed trigger window is skipped before any selector, controller or GPT work', async () => {
  let selected = 0;
  const ctx = harness({now: SETUP_NOW + 61_000,
    rows: [setupRow('a', 'IOSTUSDT', 1)],
    setups: {a: stateOf(SETUP_STATE.TRIGGERED, {triggerAt: SETUP_NOW, triggerExpiresAt: SETUP_NOW + 60_000, triggerClose: 100.25})},
    outcomes: {IOSTUSDT: {throw: 'a closed window must never be priced'}}});
  ctx.applyB06133Selection = async (_db, row) => { selected++; return {allowed: true, row}; };
  const {entry, seen} = await ctx.go();
  assert.equal(selected, 0);
  assert.ok(!seen.includes('a:CLAIMED'));
  assert.equal(entry.reason, SETUP_REASON.TRIGGER_STALE);
});

test('the lifecycle sweep runs before the slot check and is never an admission', () => {
  const q = source.slice(source.indexOf('async function runEntryQueue('));
  const sweep = q.indexOf('sweepEntryLifecycle(db'), slot = q.indexOf('if(active(pair.pf).length>=MAX_SLOTS)');
  assert.ok(sweep > 0 && sweep < slot, 'a full book cannot hide an expired trigger');
  const fn = source.slice(source.indexOf('async function sweepEntryLifecycle('), source.indexOf('async function applyB06133Selection('));
  assert.ok(!/status:"(NEW|CLAIMED|ORDERED)"/.test(fn.replace(/eq\("status","NEW"\)/g, '')), 'the sweep only ever writes REJECTED');
  assert.ok(!/openBull|dispatchEntryIocAttempt|gateway\(/.test(fn), 'and never prices or orders');
});

// ---------------------------------------------------------------------------
// Dynamic multi-slot admission (2026-09-25). capacity = min(MAX_SLOTS - used slots,
// floor((free margin - cash buffer) / slot cost), valid GPT BUYs), re-read after every fill
// (entry-capacity.mjs). J1-J18, the QNT/TRB replay, the 2/3/4/10-slot simulations and the
// oversubscription proof. The account model charges 0.5 USDT of fees per fill unless a test
// sets otherwise; a slot is always 150 USDT of margin -- nothing here makes a slot smaller.
// ---------------------------------------------------------------------------
const R = capacity.UNUSED_SLOT_REASON;
const plain = (x) => JSON.parse(JSON.stringify(x));
const capAt = (available, extra = {}) => capacity.entryCapacity({maxSlots: MAX_SLOTS, slotCost: SLOT_COST,
  cashBufferUsdt: CASH_BUFFER, liveAvailableUsdt: available, ...extra});
const SLOT_BUFFER = SLOT_COST - SLOT_SIZING_CONTRACT.targetMarginUsdt + CASH_BUFFER;
/** n GPT BUY candidates with live triggers, ranked in order. */
function buyRows(n, prefix = 'C') {
  return Array.from({length: n}, (_, i) => setupRow(`${prefix}${i}`, `${prefix}${i}USDT`, i + 1));
}
function liveSetups(rows) { return Object.fromEntries(rows.map(r => [r.id, liveTrigger()])); }
const fills = (margin = 150) => ({dispatch: true, margin, result: {entered: true, positionId: 'p'}});
function allFill(rows, margin = 150) { return Object.fromEntries(rows.map(r => [r.symbol, fills(margin)])); }
function sumReasons(unused) { return Object.values(unused.byReason).reduce((a, b) => a + b, 0); }
const REASONS = new Set(Object.values(R));
function assertEveryUnusedSlotHasAReason(entry, maxSlots = MAX_SLOTS) {
  const u = entry.capacity.unusedSlots;
  assert.equal(u.free, maxSlots - entry.capacity.final.usedSlots);
  assert.equal(sumReasons(u), u.free, 'every empty slot carries exactly one reason');
  for (const k of Object.keys(u.byReason)) assert.ok(REASONS.has(k), `${k} is one of the six reasons`);
}

test('the slot cost is 150 USDT of margin plus fee, lot-step and price-cap reserve -- never less', () => {
  assert.equal(SLOT_SIZING_CONTRACT.targetMarginUsdt, 150);
  assert.ok(Math.abs(SLOT_COST - 152.021375) < 1e-9, `slot cost ${SLOT_COST}`);
  assert.ok(Math.abs(SLOT_BUFFER - 2.121375) < 1e-9, 'the buffer on top of 150 USDT');
  assert.equal(MAX_SLOTS, 10);
});

for (const [id, available, expected] of [['J1', 149, 0], ['J2', 150 + SLOT_BUFFER + 0.005, 1], ['J3', 345, 2],
  ['J4', 470, 3], ['J5', 620, 4], ['J6', 5_000, 10], ['-', 1_000, 6], ['-', 1_500, 9], ['-', 1_520.32, 10]]) {
  test(`${id} ${available.toFixed(2)} USDT free with MAX_SLOTS ${MAX_SLOTS}: capacity ${expected}, and a run of 12 GPT BUYs enters exactly ${expected}`, async () => {
    const c = capAt(available);
    assert.equal(c.capacity, expected, 'expected capacity');
    if (expected === 0) assert.equal(c.reason, R.INSUFFICIENT_MARGIN);
    const rows = buyRows(12);
    const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
      account: accountModel({available})});
    const {entry} = await ctx.go();
    const actual = entry.entered ? entry.entryCount : 0;
    assert.equal(actual, expected, 'actual capacity used by the run');
    assert.ok(ctx.model.fills.every(f => f.margin === 150), 'every slot is a full 150 USDT slot');
    assert.ok(ctx.maxInFlight() <= 1, 'one attempt at a time');
    assertEveryUnusedSlotHasAReason(entry);
    const reason = expected === MAX_SLOTS ? null : R.INSUFFICIENT_MARGIN;
    if (reason) assert.equal(entry.capacity.unusedSlots.byReason[reason], MAX_SLOTS - expected);
  });
}

test('J2 the buffer is required: 150.00 USDT alone is not one slot, 150 + buffer is', () => {
  assert.equal(capAt(150).capacity, 0);
  assert.equal(capAt(150 + SLOT_BUFFER + 0.005).capacity, 1);
  assert.match(capAt(150).detail, /^150\.00<152\.13$/);
});

test('J7 two BUYs: the second is evaluated only after the first fill and a fresh account read', async () => {
  const rows = buyRows(2);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
    account: accountModel({available: 345})});
  const {entry} = await ctx.go();
  assert.equal(entry.entryCount, 2);
  const [first, second] = ctx.attempts;
  assert.equal(first.readsBefore, 0);
  assert.equal(second.readsBefore, 1, 'the account was read again between the two');
  assert.equal(second.fillsBefore, 1, 'after the first fill');
  assert.equal(second.capacity.usedSlots, 1);
  assert.equal(second.capacity.runEntryIndex, 2);
  assert.ok(Math.abs(second.capacity.freeMarginUsdt - (345 - 150.5)) < 1e-9, 'priced on the post-fill margin');
});

test('J8 four BUYs with four slots of capital: all four enter', async () => {
  const rows = buyRows(4);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
    account: accountModel({available: 620})});
  const {entry} = await ctx.go();
  assert.equal(entry.entryCount, 4);
  assert.deepEqual(Array.from(entry.entries, e => e.symbol), rows.map(r => r.symbol));
});

test('J9 a GPT SKIP (initial or FINAL RECHECK) moves on to the next BUY', async () => {
  const rows = buyRows(3);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
    reviews: (ex) => ({candidates: ex.slice(1), reason: 'TEST', reviews: [
      {signalId: ex[0].id, allowed: false, reason: 'GPT_SKIP', decision: 'SKIP', detail: 'EV_UNFAVORABLE'},
      ...ex.slice(1).map(s => ({signalId: s.id, allowed: true}))]}),
    outcomes: {C0USDT: {throw: 'a SKIP is never priced'},
      C1USDT: {dispatch: false, result: {entered: false, reason: 'GPT_FINAL_RECHECK_SKIP'}},
      C2USDT: fills()},
    account: accountModel({available: 620})});
  const {entry, seen} = await ctx.go();
  assert.ok(!seen.includes('C0:CLAIMED'));
  assert.equal(entry.entryCount, 1);
  assert.equal(entry.entries[0].symbol, 'C2USDT', 'the BUY after the SKIPs entered');
  assert.equal(entry.capacity.unusedSlots.byReason[R.NO_VALID_GPT_BUY] > 0, true);
  assertEveryUnusedSlotHasAReason(entry);
});

test('J10 an execution refusal (released or thrown before dispatch) moves on to the next BUY', async () => {
  const rows = buyRows(3);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
    outcomes: {C0USDT: {dispatch: false, result: {entered: false, reason: 'E1_DISPATCH_QUOTE_AGED:1400', releaseClaim: true, releaseScope: 'SYMBOL'}},
      C1USDT: {dispatch: false, throw: 'ENTRY_SPREAD:41'}, C2USDT: fills()},
    account: accountModel({available: 620})});
  const {entry, seen} = await ctx.go();
  assert.ok(seen.includes('C0:NEW') && seen.includes('C2:CLAIMED'));
  assert.equal(entry.entryCount, 1);
  // 620 - 150.5 leaves 3 fundable slots: 2 are explained by the two execution refusals.
  assert.equal(entry.capacity.unusedSlots.byReason[R.EXECUTION_SAFETY_REJECT], 2);
  assertEveryUnusedSlotHasAReason(entry);
});

test('J11 margin for only one slot: the run stops after the first fill, the rest are named', async () => {
  const rows = buyRows(3);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
    account: accountModel({available: 300})});
  const {entry, seen} = await ctx.go();
  assert.equal(entry.entryCount, 1);
  assert.ok(!seen.includes('C1:CLAIMED') && !seen.includes('C2:CLAIMED'), 'no claim without a funded slot');
  assert.equal(entry.capacity.unusedSlots.stop.reason, R.INSUFFICIENT_MARGIN);
  assert.equal(entry.capacity.unusedSlots.byReason[R.INSUFFICIENT_MARGIN], 9);
  const noted = ctx.notes.filter(n => n.stage === 'QUEUE').map(n => n.reason);
  assert.equal(noted.length, 2);
  assert.ok(noted.every(r => /^INSUFFICIENT_MARGIN:149\.50<152\.13$/.test(r)), noted.join());
});

test('J12 a partial fill books its ACTUAL margin, so the rest of the account stays usable', async () => {
  const rows = buyRows(4);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
    outcomes: {C0USDT: {dispatch: true, margin: 60, result: {entered: true, reason: 'PARTIAL_FILL_ABORT:IOC_RETRY_EXHAUSTED'}},
      C1USDT: fills(), C2USDT: fills(), C3USDT: fills()},
    account: accountModel({available: 400})});
  const {entry} = await ctx.go();
  // 400 - 60.5 = 339.5 -> two more full slots; booking the partial as a whole slot would allow one.
  assert.equal(entry.entryCount, 3);
  assert.equal(entry.entries[0].sizedMarginUsdt, 60);
  assert.equal(ctx.attempts[1].capacity.capacity, 2, 'recomputed from the partial margin');
  assert.equal(ctx.attempts[1].capacity.usedSlots, 1, 'a partial fill holds one slot');
});

test('J13 an unresolved entry order reserves its slot and margin; a held account admits nothing', async () => {
  const pending = {id: 'o1', symbol: 'OLDUSDT', intent: 'OPEN_LONG', state: 'DISPATCHED', response_payload: {}};
  const rows = buyRows(2);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
    outcomes: Object.fromEntries(rows.map(r => [r.symbol, {throw: 'must never be priced'}])),
    account: accountModel({available: 5_000, pending: [pending]})});
  const {entry, seen} = await ctx.go();
  assert.ok(!seen.some(x => x.endsWith(':CLAIMED')));
  assert.equal(entry.capacity.initial.reason, R.PENDING_CAPITAL_RESERVED);
  assert.equal(entry.capacity.unusedSlots.byReason[R.PENDING_CAPITAL_RESERVED], 9, 'the order holds one slot; nine wait on it');
  // Under a symbol quarantine the order no longer holds the account, but its slot and margin stay reserved.
  const c = capAt(320, {orders: [pending], quarantinedOrderIds: ['o1']});
  assert.equal(c.usedSlots, 1);
  assert.equal(c.marginSlotsGross, 2);
  assert.equal(c.capacity, 1, 'one slot of margin is held back for the unresolved order');
  const held = capAt(320, {orders: [{...pending, response_payload: {v18ExposureFinal: true}}]});
  assert.equal(held.capacity, 2, 'an order whose exposure is final reserves nothing');
});

test('J14 MAX_SLOTS: nine held + three BUYs enters one; ten held enters none', async () => {
  const held = Array.from({length: 9}, (_, i) => `H${i}USDT`);
  const rows = buyRows(3);
  const nine = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
    account: accountModel({available: 5_000, open: held})});
  const a = await nine.go();
  assert.equal(a.entry.entryCount, 1);
  assert.equal(a.entry.capacity.unusedSlots.stop.reason, R.MAX_SLOTS_REACHED);
  assert.equal(a.entry.capacity.unusedSlots.free, 0);
  const ten = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
    outcomes: Object.fromEntries(rows.map(r => [r.symbol, {throw: 'must never be priced'}])),
    account: accountModel({available: 5_000, open: [...held, 'H9USDT']})});
  const b = await ten.go();
  assert.equal(b.entry.entered, false);
  assert.match(b.entry.reason, /^MAX_SLOTS_REACHED:10\/10$/);
});

test('J15 a duplicate symbol never enters: held symbols are not queued, a late duplicate is terminal', async () => {
  const rows = [setupRow('a', 'HELDUSDT', 1), setupRow('b', 'RACEUSDT', 2), setupRow('c', 'NEXTUSDT', 3)];
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
    outcomes: {HELDUSDT: {throw: 'a held symbol is never priced'},
      RACEUSDT: {dispatch: false, result: {entered: false, reason: 'DUPLICATE_SYMBOL_OPEN', terminal: 'SLOT_UNAVAILABLE:DUPLICATE_SYMBOL_OPEN'}},
      NEXTUSDT: fills()},
    account: accountModel({available: 5_000, open: ['HELDUSDT']})});
  const {entry, seen} = await ctx.go();
  assert.ok(!seen.includes('a:CLAIMED'));
  assert.ok(seen.includes('b:REJECTED'));
  assert.equal(entry.entryCount, 1);
  assert.equal(entry.entries[0].symbol, 'NEXTUSDT');
});

test('J16 twelve BUYs and ample margin never exceed MAX_SLOTS', async () => {
  const rows = buyRows(12);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
    account: accountModel({available: 50_000})});
  const {entry, seen} = await ctx.go();
  assert.equal(entry.entryCount, MAX_SLOTS);
  assert.equal(seen.filter(x => x.endsWith(':CLAIMED')).length, MAX_SLOTS, 'the eleventh is never claimed');
  assert.equal(entry.capacity.final.usedSlots, MAX_SLOTS);
  const rest = ctx.notes.filter(n => n.stage === 'QUEUE').map(n => n.reason);
  assert.deepEqual(rest, ['MAX_SLOTS_REACHED:10/10', 'MAX_SLOTS_REACHED:10/10']);
});

test('J17 no double use of free margin: with every account view lagging, the ledger alone stops at the true capacity', async () => {
  // Exchange, DB and snapshot all keep showing 320 USDT free and no positions after each fill.
  const rows = buyRows(4);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
    account: accountModel({available: 320, lag: true})});
  const {entry} = await ctx.go();
  assert.equal(entry.entryCount, 2, 'true capacity: 320 - 2 x 150.5 = 19 USDT left');
  assert.ok(ctx.model.available < 152.12 && ctx.model.available > 0, 'the real account was never overdrawn');
  assert.deepEqual(plain(entry.capacity.final.ledgerSymbols), ['C0USDT', 'C1USDT']);
  assert.equal(entry.capacity.final.usedSlots, 2, 'the ledger holds both slots although no view shows them');
  // Without the ledger the same lagging view would report two free slots after both fills.
  const naive = capAt(320);
  assert.equal(naive.capacity, 2, 'what a view-only capacity would have allowed again');
  assert.equal(ctx.maxInFlight(), 1);
});

test('J18 an account that cannot be re-read after a fill ends the run fail-closed; the fill stands', async () => {
  for (const failure of ['error', 'stale']) {
    const rows = buyRows(3);
    const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
      outcomes: {C0USDT: ({model}) => {
        if (failure === 'error') model.fail = 'GATEWAY_TIMEOUT';
        else { const pair = model.pair; model.pair = () => ({...pair(), pf: {...pair().pf, stale: true}}); }
        return fills();
      }, C1USDT: {throw: 'must never be priced'}, C2USDT: {throw: 'must never be priced'}},
      account: accountModel({available: 5_000})});
    const {entry, seen} = await ctx.go();
    assert.equal(entry.entered, true, 'the first fill is reported');
    assert.equal(entry.entryCount, 1);
    assert.ok(!seen.includes('C1:CLAIMED'));
    assert.equal(entry.capacity.unusedSlots.stop.reason, R.ACCOUNT_SAFETY_BLOCK);
    assert.match(entry.capacity.unusedSlots.stop.detail, failure === 'error' ?
      /^CAPACITY_REFRESH_FAILED:GATEWAY_TIMEOUT$/ : /^CAPACITY_REFRESH_FAILED:CAPACITY_PORTFOLIO_STALE$/);
    assert.equal(ctx.notes.filter(n => n.stage === 'QUEUE' && /^ACCOUNT_SAFETY_BLOCK:CAPACITY_REFRESH_FAILED/.test(n.reason)).length, 2);
    assertEveryUnusedSlotHasAReason(entry);
  }
});

/** The two production signals: QNTUSDT's 17:10 bar and TRBUSDT's 17:15 bar, both triggered 17:17:00. */
function qntTrbRows() {
  const row = (id, symbol, rank, bar) => ({id, symbol, entry_bar_at: bar, features: {rank, signal5Close: Date.parse(bar)}});
  return [row('qnt', 'QNTUSDT', 1, '2026-09-24T17:10:00Z'), row('trb', 'TRBUSDT', 2, '2026-09-24T17:15:00Z')];
}
test('QNT/TRB 2026-09-24 17:17 replay: after QNT fills, TRB reaches its order stage on the post-fill account', async () => {
  // Production: 351.67 USDT free, QNT filled 148.81 USDT of margin at 17:17:22 and the account
  // showed 202.86 free; TRB (GPT BUY 17:17:11.6, trigger window to 17:18:00) was never priced.
  const trig = Date.parse('2026-09-24T17:17:00Z'), now = trig + 15_000;
  const trigger = stateOf(SETUP_STATE.TRIGGERED, {triggerAt: trig, triggerExpiresAt: trig + 60_000, triggerClose: 1});
  const rows = qntTrbRows();
  let trbSaw = null;
  const ctx = harness({now, rows, setups: {qnt: trigger, trb: trigger},
    outcomes: {QNTUSDT: ({clock}) => { clock.now += 12_000; return fills(148.81); },
      TRBUSDT: ({attempt}) => { trbSaw = attempt.capacity; return fills(150); }},
    account: accountModel({available: 351.67, feeUsdt: 0})});
  const {entry, seen} = await ctx.go();
  assert.ok(seen.includes('trb:CLAIMED'), 'TRB is claimed in the same run');
  assert.ok(trbSaw, 'TRB reached openBull (its order stage)');
  assert.equal(trbSaw.runEntryIndex, 2);
  assert.equal(trbSaw.usedSlots, 1);
  assert.equal(trbSaw.capacity, 1);
  assert.ok(Math.abs(trbSaw.freeMarginUsdt - 202.86) < 1e-9, 'priced on the re-read 202.86 USDT');
  assert.deepEqual(Array.from(entry.entries, e => e.symbol), ['QNTUSDT', 'TRBUSDT']);
});

test('QNT/TRB variant: if QNT takes past TRB\'s trigger window, TRB is named V17_TRIGGER_STALE, never silently dropped', async () => {
  // Run 2 starts 40 s into the window and QNT's entry takes 21 s (inside the run's wall clock).
  const trig = Date.parse('2026-09-24T17:17:00Z'), now = trig + 40_000;
  const trigger = stateOf(SETUP_STATE.TRIGGERED, {triggerAt: trig, triggerExpiresAt: trig + 60_000, triggerClose: 1});
  const rows = qntTrbRows();
  const ctx = harness({now, rows, setups: {qnt: trigger, trb: trigger},
    outcomes: {QNTUSDT: ({clock}) => { clock.now = trig + 61_000; return fills(148.81); },
      TRBUSDT: {throw: 'a closed window is never priced'}},
    account: accountModel({available: 351.67, feeUsdt: 0})});
  const {entry, seen} = await ctx.go();
  assert.ok(!seen.includes('trb:CLAIMED'));
  const note = ctx.notes.find(n => n.id === 'trb');
  assert.equal(note.reason, SETUP_REASON.TRIGGER_STALE);
  assert.equal(note.gptDecision, 'BUY');
  assert.equal(entry.capacity.unusedSlots.byReason[R.EXECUTION_SAFETY_REJECT], 1, 'the free slot TRB would have taken is explained');
  assertEveryUnusedSlotHasAReason(entry);
});

test('the cycle budget bounds the run: BUYs it cannot finish are named, handed to the follow-up, and their slots explained', async () => {
  const rows = buyRows(5);
  let attemptsSeen = 0;
  const budget = {remaining: () => (attemptsSeen >= 2 ? ATTEMPT_RESERVE.ms - 1 : 50_000), get callsLeft() { return 100; }};
  const outcomes = Object.fromEntries(rows.map(r => [r.symbol, () => { attemptsSeen++; return fills(); }]));
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes, budget, followUp: true,
    account: accountModel({available: 5_000})});
  const {entry} = await ctx.go();
  assert.equal(entry.entryCount, 2);
  assert.equal(entry.remainingGptBuys, 3);
  assert.equal(entry.followUpArmed, true, 'one follow-up cycle (a fresh budget) is armed for them');
  assert.equal(entry.capacity.unusedSlots.stop.detail, 'CYCLE_BUDGET_RESERVE');
  assert.equal(entry.capacity.unusedSlots.byReason[R.EXECUTION_SAFETY_REJECT], 3);
  assert.equal(entry.capacity.unusedSlots.byReason[R.NO_VALID_GPT_BUY], 5);
  assert.equal(ctx.notes.filter(n => n.reason === 'EXECUTION_SAFETY_REJECT:CYCLE_BUDGET_RESERVE').length, 3);
  // Too few gateway calls left is the same stop.
  const calls = harness({now: SETUP_NOW, rows: buyRows(2), setups: liveSetups(buyRows(2)), outcomes: allFill(buyRows(2)),
    budget: {remaining: () => 50_000, callsLeft: ATTEMPT_RESERVE.calls - 1}, account: accountModel({available: 5_000})});
  const c = await calls.go();
  assert.equal(c.entry.entered, false);
  assert.equal(c.entry.reason, 'EXECUTION_SAFETY_REJECT:CYCLE_BUDGET_RESERVE');
});

test('an ACCOUNT-scoped refusal after a fill stops the run with its own reason for every fundable slot', async () => {
  const rows = buyRows(3);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
    outcomes: {C0USDT: fills(), C1USDT: {dispatch: false, result: {entered: false,
      reason: 'ENTRY_CONTROL:ACCOUNT_RISK_BLOCK:ACCOUNT_CIRCUIT:X', releaseClaim: true, releaseScope: 'ACCOUNT'}},
    C2USDT: {throw: 'must never be priced'}},
    account: accountModel({available: 5_000})});
  const {entry, seen} = await ctx.go();
  assert.equal(entry.entryCount, 1);
  assert.ok(seen.includes('C1:NEW') && !seen.includes('C2:CLAIMED'));
  assert.equal(entry.capacity.unusedSlots.stop.reason, R.ACCOUNT_SAFETY_BLOCK);
  assert.equal(entry.capacity.unusedSlots.byReason[R.ACCOUNT_SAFETY_BLOCK], 9);
  assert.equal(ctx.notes.find(n => n.id === 'C2').reason, 'ACCOUNT_SAFETY_BLOCK:ENTRY_CONTROL:ACCOUNT_RISK_BLOCK:ACCOUNT_CIRCUIT:X');
});

test('FINAL CHECK: enough margin + an empty slot + a valid GPT BUY never leaves the slot empty', async () => {
  // Every combination of 1..10 BUYs against 0..10 held slots with ample margin: the run enters
  // min(free slots, BUYs), and anything left empty is explained by one of the six reasons.
  for (let held = 0; held <= MAX_SLOTS; held++) for (let n = 1; n <= MAX_SLOTS; n++) {
    const rows = buyRows(n);
    const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
      account: accountModel({available: 50_000, open: Array.from({length: held}, (_, i) => `H${i}USDT`)})});
    const {entry} = await ctx.go();
    const entered = entry.entered ? entry.entryCount : 0;
    assert.equal(entered, Math.min(MAX_SLOTS - held, n), `held ${held}, BUYs ${n}`);
    assertEveryUnusedSlotHasAReason(entry);
    const unused = entry.capacity.unusedSlots.byReason;
    assert.equal(unused[R.INSUFFICIENT_MARGIN] ?? 0, 0, 'ample margin');
    assert.equal(unused[R.NO_VALID_GPT_BUY] ?? 0, MAX_SLOTS - held - entered, 'only slots with no BUY left are empty');
  }
});

test('oversubscription proof: attempts never overlap and capacity is re-read before every admission after a fill', async () => {
  const rows = buyRows(8);
  const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows), outcomes: allFill(rows),
    account: accountModel({available: 1_000})});
  const {entry} = await ctx.go();
  assert.equal(entry.entryCount, 6);
  assert.equal(ctx.maxInFlight(), 1, 'no Promise.all: one openBull at a time');
  ctx.attempts.forEach((a, i) => {
    assert.equal(a.readsBefore, i, `admission ${i + 1} follows ${i} account re-reads`);
    assert.ok(a.capacity.capacity >= 1 && a.capacity.freeMarginUsdt >= SLOT_COST + CASH_BUFFER, 'never admitted without a funded slot');
  });
  assert.ok(ctx.model.available >= 0, 'the account was never overdrawn');
  const source = readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
  const q = source.slice(source.indexOf('async function runEntryQueue('), source.indexOf('async function requireLeaderEntryControls'));
  assert.ok(!/Promise\.all\([^)]*openBull/.test(q) && (q.match(/openBull\(/g) ?? []).length === 1, 'one sequential call site');
});

test('an unlabelled claim release stops the run (fail closed) and its slots are an account stop, never "no valid BUY"', async () => {
  for (const reason of ['PORTFOLIO_CHANGED', 'SOME_FUTURE_ACCOUNT_REFUSAL']) {
    const rows = buyRows(3);
    const ctx = harness({now: SETUP_NOW, rows, setups: liveSetups(rows),
      outcomes: {C0USDT: fills(), C1USDT: {dispatch: false, result: {entered: false, reason, releaseClaim: true}},
        C2USDT: {throw: 'must never be priced'}},
      account: accountModel({available: 5_000})});
    const {entry, seen} = await ctx.go();
    assert.ok(!seen.includes('C2:CLAIMED'), reason);
    assert.equal(entry.capacity.unusedSlots.stop.reason, R.ACCOUNT_SAFETY_BLOCK, reason);
    assert.equal(entry.capacity.unusedSlots.byReason[R.NO_VALID_GPT_BUY] ?? 0, 0, reason);
    assertEveryUnusedSlotHasAReason(entry);
  }
});
