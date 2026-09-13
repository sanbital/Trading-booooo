import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const evidenceDir = process.argv[2] ?? 'evidence';
const protocolPath = process.argv[3] ?? 'research/20260912_v20/protocol.json';
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const analysisStartMs = Date.parse(protocol.time_boundaries.cumulative_start_utc);
const analysisCutoffMs = Date.parse(protocol.time_boundaries.analysis_cutoff_utc);
if (!Number.isFinite(analysisStartMs) || !Number.isFinite(analysisCutoffMs)) {
  throw new Error('INVALID_PROTOCOL_BOUNDARY');
}

function readJsonl(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`INVALID_JSONL:${path}:${index + 1}:${error.message}`);
    }
  });
}

function saveJson(name, value) {
  writeFileSync(`${evidenceDir}/${name}`, `${JSON.stringify(value)}\n`);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`NON_JSON_HTTP_${response.status}`);
      }
      if (!response.ok) {
        const error = new Error(`HTTP_${response.status}:${String(body?.msg ?? body?.error ?? '').slice(0, 160)}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || error?.retryable === false) break;
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function floorMinute(ms) {
  return Math.floor(ms / 60_000) * 60_000;
}

function ceilMinute(ms) {
  return Math.ceil(ms / 60_000) * 60_000;
}

function positionRange(position) {
  const start = Date.parse(position.entry_at);
  const closed = Date.parse(position.closed_at ?? '');
  const end = Number.isFinite(closed) ? closed : analysisCutoffMs;
  return {
    start: Math.max(analysisStartMs - 120_000, floorMinute(start) - 120_000),
    end: ceilMinute(Math.min(end + 30 * 60_000, Date.now() - 60_000)),
  };
}

function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 5 * 60_000) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function normalizeKline(row) {
  if (!Array.isArray(row) || row.length < 11) throw new Error('BINANCE_KLINE_SHAPE');
  const values = {
    open_time_ms: finite(row[0]),
    open: finite(row[1]),
    high: finite(row[2]),
    low: finite(row[3]),
    close: finite(row[4]),
    volume: finite(row[5]),
    close_time_ms: finite(row[6]),
    quote_volume: finite(row[7]),
    trade_count: finite(row[8]),
    taker_buy_base: finite(row[9]),
    taker_buy_quote: finite(row[10]),
  };
  if (Object.values(values).some((value) => value === null)) throw new Error('BINANCE_KLINE_NUMERIC');
  return values;
}

async function fetchKlineRange(symbol, range) {
  const candles = [];
  let next = range.start;
  while (next <= range.end) {
    const params = new URLSearchParams({
      symbol,
      interval: '1m',
      startTime: String(next),
      endTime: String(range.end),
      limit: '1000',
    });
    const body = await fetchJson(`https://fapi.binance.com/fapi/v1/klines?${params}`);
    if (!Array.isArray(body)) throw new Error('BINANCE_KLINE_RESPONSE');
    if (!body.length) break;
    const page = body.map(normalizeKline);
    candles.push(...page);
    const last = page.at(-1).open_time_ms;
    if (!(last >= next)) throw new Error('BINANCE_KLINE_NON_MONOTONIC');
    next = last + 60_000;
    if (body.length < 1000 || next > range.end) break;
    await sleep(50);
  }
  return candles;
}

const positions = readJsonl(`${evidenceDir}/positions.jsonl`);
const positionSymbols = new Map();
for (const position of positions) {
  const symbol = String(position.symbol ?? '').toUpperCase();
  const entry = Date.parse(position.entry_at ?? '');
  if (!symbol || !Number.isFinite(entry) || entry < analysisStartMs || entry > analysisCutoffMs) continue;
  const ranges = positionSymbols.get(symbol) ?? [];
  ranges.push(positionRange(position));
  positionSymbols.set(symbol, ranges);
}
const symbols = [...positionSymbols.keys()].sort();

