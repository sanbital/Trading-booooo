// A Binance futures MARKET order can acknowledge as FILLED for the whole quantity before
// /fapi/v1/userTrades has indexed its fills, so the ack carries avgPrice 0 and an empty
// trade list. The exit path read that as "no fill".
//
// On 2026-09-09 MAGMAUSDT hit exactly that: order 1474132504 came back status FILLED,
// cumQty 449, fills []. The executor raised EXIT_NO_FILL:FILLED, opened the circuit, and
// V17 stopped trading for nine hours -- while the exchange was already flat and the seven
// real fills (avg 0.26888051, +0.4492 net) sat in the ledger as UNMATCHED_INVENTORY,
// because the failure path never wrote exchange_order_id for the attribution trigger.
//
// These tests pin the three properties that failure needed: re-read the price, do not halt
// the strategy when only the price is unknown, and always persist the order id.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('const EXIT_SETTLE_ATTEMPTS='),
                          source.indexOf('async function manageBull('));

const POSITION = {
  id: 'pos-magma', symbol: 'MAGMAUSDT', signal_id: 'sig-1', side: 'LONG', state: 'OPEN',
  active_lane: 'BULL', remaining_quantity: 449, entry_price: 0.26761184855233855,
  peak_price: 0.27131, realized_pnl_usdt: -0.060078860000000005, metadata: {},
};

// The shape Binance returns for a MARKET order whose fills are not indexed yet.
const ACK_NO_DETAILS = {
  order: { status: 'FILLED', executedQty: '449', avgPrice: '0', orderId: 1474132504, fills: [] },
  fill: { executedVolume: 449, averagePrice: null, paidFee: 0, executedFunds: 0 },
};
// The same order re-read once userTrades caught up.
const SETTLED = {
  order: { status: 'FILLED', executedQty: '449', avgPrice: '0.26888051', orderId: 1474132504 },
  fill: { executedVolume: 449, averagePrice: 0.2688805122494432, paidFee: 0.06036365 },
};

function harness({ responses }) {
  const calls = [];
  const writes = { orders: [], positions: [], signals: [], audits: [] };
  function builder(bucket) {
    const st = {};
    const b = {
      update: (patch) => { st.patch = patch; return b; },
      insert: (row) => { writes.audits.push(row); return b; },
      eq: () => b, select: () => b,
      single: async () => { if (st.patch) writes[bucket].push(st.patch); return { data: { ...POSITION, ...st.patch }, error: null }; },
      then: (res, rej) => {
        if (st.patch) writes[bucket].push(st.patch);
        return Promise.resolve({ data: null, error: null }).then(res, rej);
      },
    };
    return b;
  }
  const ctx = {
    Date, Number, Math, Error, Promise, String, Object, Array, JSON, setTimeout, crypto, console,
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    rec: x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    fill: new Function('p', `const N=v=>{const x=Number(v);return Number.isFinite(x)?x:0};
      const o=p?.order??p??{},f=p?.fill??{};
      const q=Math.max(0,N(f.executedVolume??o.executedQty));
      const a=Math.max(0,N(f.averagePrice??o.avgPrice));
      return{status:String(o?.status??"UNKNOWN").toUpperCase(),
        exchangeOrderId:o?.orderId==null?null:String(o.orderId),
        qty:q,avg:a,fee:Math.max(0,N(f.paidFee)),raw:p}`),
    gateway: async (cmd) => {
      calls.push(cmd.action);
      const next = responses.shift();
      if (next === 'throw') throw Error('read failed');
      return next;
    },
    classifyExitResponse: (req, got, status) => ({ state: got >= req && status === 'FILLED' ? 'FILLED' : 'PARTIAL' }),
    exitAttemptId: async () => 'tb-v11x-test',
    verifyExecutionLease: async () => {},
    circuit: async (_db, r) => { ctx.circuitOpened = r; },
    audit: async () => {},
    active: () => [{ market: 'MAGMAUSDT', quantity: 449 }],
    sym: p => String(p.market || '').toUpperCase(),
    floorStep: (v) => Math.floor(v),
    db: { from: (t) => builder(t === 'v11_long_regime_orders' ? 'orders'
      : t === 'v11_long_regime_positions' ? 'positions' : 'signals') },
    circuitOpened: null, calls, writes,
  };
  vm.createContext(ctx);
  vm.runInContext(`${code};this.settle=settleExitFill;`, ctx);
  return ctx;
}

