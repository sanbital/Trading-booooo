// Every signal from one 5m bar expires together at signal5Close+120s, but the executor runs
// once a minute and used to price exactly one candidate per run. So one refusal killed the
// whole bar: on 2026-09-09 13:30 IOSTUSDT no-filled at 13:31, and BULLAUSDT and XTZUSDT were
// then rejected as stale at 13:32 and 13:33 without ever being priced. 44 signals died that
// way over two days.
//
// The queue must never become a way to open two positions in one run, so the tests below pin
// the stop conditions as hard as the continue conditions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
const run = source.slice(source.indexOf('async function run(db)'), source.indexOf('async function requireLeaderEntryControls'));

test('the executor prices more than one candidate per run', () => {
  assert.match(run, /for\(const s of queue\.slice\(0,ENTRY_ATTEMPTS_PER_RUN\)\)/,
    'entries must be attempted from a bounded queue');
  assert.match(source, /const ENTRY_ATTEMPTS_PER_RUN=(\d+);/);
  const n = Number(source.match(/const ENTRY_ATTEMPTS_PER_RUN=(\d+);/)[1]);
  assert.ok(n >= 2 && n <= 5, `${n} attempts must beat 1 without overrunning the cadence`);
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
  assert.match(open, /attempt\.dispatched=true;const raw=await gateway\(rp\)/,
    'the flag must be set immediately before the order leaves');
  const flag = open.indexOf('attempt.dispatched=true');
  // everything that can refuse an entry without sending anything must come first
  for (const pre of ['ENTRY_SPREAD', 'QTY_INVALID', 'ENTRY_MARGIN_INSUFFICIENT', 'ENTRY_GRANULARITY_BPS']) {
    assert.ok(open.indexOf(pre) < flag, `${pre} must be raised before dispatch`);
  }
  // and the post-fill validations must come after, so they can never be treated as skippable
  for (const post of ['STOP_POLICY_INVALID', 'STOP_INVALID']) {
    const settle=source.slice(source.indexOf('async function settleKnownEntry('),source.indexOf('async function readOpsPositions('));
    assert.ok(open.indexOf('settleKnownEntry(db,oi.data,raw,gateway)')>flag&&settle.includes(post), `${post} is checked in post-dispatch settlement`);
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

test('a successful entry and an exhausted account both stop the queue', () => {
  assert.match(run, /if\(entry\?\.entered===true\)break;/, 'one entry per run is still the rule');
  assert.match(run, /if\(entry\?\.releaseClaim===true\)\{[^}]*status:"NEW"[^}]*\}\.\.\.|if\(entry\?\.releaseClaim===true\)\{/,
    'a margin skip must hand the claim back');
  const rel = run.indexOf('releaseClaim===true');
  const tail = run.slice(rel, rel + 400);
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

function harness({outcomes}) {
  const seen = [];
  const rows = [
    {id: 'a', symbol: 'IOSTUSDT', entry_bar_at: '2026-09-09T13:30:00Z', features: {rank: 1}},
    {id: 'b', symbol: 'BULLAUSDT', entry_bar_at: '2026-09-09T13:30:00Z', features: {rank: 6}},
    {id: 'c', symbol: 'XTZUSDT', entry_bar_at: '2026-09-09T13:30:00Z', features: {rank: 8}},
  ];
  // A chainable stub: every builder method returns the builder, and the terminals resolve.
  // `update()` records the status transition and which row id it was filtered to.
  function table(name) {
    const st = {patch: null, id: null};
    const b = {
      select: () => b, eq: (k, v) => { if (k === 'id') st.id = v; return b; },
      gte: () => b, order: () => b, neq: () => b,
      update: (patch) => { st.patch = patch; return b; },
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
  const ctx = {
    Date, Number, Math, Error, Promise, String, Object, Set, Array, console, JSON,
    ENTRY_ATTEMPTS_PER_RUN: 3,
    ENTRY_SKIP_SYMBOL_SCOPED: /^(SIGNAL_STALE_OR_FUTURE|ENTRY_DRIFT|ENTRY_SPREAD)/,
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    rec: x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    openNow: [], manual: [], sgRows: rows, seen,
    openBull: async (_db, sig, _o, _m, attempt) => {
      const o = outcomes[sig.symbol];
      if (o.dispatch) attempt.dispatched = true;
      if (o.throw) throw Error(o.throw);
      return o.result;
    },
    db: {from: table},
  };
  vm.createContext(ctx);
  const loop = source.slice(source.indexOf('const openSymbols=new Set(openNow'), source.indexOf('\nreturn entry;\n}',source.indexOf('async function runEntryQueue')));
  vm.runInContext(`this.go=async function(){let entry={entered:false,reason:"V17_NO_ENTRY"};const sg={data:sgRows,error:null};${loop};return {entry,seen}}`, ctx);
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
  assert.ok(!seen.includes('c:CLAIMED'), 'it stopped once an entry succeeded');
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
