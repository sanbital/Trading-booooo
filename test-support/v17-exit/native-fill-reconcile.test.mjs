// The exchange-resident stop exists to fill BETWEEN two one-minute polls. When it does,
// the exchange no longer holds the position but the database still shows it open.
//
// run() compares those two before it manages anything, and a mismatch calls circuit(),
// which sets circuit_open=true and makes every later tick return RUNTIME_NOT_LIVE. The
// code that books a native fill lives downstream of that guard, so without the
// reconciliation step the stop doing its job would halt trading with the fill unbooked:
// the success case would be the failure case. These tests pin that ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { POLICY, STRATEGY, portfolioMatches as leaderPortfolioMatches }
  from '../../supabase/functions/_shared/leader-momentum-v17.mjs';

const source = readFileSync(
  new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function reconcileNativeFills('),
                          source.indexOf('async function requireLeaderEntryControls('));

const POSITION = {
  id: 'pos-1', symbol: 'EGLDUSDT', side: 'LONG', state: 'OPEN', active_lane: 'BULL',
  remaining_quantity: 24.4, entry_price: 4.937426229508197, entry_at: '2026-09-08T22:01:05.223Z',
  metadata: {
    executionMode: 'LEADER_MOMENTUM_V17',
    exitProtection: { version: 1, generation: 1, health: 'PROTECTED',
      orders: [{ clientId: 'tb-v17s-x', terminal: false, status: 'ACTIVE' }] },
  },
};

// The exchange reports nothing: the resting stop already closed the position.
const EMPTY_PORTFOLIO = { positions: [], positions_complete: true };

function harness({ enabled, position = POSITION, refreshCloses = true }) {
  const calls = [];
  let open = [position];
  const db = {
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain, gte: () => chain,
        limit: async () => {
          if (table === 'v11_long_regime_positions') {
            calls.push('read-positions');
            return { data: open.slice() };
          }
          return { data: [] };
        },
        single: async () => ({ data: {
          revision: 'V11-LONG-REGIME-1.0.1', live_enabled: true, circuit_open: false } }),
        maybeSingle: async () => ({ data: null }),
        update: () => ({ ...chain, eq: () => ({ ...chain, select: () => chain }) }),
        then: undefined,
      };
      if (table === 'trading_asset_locks') {
        chain.eq = () => ({ ...chain, eq: async () => ({ data: [] }) });
      }
      return chain;
    },
  };
  const ctx = {
    Date, Number, Array, Error, console, JSON, Set, Map, Promise, crypto,
    POLICY, STRATEGY, leaderPortfolioMatches,
    REVISION: 'V11-LONG-REGIME-1.0.1', PATCH: 'p', MAX_SLOTS: 10, SIGNAL_MAX: 300000,
    // run() now works a bounded entry queue rather than a single candidate
    ENTRY_ATTEMPTS_PER_RUN: 3, ENTRY_SKIP_SYMBOL_SCOPED: /^(SIGNAL_STALE_OR_FUTURE|ENTRY_DRIFT)/,
    NATIVE_STOP_ENABLED: enabled,
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    rec: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    sym: (p) => String(p?.market ?? p?.symbol ?? '').toUpperCase(),
    qty: (p) => Math.abs(Number(p?.quantity ?? p?.positionAmt ?? 0)),
    portfolioMatches: (dbp, pf) => leaderPortfolioMatches(dbp, pf),
    manualPositionAllowances: async () => [],
    market: async () => ({ route: 'MOMENTUM', observer: null }),
    pushShadowPositions: async () => {},
    manageBull: async () => { calls.push('manage'); return { action: 'HOLD' }; },
    openBull: async () => ({ entered: false }),
    verifyExecutionLease: async () => {},
    gateway: async (c) => {
      if (c.action === 'p10_portfolio') return EMPTY_PORTFOLIO;
      throw Error(`unexpected ${c.action}`);
    },
    circuit: async (_db, reason) => { calls.push(`circuit:${String(reason).slice(0, 40)}`); },
    createGatewayProtection: () => ({
      refresh: async (id) => {
        calls.push('reconcile');
        // Booking the fill closes the position, so the next read no longer returns it.
        if (refreshCloses) open = open.filter((p) => p.id !== id);
        return {};
      },
    }),
  };
  vm.createContext(ctx);
  vm.runInContext(code + ';this.run=run;', ctx);
  return { ctx, calls, db };
}

test('a native fill is reconciled instead of halting trading', async () => {
  const h = harness({ enabled: true });
  const out = await h.ctx.run(h.db);
  assert.ok(h.calls.includes('reconcile'), 'the native fill must be booked');
  assert.ok(!h.calls.some((c) => c.startsWith('circuit')),
    `the circuit breaker must stay closed, got ${JSON.stringify(h.calls)}`);
  assert.equal(out.ok, true);
});

test('reconciliation runs BEFORE the mismatch guard, not after', async () => {
  const h = harness({ enabled: true });
  await h.ctx.run(h.db);
  const reconciled = h.calls.indexOf('reconcile');
  const circuited = h.calls.findIndex((c) => c.startsWith('circuit'));
  assert.ok(reconciled >= 0);
  assert.ok(circuited === -1 || reconciled < circuited,
    'booking the fill after the breaker has opened is too late');
});

test('with the flag off nothing is reconciled and the guard still fires', async () => {
  const h = harness({ enabled: false });
  await assert.rejects(() => h.ctx.run(h.db), /EXCHANGE_MISMATCH/);
  assert.ok(!h.calls.includes('reconcile'), 'the reconciler is gated on the flag');
  assert.ok(h.calls.some((c) => c.startsWith('circuit')), 'the existing guard is unchanged');
});

test('a mismatch that no native stop explains still opens the circuit breaker', async () => {
  // Same divergence, but this position never had a protection order: the guard must
  // not be softened into ignoring a genuine exchange/database disagreement.
  const bare = { ...POSITION, metadata: { executionMode: 'LEADER_MOMENTUM_V17' } };
  const h = harness({ enabled: true, position: bare });
  await assert.rejects(() => h.ctx.run(h.db), /EXCHANGE_MISMATCH/);
  assert.ok(!h.calls.includes('reconcile'));
  assert.ok(h.calls.some((c) => c.startsWith('circuit')));
});

test('if reconciliation does not explain the divergence the guard still fires', async () => {
  const h = harness({ enabled: true, refreshCloses: false });
  await assert.rejects(() => h.ctx.run(h.db), /EXCHANGE_MISMATCH/);
  assert.ok(h.calls.includes('reconcile'), 'it tries');
  assert.ok(h.calls.some((c) => c.startsWith('circuit')), 'and then still refuses to trade');
});