const candleResults = await mapLimit(symbols, 4, async (symbol) => {
  try {
    const all = [];
    for (const range of mergeRanges(positionSymbols.get(symbol))) {
      all.push(...await fetchKlineRange(symbol, range));
    }
    const byOpen = new Map(all.map((row) => [row.open_time_ms, row]));
    const candles = [...byOpen.values()].sort((a, b) => a.open_time_ms - b.open_time_ms);
    const gaps = [];
    for (let index = 1; index < candles.length; index += 1) {
      const delta = candles[index].open_time_ms - candles[index - 1].open_time_ms;
      if (delta !== 60_000) gaps.push({ after: candles[index - 1].open_time_ms, delta_ms: delta });
    }
    return { symbol, complete: gaps.length === 0, candles, gaps };
  } catch (error) {
    return { symbol, complete: false, candles: [], gaps: [], error: String(error?.message ?? error).slice(0, 300) };
  }
});
saveJson('candles-1m.json', {
  source: 'BINANCE_FUTURES_PUBLIC_POST_HOC_KLINES',
  collected_at: new Date().toISOString(),
  interval: '1m',
  results: candleResults,
});

const gatewayApp = process.env.FLY_BINANCE_APP_NAME;
const learningToken = process.env.LEARNING_ACCESS_TOKEN;
if (!gatewayApp || !learningToken || learningToken.length < 32) throw new Error('MISSING_GATEWAY_READ_CONFIG');
const gatewayUrl = `https://${gatewayApp}.fly.dev`;
const gatewaySecret = crypto.createHash('sha256').update(`gateway:${learningToken}`).digest('hex');