test('a FILLED ack with no price is re-read instead of being called a no-fill', async () => {
  const ctx = harness({ responses: [SETTLED] });
  const z = ctx.fill(ACK_NO_DETAILS);
  assert.equal(z.qty, 449);
  assert.equal(z.avg, 0, 'the ack really does carry no price');

  const out = await ctx.settle(POSITION, 'tb-v11x-test', z, () => {});
  assert.equal(ctx.calls[0], 'get_order', 'it re-reads the order, it does not re-send it');
  assert.ok(Math.abs(out.avg - 0.2688805122494432) < 1e-12, 'the real fill price is recovered');
  assert.equal(out.exchangeOrderId, '1474132504');
});

test('the re-read is bounded and keeps the ack when it never resolves', async () => {
  const ctx = harness({ responses: ['throw', ACK_NO_DETAILS, 'throw', SETTLED] });
  const z = ctx.fill(ACK_NO_DETAILS);
  const out = await ctx.settle(POSITION, 'tb-v11x-test', z, () => {});
  assert.equal(ctx.calls.length, 3, 'it does not retry forever');
  assert.equal(out.avg, 0, 'an unresolved read leaves the ack untouched');
  assert.equal(out.qty, 449, 'and never invents a fill');
});

test('settleExitFill only ever reads', () => {
  const start = code.indexOf('async function settleExitFill(');
  const end = code.indexOf('\n}', start) + 2;
  assert.ok(end > start, 'the complete settle function must be extracted');
  const fn = code.slice(start, end);
  assert.match(fn, /action:"get_order"/);
  for (const forbidden of ['create_order', 'closePos', 'v17_cancel_stop', 'p10_portfolio']) {
    assert.ok(!fn.includes(forbidden), `settleExitFill must not contain ${forbidden}`);
  }
});

test('a full FILLED exit closes the books instead of opening the circuit', () => {
  // Halting stops exit management for every OTHER open position too, so an exit whose
  // only unknown is its price must not trip the breaker.
  const exit = source.slice(source.indexOf('async function closePos('),
                            source.indexOf('async function manageBull('));
  assert.match(exit, /const flat=z\.status==="FILLED"&&z\.qty\+1e-9>=amount/,
    'flatness is decided by the exchange saying FILLED for the whole quantity');
  const flat = exit.indexOf('const flat=');
  const trip = exit.indexOf('if(!flat){await circuit(');
  assert.ok(trip > flat, 'the circuit is only tripped when the position state is ambiguous');
  assert.match(exit, /exitAccountingPending:true/, 'the position is flagged for reconciliation');
  assert.match(exit, /state:"CLOSED"/);
});

test('the exchange order id is persisted on every path', () => {
  // The attribution trigger joins fills on exchange_order_id. Dropping it is what left
  // MAGMA's seven SELLs as UNMATCHED_INVENTORY with no v17_position_id.
  const exit = source.slice(source.indexOf('async function closePos('),
                            source.indexOf('async function manageBull('));
  const paths = exit.match(/exchange_order_id:/g) || [];
  assert.ok(paths.length >= 2, `expected the id on the success and no-fill paths, saw ${paths.length}`);
  assert.match(exit, /if\(z\?\.exchangeOrderId\)patch\.exchange_order_id=z\.exchangeOrderId/,
    'the outer catch must persist it too');
});

test('the settle window fits inside the one-minute cadence', () => {
  const n = Number(source.match(/EXIT_SETTLE_ATTEMPTS=(\d+)/)[1]);
  const d = Number(source.match(/EXIT_SETTLE_DELAY_MS=(\d+)/)[1]);
  const t = Number(source.match(/EXIT_SETTLE_TIMEOUT_MS=(\d+)/)[1]);
  assert.ok(n >= 2 && n <= 5, `${n} attempts`);
  assert.ok(n * (d + t) < 30000, `worst case ${n * (d + t)}ms must leave room in the cycle`);
});
