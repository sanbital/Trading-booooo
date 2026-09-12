import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, position } from '../../test-support/v18-ops/harness.mjs';
import { qv3Stamp } from '../../supabase/functions/_shared/leader-qv3-runtime.mjs';

const PRODUCTION_V38_COMMIT = 'd5424b54ca25dff364cde96692f7bf9abdc6f77b';
const base = Date.parse('2026-09-10T16:10:00Z');
const now = base + 180000;
const candle = (time, open, close) => [time, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close, 1, time + 59999];

function stampedPosition() {
  const value = position('SAGAUSDT', 1, 100);
  value.entry_at = new Date(base).toISOString();
  value.metadata.qv3 = qv3Stamp(base, base);
  return value;
}

function configureFilledExit(instance) {
  instance.state.quotes.SAGAUSDT = 100.3;
  instance.state.createOrder = (command, state) => {
    const open = state.tables.v11_long_regime_positions.find((value) => value.symbol === command.order.market);
    const quantity = command.order.quantity;
    const price = state.quotes[open.symbol] ?? open.entry_price;
    state.exchange = [];
    const raw = {
      orderId: `software-${open.id}`,
      clientOrderId: command.order.identifier,
      symbol: open.symbol,
      side: 'SELL',
      positionSide: 'BOTH',
      reduceOnly: true,
      origQty: String(quantity),
      executedQty: String(quantity),
      status: 'FILLED',
      updateTime: state.now,
      fills: [{ tradeId: 'qv3-exit', qty: String(quantity), price: String(price), commission: '.05', commissionAsset: 'USDT', time: state.now }],
    };
    const result = { order: { exchange_order_id: raw.orderId, client_order_id: raw.clientOrderId, market: open.symbol, side: 'SELL', position_side: 'BOTH', reduce_only: true, requested_volume: quantity, executed_volume: quantity, raw_status: 'FILLED', status: 'FILLED', average_price: price, raw } };
    state.software[command.order.identifier] = result;
    return result;
  };
}

function businessSnapshot(instance, result) {
  return {
    managed: result.managed.map((row) => ({ action: row.action?.action ?? null, reason: row.action?.reason ?? null, error: row.error ?? null })),
    positions: instance.state.tables.v11_long_regime_positions.map((row) => ({
      id: row.id,
      state: row.state,
      remaining_quantity: row.remaining_quantity,
      realized_pnl_usdt: row.realized_pnl_usdt,
      hard_stop_price: row.hard_stop_price,
      peak_price: row.peak_price,
      exit_reason: row.exit_reason ?? null,
      qv3State: row.metadata?.qv3State ?? null,
      exitProtection: row.metadata?.exitProtection ?? null,
    })),
    orders: instance.state.tables.v11_long_regime_orders.map((row) => ({ intent: row.intent, state: row.state, exchange_order_id: row.exchange_order_id ?? null, requested_quantity: row.requested_quantity })),
    decisions: instance.state.tables.v11_long_regime_decisions.map((row) => ({ action: row.action, reason: row.reason })),
    gatewayActions: instance.state.calls.filter((row) => row.action).map((row) => row.action),
  };
}

async function compareScenario({ bars, quote = 100.3, fill = false, marketFailure = false }) {
  const options = {
    positions: [stampedPosition()],
    now,
    signal: false,
    qv3Cutover: base,
    qv3Fetch: marketFailure
      ? () => { throw new Error('MUST_NOT_CALL'); }
      : async () => new Response(JSON.stringify(bars)),
  };
  const production = harness({ ...options, sourceRef: PRODUCTION_V38_COMMIT });
  const candidate = harness(options);
  production.state.quotes.SAGAUSDT = quote;
  candidate.state.quotes.SAGAUSDT = quote;
  if (fill) {
    configureFilledExit(production);
    configureFilledExit(candidate);
    production.state.quotes.SAGAUSDT = quote;
    candidate.state.quotes.SAGAUSDT = quote;
  }
  const productionResult = await production.ctx.runCycle();
  const candidateResult = await candidate.ctx.runCycle();
  assert.deepEqual(businessSnapshot(candidate, candidateResult), businessSnapshot(production, productionResult));
}

test('V20 evidence patch is behavior-identical to production v38 across QV3 hold, close, unavailable, and pre-QV3 stop paths', async () => {
  await compareScenario({ bars: [candle(base, 100, 100.5), candle(base + 60000, 100.5, 100.6), candle(base + 120000, 100.6, 100.7)] });
  await compareScenario({ bars: [candle(base, 100, 100.5), candle(base + 60000, 100.5, 100.4), candle(base + 120000, 100.4, 100.3)], fill: true });
  await compareScenario({ bars: [candle(base + 60000, 100.5, 100.4), candle(base + 120000, 100.4, 100.3)] });
  await compareScenario({ bars: [], quote: 96, fill: true, marketFailure: true });
});