async function gateway(command) {
  const body = JSON.stringify({ exchange: 'binance_futures', ...command });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto.createHmac('sha256', gatewaySecret)
    .update(`${timestamp}\n${nonce}\n${body}`)
    .digest('hex');
  const result = await fetchJson(`${gatewayUrl}/v1/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gateway-ts': timestamp,
      'x-gateway-nonce': nonce,
      'x-gateway-signature': signature,
    },
    body,
  }, 1);
  if (result?.ok !== true) throw new Error(`GATEWAY_READ:${String(result?.error ?? 'NOT_OK').slice(0, 200)}`);
  return result.result;
}

const healthRaw = await fetchJson(`${gatewayUrl}/health`, {}, 1);
const gatewayHealth = {
  observed_at: new Date().toISOString(),
  status: healthRaw?.status ?? healthRaw?.ok ?? null,
  ops_patch: healthRaw?.ops_patch ?? null,
  version: healthRaw?.version ?? null,
  commit: healthRaw?.commit ?? null,
};
saveJson('gateway-health.json', gatewayHealth);

const signedReads = await mapLimit(symbols, 3, async (symbol) => {
  const result = { symbol, trades: [], orders: [], trade_history_complete: null, order_history_complete: null };
  try {
    const trades = await gateway({ action: 'trade_history', market: symbol, limit: 1000 });
    if (!Array.isArray(trades)) throw new Error('TRADE_HISTORY_SHAPE');
    result.trades = trades.filter((trade) => {
      const time = finite(trade?.time);
      return time !== null && time >= analysisStartMs - 5 * 60_000 && time <= analysisCutoffMs;
    });
    result.trade_history_complete = trades.length < 1000;
    result.trade_history_returned = trades.length;
  } catch (error) {
    result.trade_error = String(error?.message ?? error).slice(0, 300);
    result.trade_history_complete = false;
  }
  try {
    const orders = await gateway({
      action: 'order_history',
      market: symbol,
      start_time: analysisStartMs - 5 * 60_000,
      end_time: analysisCutoffMs,
      limit: 1000,
    });
    if (!Array.isArray(orders)) throw new Error('ORDER_HISTORY_SHAPE');
    result.orders = orders;
    result.order_history_complete = orders.length < 1000;
    result.order_history_returned = orders.length;
  } catch (error) {
    result.order_error = String(error?.message ?? error).slice(0, 300);
    result.order_history_complete = false;
  }
  return result;
});
saveJson('signed-fills.json', {
  source: 'SIGNED_BINANCE_FUTURES_ACCOUNT_TRADE_HISTORY',
  collected_at: new Date().toISOString(),
  results: signedReads.map(({ orders, ...row }) => row),
});
saveJson('signed-orders.json', {
  source: 'SIGNED_BINANCE_FUTURES_ACCOUNT_ORDER_HISTORY',
  collected_at: new Date().toISOString(),
  results: signedReads.map(({ trades, ...row }) => row),
});

const stopRefs = [];
for (const position of positions) {
  const symbol = String(position.symbol ?? '').toUpperCase();
  const generation = position.metadata?.exitProtection?.generation ?? null;
  const orders = Array.isArray(position.metadata?.exitProtection?.orders)
    ? position.metadata.exitProtection.orders
    : [];
  for (const order of orders) {
    const clientAlgoId = order?.clientId ?? order?.spec?.params?.clientAlgoId;
    if (!symbol || !clientAlgoId) continue;
    stopRefs.push({
      position_id: position.id,
      symbol,
      generation,
      client_algo_id: String(clientAlgoId),
      recorded_algo_id: order?.algoId == null ? null : String(order.algoId),
      recorded_actual_order_id: order?.actualOrderId == null ? null : String(order.actualOrderId),
      recorded_status: order?.status ?? null,
      recorded_terminal: order?.terminal ?? null,
      recorded_trade_ids: order?.tradeIds ?? [],
    });
  }
}
const uniqueStops = [...new Map(stopRefs.map((row) => [`${row.symbol}:${row.client_algo_id}`, row])).values()];
const stopResults = await mapLimit(uniqueStops, 3, async (reference) => {
  try {
    const result = await gateway({
      action: 'v17_query_stop',
      symbol: reference.symbol,
      clientAlgoId: reference.client_algo_id,
    });
    return { ...reference, query_ok: true, result };
  } catch (error) {
    return { ...reference, query_ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
});
saveJson('signed-native-stops.json', {
  source: 'SIGNED_BINANCE_FUTURES_NATIVE_STOP_LOOKUP',
  collected_at: new Date().toISOString(),
  results: stopResults,
});

const liveRead = { collected_at: new Date().toISOString() };
try {
  liveRead.portfolio = await gateway({ action: 'p10_portfolio' });
} catch (error) {
  liveRead.portfolio_error = String(error?.message ?? error).slice(0, 300);
}
try {
  liveRead.open_orders = await gateway({ action: 'v18_open_orders' });
} catch (error) {
  liveRead.open_orders_error = String(error?.message ?? error).slice(0, 300);
}
saveJson('signed-current-account.json', liveRead);

const summary = {
  collected_at: new Date().toISOString(),
  protocol: protocol.protocol,
  positions: positions.length,
  symbols: symbols.length,
  candle_symbols_complete: candleResults.filter((row) => row.complete).length,
  candle_symbols_failed: candleResults.filter((row) => row.error).map((row) => row.symbol),
  signed_trade_symbols_complete: signedReads.filter((row) => row.trade_history_complete).length,
  signed_trade_symbols_failed: signedReads.filter((row) => row.trade_error).map((row) => row.symbol),
  signed_order_symbols_complete: signedReads.filter((row) => row.order_history_complete).length,
  signed_order_symbols_failed: signedReads.filter((row) => row.order_error).map((row) => row.symbol),
  native_stop_references: uniqueStops.length,
  native_stop_queries_ok: stopResults.filter((row) => row.query_ok).length,
  native_stop_queries_failed: stopResults.filter((row) => !row.query_ok).length,
  gateway_ops_patch: gatewayHealth.ops_patch,
  current_portfolio_read_ok: liveRead.portfolio != null,
  current_open_orders_read_ok: liveRead.open_orders != null,
};
saveJson('collection-summary.json', summary);
console.log(JSON.stringify(summary));
