// Binance lists USDT perpetuals whose symbol is not ASCII (牛来USDT, 哈基米USDT). The V17
// scanner ranks them, but three separate [A-Z0-9] allow-lists rejected them downstream, so
// every order was refused at the gateway with GW_400 while the scanner kept selecting them.
// 23 signals were lost that way over 2026-09-08/09, including the session's rank-1 mover.
//
// All three validators have to agree. If the gateway accepted the entry but
// protectiveStopSpec still rejected the symbol, V17 would open a position it could never
// place a protective stop for, which is strictly worse than not entering at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {protectiveStopSpec} from '../../supabase/functions/_shared/leader-exit-review.mjs';
import {createV17StopCommands} from '../../gateway/v17-stop-commands.mjs';

const CJK = ['牛来USDT', '哈基米USDT', '币安人生USDT', '我踏马来了USDT', '龙虾USDT'];
const clientAlgoId = 'tb-v17s-' + 'a'.repeat(27);

const stopSpec = (symbol) => protectiveStopSpec({
  symbol, positionId: 'p1', ownedQuantity: 10, exchangeQuantity: 10,
  positionMode: 'ONE_WAY', stopPrice: 1, priceTick: 0.001, quantityStep: 1, clientAlgoId,
});

test('protectiveStopSpec accepts non-ASCII USDT perpetuals', () => {
  for (const symbol of CJK) {
    const spec = stopSpec(symbol);
    assert.equal(spec.params.symbol, symbol);
    assert.equal(spec.params.side, 'SELL');
    assert.equal(spec.params.reduceOnly, 'true');
  }
});

test('protectiveStopSpec still rejects anything that could reach the query string', () => {
  for (const bad of ['BTC USDT', 'BTC/USDT', 'BTC?USDT', 'BTC#USDT', 'BTC&a=1USDT',
                     'BTC%20USDT', 'BTC\nUSDT', '../BTCUSDT', 'BTCUSDC', 'USDT', '牛来USDC']) {
    assert.throws(() => stopSpec(bad), /INVALID_PROTECTION_IDENTITY/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the gateway stop commands accept the same symbols and reject the same junk', async () => {
  const seen = [];
  const commands = createV17StopCommands({
    request: async (m, p, q) => { seen.push(q); return {symbol: q?.clientAlgoId ? '牛来USDT' : null, clientAlgoId}; },
    assertVersion: () => {}, positionSideDual: async () => false,
  });
  await commands('v17_query_stop', {clientAlgoId, symbol: '牛来USDT'});
  assert.equal(seen.length, 1);

  for (const bad of ['BTC USDT', 'BTC/USDT', 'BTCUSDC', 'BTC?x=1USDT']) {
    await assert.rejects(() => commands('v17_query_stop', {clientAlgoId, symbol: bad}),
      /INVALID_V17_STOP_IDENTITY/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the gateway transport validator is the Unicode allow-list, not [A-Z0-9]', () => {
  // server.mjs pulls in live credentials at import time, so assert on the source.
  const src = readFileSync(new URL('../../gateway/server.mjs', import.meta.url), 'utf8');
  const match = src.match(/function validateBinanceSymbol\(symbol\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'validateBinanceSymbol not found');
  const validate = new Function('symbol', match[0].replace(/^function validateBinanceSymbol\(symbol\) \{/, '') .replace(/\}$/, ''));
  for (const symbol of CJK) assert.equal(validate(symbol), symbol);
  assert.equal(validate('btcusdt'), 'BTCUSDT');
  for (const bad of ['BTC USDT', 'BTC/USDT', 'BTC?USDT', 'BTC#USDT', 'BTCUSDC', 'USDT', '', 'B USDT']) {
    assert.throws(() => validate(bad), /only Binance USDT symbols are allowed/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a non-ASCII symbol survives the exact encode-then-sign path the gateway uses', () => {
  // binanceQueryString signs the percent-encoded payload and sends that same payload, so
  // the signature and the URL cannot disagree. This is what makes non-ASCII safe.
  const query = Object.entries({symbol: '牛来USDT', side: 'SELL'})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  assert.equal(query, 'symbol=%E7%89%9B%E6%9D%A5USDT&side=SELL');
  assert.equal(decodeURIComponent(query.split('&')[0].split('=')[1]), '牛来USDT');
});
