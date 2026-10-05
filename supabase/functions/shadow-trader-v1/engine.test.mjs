import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TREND, SQUEEZE, fundingDistribution, parseKlines, evaluateCandidate, microstructure,
  microDecision, positionDecision, candidateOutcome, publicBinancePath,
} from './engine.mjs';

function rawKline(openAt, interval, open, close, quote = 1000, buy = 550) {
  const high = Math.max(open, close) * 1.001;
  const low = Math.min(open, close) * 0.999;
  return [openAt, String(open), String(high), String(low), String(close), '10', openAt + interval - 1, String(quote), 20, '5', String(buy)];
}

test('closed-candle parser excludes the still-open/future candle', () => {
  const minute = 60_000;
  const raw = [rawKline(0, minute, 100, 101), rawKline(minute, minute, 101, 102), rawKline(2 * minute, minute, 102, 103)];
  const rows = parseKlines(raw, '1m', 2 * minute - 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].close, 101);
});

test('funding selection is cross-sectional and detects a relative negative tail', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ symbol: `S${index}USDT`, lastFundingRate: String(-0.00001 + index * 0.0000002) }));
  rows[0].lastFundingRate = '-0.003';
  const eligible = new Set(rows.map((row) => row.symbol));
  const distribution = fundingDistribution(rows, eligible, { funding_bottom_percentile: 0.025, funding_robust_z_max: -3 });
  const extreme = distribution.rows.find((row) => row.symbol === 'S0USDT');
  assert.equal(extreme.outlier, true);
  assert.ok(extreme.percentile <= 0.025);
  assert.ok(extreme.robust_z < -3);
});

test('chart failure terminates the pipeline before indicator approval', () => {
  const result = evaluateCandidate(TREND, {
    chart: { higher_high: false, higher_low: false, u_shape_recovery: false, previous_high_approach: false, previous_high_breakout: false, breakout_retest_support: false, last_close: 99, ma7: 98, ma25: 100, upper_rejection: true },
    technical: { macd_hist: 10, macd_hist_delta: 10, volume_acceleration: 5, obv_delta_5m: 100, taker_buy_share: 0.9, momentum_15m_pct: 5, momentum_1h_pct: 5 },
    derivatives: { oi_change_15m_pct: 10, oi_change_1h_pct: 10, basis_bps: -50, basis_slope: 5 },
    funding: null,
  });
  assert.equal(result.stage, 'CHART_STRUCTURE_FAIL');
  assert.equal(result.decision, 'SKIP');
});

test('virtual long entry uses executable asks and wide spread delays entry', () => {
  const depth = { bids: [['99.8', '20'], ['99.7', '20']], asks: [['100', '2'], ['100.1', '20']] };
  const trades = [{ p: '100', q: '2', T: 99_000, m: false }, { p: '99.9', q: '1', T: 99_500, m: true }];
  const micro = microstructure({ depth, trades, decisionAt: 100_000, notional: 450 });
  assert.ok(micro.buy_vwap >= micro.best_ask);
  assert.ok(micro.sell_vwap <= micro.best_bid);
  const decision = microDecision(TREND, micro, { virtual_notional_quote: 450, micro_max_spread_bps: 8, micro_max_slippage_bps: 15, micro_min_taker_buy_share: 0.48, micro_min_book_imbalance: -0.35 });
  assert.equal(decision.executable, false);
  assert.ok(decision.reasons.includes('SPREAD_TOO_WIDE'));
});

test('missing real-time taker flow delays entry instead of becoming a buy trigger', () => {
  const micro = {
    spread_bps: 1, estimated_slippage_bps: 1, bid_depth: 1000, ask_depth: 1000,
    buy_vwap: 100.01, sell_vwap: 99.99, book_imbalance: 0.1, taker_buy_share: null,
  };
  const decision = microDecision(TREND, micro, {
    virtual_notional_quote: 450, micro_max_spread_bps: 8, micro_max_slippage_bps: 15,
    micro_min_taker_buy_share: 0.48, micro_min_book_imbalance: -0.35,
  });
  assert.equal(decision.executable, false);
  assert.ok(decision.reasons.includes('TAKER_FLOW_UNFAVORABLE'));
});

