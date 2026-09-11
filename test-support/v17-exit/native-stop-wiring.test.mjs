// Wiring tests for the exchange-resident protective stop.
//
// Motivation, from the 2026-09-08 23:17 ~ 09-09 07:17 KST cohort: across nine closed
// trades the fills landed 6.596 percentage points worse than the stop levels the
// software had already computed correctly (DOGS 2.622pp, DOGS#1 1.659pp). Detection was
// healthy throughout — quote age 110-118ms — so the loss is the unobserved window
// between two one-minute polls, not the thresholds. A resting STOP_MARKET closes that
// window. These tests pin the safety properties of the wiring, not the strategy.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { POLICY } from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import { nextExitReviewed, EXIT_REVIEW_CANDIDATE, EXIT_REVIEW_R5 }
  from '../../supabase/functions/_shared/leader-exit-review.mjs';

const source = readFileSync(
  new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function leaderQuote('),
                          source.indexOf('const leaseOwners='));

function harness({ enabled = false, bid = 99, ensure, symbolInfoFails = false } = {}) {
  const now = Date.now(), calls = [], ensured = [];
  const ctx = {
    Date, Number, Array, Error, console, POLICY, nextExitReviewed, EXIT_REVIEW_CANDIDATE, EXIT_REVIEW_R5,
    STRATEGY: 'LEADER_MOMENTUM_V17', rec: (x) => x ?? {}, N: (x) => Number(x) || 0,
    NATIVE_STOP_ENABLED: enabled,classifyFailure:()=>({fatal:false}),
    verifyExecutionLease: async () => {},
    createGatewayProtection: () => {
      calls.push('construct');
      return {
        ensure: async (id, request) => {
          ensured.push({ id, request });
          if (ensure) return ensure(id, request);
          return { status: 'PROTECTED' };
        },
      };
    },
    gateway: async (c) => {
      calls.push(c.action);
      if (c.action === 'p10_quotes') {
        return [{ market: 'DOGSUSDT', best_bid: bid, best_ask: bid * 1.0001,
                  timing: { received_at_ms: now, requested_at_ms: now - 20 } }];
      }
      if (c.action === 'symbol_info') {
        if (symbolInfoFails) throw Error('SYMBOL_INFO_DOWN');
        return { price_tick: 0.0000001, quantity_step: 1 };
      }
      throw Error(`unexpected gateway action ${c.action}`);
    },
    closePos: async () => { calls.push('close'); return { closed: true }; },
    audit: async () => { calls.push('audit'); },
  };
  vm.createContext(ctx);
  vm.runInContext(code + ';this.manage=manageLeader;', ctx);
  const builder={update(){return this},eq(){return this},select(){return this},async single(){calls.push('write');return{data:{ok:true}}}};
  const db={from:()=>builder};
  const position = {
    id: 'pos-1', symbol: 'DOGSUSDT', entry_price: 100, original_quantity: 1000,
    entry_fee_usdt: 0.06, peak_price: 103.03, hard_stop_price: 101.4846,
    entry_at: new Date(now - 600_000).toISOString(), updated_at: new Date(now - 600_000).toISOString(), metadata: {},
  };
  const context = { manualSymbols: [], exchangeQuantity: new Map([['DOGSUSDT', 1000]]) };
  return { ctx, db, position, context, calls, ensured };
}

test('disabled by default: no protection is constructed and no stop order is touched', async () => {
  const h = harness({ enabled: false, bid: 102 });
  const r = await h.ctx.manage(h.db, h.position, h.context);
  assert.equal(r.action, 'HOLD');
  assert.ok(!h.calls.includes('construct'), 'must not construct protection while disabled');
  assert.ok(!h.calls.includes('symbol_info'), 'must not even ask for filters while disabled');
  assert.deepEqual(h.ensured, []);
});

test('enabled: the exchange stop is aligned only after the ratcheted stop is durable', async () => {
  const h = harness({ enabled: true, bid: 102 });
  const r = await h.ctx.manage(h.db, h.position, h.context);
  assert.equal(r.action, 'HOLD');
  assert.equal(h.ensured.length, 1);
  // the write must precede the exchange order: never protect a level the DB lacks
  assert.ok(h.calls.indexOf('write') < h.calls.indexOf('construct'));
  const { request } = h.ensured[0];
  assert.equal(request.positionMode, 'ONE_WAY');
  assert.equal(request.exchangeQuantity, 1000);
  assert.equal(request.lastPrice, 102);
  // peak 103.03 => profit lock 101.515, which is above the incoming 101.4846 trail
  assert.ok(request.stopPrice > 101.4846, `stop ${request.stopPrice} must be the ratcheted level`);
});

test('a protection failure never blocks or alters the software exit', async () => {
  const h = harness({ enabled: true, bid: 102, ensure: () => { throw Error('EXCHANGE_DOWN'); } });
  const r = await h.ctx.manage(h.db, h.position, h.context);
  assert.equal(r.action, 'HOLD', 'the software monitor must carry on');
  assert.equal(h.calls.includes('write'), true);
});

test('symbol filters being unavailable degrades to software-only protection', async () => {
  const h = harness({ enabled: true, bid: 102, symbolInfoFails: true });
  const r = await h.ctx.manage(h.db, h.position, h.context);
  assert.equal(r.action, 'HOLD');
  assert.deepEqual(h.ensured, [], 'no stop can be sized without the exchange filters');
});

test('a detected exit closes first and only then retires the resting stop', async () => {
  // bid below the stop => CLOSE
  const h = harness({ enabled: true, bid: 90 });
  const r = await h.ctx.manage(h.db, h.position, h.context);
  assert.equal(r.action, 'CLOSE');
  assert.ok(h.calls.indexOf('close') < h.calls.indexOf('construct'),
    'retiring the exchange order must never delay the exit');
  assert.equal(h.ensured.length, 1, 'the resting stop must not outlive the position');
});

test('a position the exchange does not report is not given a stop', async () => {
  const h = harness({ enabled: true, bid: 102 });
  h.context.exchangeQuantity = new Map();
  await h.ctx.manage(h.db, h.position, h.context);
  assert.deepEqual(h.ensured, [], 'sizing a stop from an unconfirmed quantity is unsafe');
});

test('the flag is opt-in in the source, not merely off in this harness', () => {
  assert.match(source, /const NATIVE_STOP_ENABLED=env\("V17_NATIVE_STOP"\)==="true";/,
    'enabling must require an explicit operator setting');
});
