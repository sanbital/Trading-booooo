// A single 3s gateway timeout on the top-of-book read used to halt V17 entirely: any throw
// out of manageBull opens the circuit breaker. On 2026-09-09 that cost 21 minutes of
// downtime on one "The signal has been aborted", and an open circuit makes run() return
// early -- so it stops managing exits too, protecting nothing.
//
// The retry is deliberately scoped to the quote read. Widening it over the exit dispatch
// would risk closing a position twice, so these tests pin both the retry AND its boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {nextExitReviewed, EXIT_REVIEW_CANDIDATE, EXIT_REVIEW_R5}
  from '../../supabase/functions/_shared/leader-exit-review.mjs';

const source = readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('// One transport hiccup on the top-of-book read'), source.indexOf('const leaseOwners='));

function make({quoteResults, budget = 3}) {
  const now = Date.now();
  const calls = [];
  const ctx = {
    Date, Number, Array, Error, POLICY, nextExitReviewed, EXIT_REVIEW_CANDIDATE, EXIT_REVIEW_R5, console,
    rec: x => x ?? {}, STRATEGY: 'LEADER_MOMENTUM_V17', N: x => Number(x) || 0,
    NATIVE_STOP_ENABLED: false,
    createGatewayProtection: () => { throw Error('must not be constructed when disabled'); },
    verifyExecutionLease: async () => {},
    gateway: async (c, timeoutMs) => {
      calls.push({action: c.action, timeoutMs});
      const next = quoteResults.shift();
      if (next === 'timeout') throw Error('The signal has been aborted');
      if (next === 'stale') return [{market: 'FORMUSDT', best_bid: 96, best_ask: 96.1, timing: {received_at_ms: now - 10000, requested_at_ms: now - 20}}];
      return [{market: 'FORMUSDT', best_bid: 96, best_ask: 96.1, timing: {received_at_ms: Date.now(), requested_at_ms: Date.now() - 20}}];
    },
    closePos: async () => ({closed: true}),
    audit: async () => {},
  };
  ctx.classifyFailure=()=>({fatal:false});vm.createContext(ctx);
  vm.runInContext(code + ';this.manage=manageLeader;', ctx);
  const p = {id: 'p', symbol: 'FORMUSDT', entry_price: 100, original_quantity: 1, entry_fee_usdt: .05,
    peak_price: 100, hard_stop_price: 97.5, entry_at: new Date(now - 60000).toISOString(), metadata: {}};
  return {ctx, calls, p, runCtx: {quoteRetryBudget: {remaining: budget}}};
}

const db = () => ({from: () => ({update: () => ({eq: () => ({eq: () => ({select: () => ({single: async () => ({data: {}, error: null})})})})})})});

test('a single quote timeout is retried instead of halting the strategy', async () => {
  const {ctx, calls, p, runCtx} = make({quoteResults: ['timeout', 'ok']});
  const r = await ctx.manage(db(), p, runCtx);
  assert.equal(r.action, 'CLOSE');           // 96 is below the 97.5 stop
  assert.equal(calls.length, 2, 'the read was retried once');
  assert.equal(calls[0].timeoutMs, 3000);
  assert.equal(calls[1].timeoutMs, 2500, 'the retry uses a shorter budget');
  assert.equal(runCtx.quoteRetryBudget.remaining, 2, 'one unit of budget was spent');
});

test('a stale quote is retried too, and a fresh second read is accepted', async () => {
  const {ctx, calls, p, runCtx} = make({quoteResults: ['stale', 'ok']});
  await ctx.manage(db(), p, runCtx);
  assert.equal(calls.length, 2);
});

test('two consecutive failures still surface, so a real outage still trips the circuit', async () => {
  const {ctx, calls, p, runCtx} = make({quoteResults: ['timeout', 'timeout']});
  await assert.rejects(() => ctx.manage(db(), p, runCtx), /aborted/);
  assert.equal(calls.length, 2, 'it does not retry forever');
});

test('the retry budget is per run, so an outage cannot stretch the cycle', async () => {
  const {ctx, p, runCtx} = make({quoteResults: ['timeout', 'timeout'], budget: 0});
  await assert.rejects(() => ctx.manage(db(), p, runCtx), /aborted/);
  assert.equal(runCtx.quoteRetryBudget.remaining, 0, 'an exhausted budget does not go negative');
});

test('a missing budget degrades to the old single-attempt behaviour', async () => {
  const {ctx, calls, p} = make({quoteResults: ['timeout', 'ok']});
  await assert.rejects(() => ctx.manage(db(), p, {}), /aborted/);
  assert.equal(calls.length, 1);
});

test('the retry never covers the exit dispatch', () => {
  // The whole point of the boundary: closePos must sit outside leaderQuote.
  const quote = code.slice(code.indexOf('async function leaderQuote('), code.indexOf('async function manageLeader('));
  for (const forbidden of ['closePos', 'create_order', 'syncNativeStop', 'from(']) {
    assert.ok(!quote.includes(forbidden), `leaderQuote must not contain ${forbidden}`);
  }
  assert.ok(quote.includes('p10_quotes'), 'leaderQuote is the quote read');
  // and manageLeader must take its quote from it, not inline
  const manage = code.slice(code.indexOf('async function manageLeader('));
  assert.ok(manage.includes('await leaderQuote(p,ctx)'), 'manageLeader must use the retrying read');
  assert.ok(!manage.slice(0, manage.indexOf('closePos')).includes('action:"p10_quotes"'),
    'no second un-retried inline quote read may remain');
});

test('run() seeds a bounded retry budget into ctx', () => {
  const run = source.slice(source.indexOf('async function run(db)'), source.indexOf('async function requireLeaderEntryControls'));
  assert.match(run, /quoteRetryBudget:\{remaining:\d+\}/, 'run() must seed the budget');
  const n = Number(run.match(/quoteRetryBudget:\{remaining:(\d+)\}/)[1]);
  assert.ok(n >= 1 && n <= 5, `budget ${n} must stay small enough to fit the one-minute cadence`);
});