const baseSnapshot = {
  chart: { previous_high_breakout: true, breakout_retest_support: false, upper_rejection: true, higher_low: false, last_close: 99, ma7: 100, distance_to_previous_high_pct: -0.1 },
  technical: { volume_acceleration: 0.5, obv_delta_5m: -1, macd_hist_delta: -1, macd_hist: -1, momentum_5m_pct: -1 },
  derivatives: { oi_change_15m_pct: 1 },
  microstructure: { best_bid: 100, book_imbalance: -0.4, taker_buy_share: 0.3 },
};

test('underlying -5.0 percent hard stop has priority over every other exit', () => {
  const position = { entry_price: 100, hard_stop_price: 95, entry_at: new Date(0).toISOString(), partial_exit_done: false };
  const choice = positionDecision({ strategy: TREND, position, snapshot: { ...baseSnapshot, microstructure: { ...baseSnapshot.microstructure, best_bid: 95 } }, at: 10_000, parameters: {} });
  assert.equal(choice.action, 'HARD_STOP');
  assert.ok(Math.abs(choice.trigger_return_pct + 5) < 1e-10);
});

test('squeeze cannot remain open beyond sixty minutes', () => {
  const position = { entry_price: 100, hard_stop_price: 95, entry_at: new Date(0).toISOString(), partial_exit_done: false };
  const quiet = { chart: {}, technical: {}, derivatives: {}, microstructure: { best_bid: 101, book_imbalance: 0.1, taker_buy_share: 0.6 } };
  const choice = positionDecision({ strategy: SQUEEZE, position, snapshot: quiet, at: 3_600_000, parameters: {} });
  assert.equal(choice.action, 'FULL_EXIT');
  assert.equal(choice.reason, 'SQUEEZE_MAX_HOLD_60M');
});

test('trend takes one 50 percent partial on first meaningful profitable weakness', () => {
  const parameters = { partial_exit_fraction: 0.5, weakness_partial_score: 2, weakness_full_score: 4, fee_bps_per_fill: 5 };
  const position = { entry_price: 99, hard_stop_price: 94.05, entry_at: new Date(0).toISOString(), partial_exit_done: false };
  const first = positionDecision({ strategy: TREND, position, snapshot: baseSnapshot, at: 60_000, parameters });
  assert.equal(first.action, 'PARTIAL_EXIT');
  assert.equal(first.fraction, 0.5);
  const second = positionDecision({ strategy: TREND, position: { ...position, partial_exit_done: true }, snapshot: baseSnapshot, at: 65_000, parameters });
  assert.equal(second.action, 'FULL_EXIT');
});

test('candidate outcome uses future candles only after the two-hour maturity boundary', () => {
  const minute = 60_000;
  const decisionAt = 30_000;
  const raw = Array.from({ length: 120 }, (_, index) => rawKline((index + 1) * minute, minute, 100, 100 + index / 100));
  const evaluatedAt = 121 * minute;
  const candles = parseKlines(raw, '1m', evaluatedAt + 1);
  assert.throws(() => candidateOutcome({ referencePrice: 100, decisionAt, candles, evaluatedAt: decisionAt + 119 * minute }), /NOT_MATURE/);
  const outcome = candidateOutcome({ referencePrice: 100, decisionAt, candles, evaluatedAt });
  assert.equal(outcome.candle_count, 120);
  assert.ok(outcome.forward_120m_pct > 1);
  assert.ok(outcome.mfe_2h_pct > 1);
});

test('only explicitly allowlisted Binance public market paths exist', () => {
  assert.equal(publicBinancePath('/fapi/v1/depth'), '/fapi/v1/depth');
  assert.throws(() => publicBinancePath('/fapi/v1/order'), /BINANCE_PUBLIC_PATH_BLOCKED/);
  assert.throws(() => publicBinancePath('/fapi/v2/account'), /BINANCE_PUBLIC_PATH_BLOCKED/);
});

test('runtime source has no production order or position-table capability', async () => {
  const source = await readFile(new URL('./handler.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/fapi\/v1\/order/);
  assert.doesNotMatch(source, /\/fapi\/v2\/account/);
  assert.doesNotMatch(source, /trading_positions/);
  assert.doesNotMatch(source, /trading_orders/);
  assert.match(source, /method: 'GET'/);
  assert.match(source, /order_capability: false/);
});
