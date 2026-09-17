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
  assert.match(run, /if\(attempts>=ENTRY_ATTEMPTS_PER_RUN\)/,
    'entries must be attempted from a bounded queue');
  assert.match(source, /const ENTRY_ATTEMPTS_PER_RUN=(\d+);/);
  const n = Number(source.match(/const ENTRY_ATTEMPTS_PER_RUN=(\d+);/)[1]);
  assert.ok(n >= 2 && n <= 5, `${n} attempts must beat 1 without overrunning the cadence`);
  // The attempt count alone no longer bounds the run: a symbol-scoped defer now
  // continues, and an E1 fast-weak watch can wait per attempt. A wall clock must
  // stop new attempts as well, or three watches overrun the one-minute cadence.
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
  assert.match(run, /if\(releaseStopsRun\(entry\)\)break;/);
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
  assert.match(open, /attempt\.dispatched=true;const initialRaw=await gateway\(rp\)/,
    'the flag must be set immediately before the order leaves');
  const flag = open.indexOf('attempt.dispatched=true');
  // everything that can refuse an entry without sending anything must come first
  for (const pre of ['ENTRY_SPREAD', 'QTY_INVALID', 'ENTRY_MARGIN_INSUFFICIENT', 'ENTRY_GRANULARITY_BPS']) {
    assert.ok(open.indexOf(pre) < flag, `${pre} must be raised before dispatch`);
  }
  // and the post-fill validations must come after, so they can never be treated as skippable
  for (const post of ['STOP_POLICY_INVALID', 'STOP_INVALID']) {
    const settle=source.slice(source.indexOf('async function settleKnownEntry('),source.indexOf('async function readOpsPositions('));
    assert.ok(open.indexOf('settleKnownEntry(db,oi.data,settledRaw,gateway)')>flag&&settle.includes(post), `${post} is checked in post-dispatch settlement`);
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
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';

function harness({outcomes, rows: extraRows = null}) {
  const seen = [];
  // signal5Close is now load-bearing: the queue retires already-expired candidates
  // before claiming them, so a fixture must be inside POLICY.maxEntryAgeMs to be
  // priced at all. `bar` shifts a row's age for the expiry tests below.
  const fresh = Date.now() - 5_000;
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
    ENTRY_RUN_BUDGET_MS: 40000,
    POLICY,
    RELEASE_SCOPE: {SYMBOL: 'SYMBOL', ACCOUNT: 'ACCOUNT'},
    releaseStopsRun: (entry) => entry?.releaseScope !== 'SYMBOL',
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
  if (!loop.includes('for(const s of stillFresh)')) throw new Error('the entry loop was reshaped');
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
  const old = Date.now() - 200_000, fresh = Date.now() - 5_000;
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
  const fresh = Date.now() - 5_000;
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
