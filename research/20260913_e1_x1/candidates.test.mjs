import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isFastWeak, startE1, advanceE1} from './e1-recovery.mjs';
import {observeX1} from './x1-fast-observer.mjs';

const t0 = 1_800_000_000_000;
const quote = (at, bid = 99.9, ask = 100.1) => ({bid, ask, receivedAt: at - 50, bookGap: false});
const trade = (eventAt, price, takerBuy, quantity = 1) => ({eventAt, price, quantity, takerBuy});
const block = (startAt, prices = [100, 100.1], buys = [true, true]) => ({
  startAt,
  endAt: startAt + 5_000,
  trades: prices.map((price, index) => trade(startAt + 500 + index * 1_000, price, buys[index])),
  quote: quote(startAt + 5_000, 99.95, 100.05),
});

test('E1 uses strict decimal fast-weak thresholds', () => {
  assert.equal(isFastWeak(-0.0021, 0.449), true);
  assert.equal(isFastWeak(-0.002, 0.449), false);
  assert.equal(isFastWeak(-0.0021, 0.45), false);
  assert.equal(isFastWeak(NaN, 0.4), null);
});

test('E1 preserves baseline rejection before examining microstructure', () => {
  const out = startE1({decisionAt: t0, signalExpiresAt: t0 + 60_000, signalId: 's1', symbol: 'XUSDT',
    baselineEligible: false, baselineReasonCodes: ['NO_CASH'], microstructure: {}});
  assert.equal(out.reject, true);
  assert.deepEqual(out.reasonCodes, ['NO_CASH']);
});

test('E1 returns UNKNOWN on missing quote instead of pass or reject', () => {
  const out = startE1({decisionAt: t0, signalExpiresAt: t0 + 60_000, signalId: 's1', symbol: 'XUSDT',
    baselineEligible: true, microstructure: {last10sReturn: -0.003, takerBuyQuoteShare10s: 0.4}});
  assert.equal(out.confirmationState, 'UNKNOWN');
  assert.equal(out.defer, true);
  assert.equal(out.allowed, false);
});

test('E1 confirms only two completed blocks and carries current executable prices', () => {
  let state = startE1({decisionAt: t0, signalExpiresAt: t0 + 45_000, signalId: 's1', symbol: 'XUSDT',
    baselineEligible: true, microstructure: {last10sReturn: -0.003, takerBuyQuoteShare10s: 0.4,
      quote: quote(t0), quoteAgeMs: 50}});
  assert.equal(state.confirmationState, 'WATCH_FAST_WEAK');
  assert.equal(state.expiresAt, t0 + 30_000);
  state = advanceE1(state, {observedAt: t0 + 5_100, block: block(t0), quote: quote(t0 + 5_100),
    entryGuardPassed: true, liquidityPassed: true, expectedEntryVWAP: 100.2,
    expectedExitVWAP: 99.8, expectedCostBps: 8});
  assert.equal(state.confirmationState, 'WATCH_FAST_WEAK');
  state = advanceE1(state, {observedAt: t0 + 10_100, block: block(t0 + 5_000, [100.2, 100.3]),
    quote: quote(t0 + 10_100, 100.4, 100.6), entryGuardPassed: true, liquidityPassed: true,
    expectedEntryVWAP: 100.65, expectedExitVWAP: 100.35, expectedCostBps: 7.5});
  assert.equal(state.confirmationState, 'RECOVERY_CONFIRMED');
  assert.equal(state.allowed, true);
  assert.equal(state.evaluatedPrice, 100.6);
  assert.equal(state.expectedEntryVWAP, 100.65);
  assert.notEqual(state.evaluatedPrice, 100.1);
});

test('E1 ignores duplicate blocks and never extends original TTL', () => {
  let state = startE1({decisionAt: t0, signalExpiresAt: t0 + 12_000, signalId: 's1', symbol: 'XUSDT',
    baselineEligible: true, microstructure: {last10sReturn: -0.003, takerBuyQuoteShare10s: 0.4,
      quote: quote(t0)}});
  state = advanceE1(state, {observedAt: t0 + 5_100, block: block(t0), quote: quote(t0 + 5_100)});
  const duplicate = advanceE1(state, {observedAt: t0 + 5_200, block: block(t0), quote: quote(t0 + 5_200)});
  assert.equal(duplicate.watch.observedBlocks, 1);
  assert.equal(duplicate.expiresAt, t0 + 12_000);
  const expired = advanceE1(duplicate, {observedAt: t0 + 12_000});
  assert.equal(expired.confirmationState, 'EXPIRED');
  assert.equal(expired.allowed, false);
});

test('buyerIsMaker=true is taker sell and cannot fake recovery buy share', () => {
  let state = startE1({decisionAt: t0, signalExpiresAt: t0 + 30_000, signalId: 's1', symbol: 'XUSDT',
    baselineEligible: true, microstructure: {last10sReturn: -0.003, takerBuyQuoteShare10s: 0.4,
      quote: quote(t0)}});
  const sellBlock = block(t0);
  sellBlock.trades = [
    {eventAt: t0 + 500, price: 100, quantity: 1, buyerIsMaker: true},
    {eventAt: t0 + 1500, price: 100.1, quantity: 1, buyerIsMaker: true},
  ];
  state = advanceE1(state, {observedAt: t0 + 5_100, block: sellBlock, quote: quote(t0 + 5_100)});
  assert.equal(state.watch.passedBlocks.length, 0);
});

function position(overrides = {}) {
  return {id: 'p1', entryPrice: 100, entryAt: t0, entryFee: 0.06, quantity: 1.2,
    peakPrice: 100, observedBidPeak: 100, executableVwapPeak: null, stopPrice: 97.5,
    lastHighAt: t0, priceTick: 0.01, nativeOrderGeneration: 1, ownership: 'AUTO', ...overrides};
}
function obs(at, bid, overrides = {}) {
  return {id: `o-${at}`, observedAt: at, bid, ask: bid + 0.01,
    quoteReceivedAt: at - 50, bookGap: false, sellVwap: bid - 0.02, ...overrides};
}

test('X1 does not arm +2% profit lock from a non-executable trade high', () => {
  const out = observeX1(position(), obs(t0 + 60_000, 101.979, {tradeHigh: 102.496}));
  assert.equal(out.protectionStage, 'RISK_CUT');
  assert.equal(out.stopAfter, 98.8);
  assert.ok(out.reasonCodes.includes('TRADE_HIGH_AUDIT_ONLY_NOT_EXECUTABLE_PEAK'));
  assert.equal(out.observedBidPeak, 101.979);
});

test('X1 arms unchanged R5 profit lock only from observed bid', () => {
  const out = observeX1(position(), obs(t0 + 60_000, 102.01));
  assert.equal(out.protectionStage, 'PROFIT_LOCK');
  assert.equal(out.stopAfter, 101.01);
  assert.equal(out.nativeStopCandidate.stopPrice, 101.01);
});

test('X1 never lowers a stop and closes instead of proposing an already-crossed stop', () => {
  const monotone = observeX1(position({peakPrice: 102.2, observedBidPeak: 102.2, stopPrice: 101.5}),
    obs(t0 + 60_000, 101.8));
  assert.equal(monotone.stopAfter, 101.5);
  const crossed = observeX1(position({peakPrice: 102.2, observedBidPeak: 102.2, stopPrice: 98.8}),
    obs(t0 + 60_000, 100.5));
  assert.equal(crossed.action, 'CLOSE');
  assert.equal(crossed.nativeStopCandidate, null);
});

test('X1 fails closed on stale or gapped quotes without changing protection', () => {
  const out = observeX1(position(), obs(t0 + 60_000, 101, {quoteReceivedAt: t0 + 58_000}));
  assert.equal(out.dataState, 'UNKNOWN');
  assert.equal(out.stopAfter, 97.5);
  assert.equal(out.nativeStopCandidate, null);
});

const bar = (openTime, open, high, low, close) =>
  [openTime, String(open), String(high), String(low), String(close), '1', openTime + 59_999, '1000', 10, '1', '600', '0'];

test('X1 evaluates QV3 only on a new completed candle', () => {
  const bars = [
    bar(t0, 100, 101, 99.9, 100.5),
    bar(t0 + 60_000, 101, 101.1, 100.6, 100.8),
    bar(t0 + 120_000, 100.8, 100.9, 100.1, 100.2),
  ];
  const first = observeX1(position({entryAt: t0, lastHighAt: t0, lastQv3BarOpen: null}),
    obs(t0 + 180_001, 100.5), bars);
  assert.equal(first.action, 'CLOSE');
  assert.equal(first.reasonCodes[0], 'QV3_TWO_BEARISH_CLOSED');
  const duplicate = observeX1(position({entryAt: t0, lastHighAt: t0, lastQv3BarOpen: t0 + 120_000}),
    obs(t0 + 180_500, 100.5), bars);
  assert.equal(duplicate.action, 'HOLD');
});

test('candidate modules contain no order/network/timer side effects', async () => {
  for (const name of ['e1-recovery.mjs', 'x1-fast-observer.mjs']) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    for (const forbidden of ['fetch(', 'setInterval(', 'setTimeout(', 'create_order', 'exchangeGateway('])
      assert.equal(source.includes(forbidden), false, `${name} contains ${forbidden}`);
  }
});
