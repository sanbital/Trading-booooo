/**
 * B06133 is an entry-selection gate, not a signal generator.
 *
 * It is evaluated only after the existing leader signal and completed-1m
 * pullback/re-acceleration trigger have admitted a candidate.  The functions in
 * this file are deliberately pure except for fetchB06133Inputs, so research and
 * live code can exercise the same three-valued decision logic.
 */
export const B06133_VERSION = 'B06133_ENTRY_SELECTION_1';
export const B06133_RULE = Object.freeze({
  id: 'B06133',
  family: 'R62_rescue',
  label: '(absorption AND volumeTails AND fresh15over30 AND btcAnyUp) OR (buyerShareRise AND NOT fresh5over15 AND NOT recentHourLead)',
  clauses: Object.freeze([[4, 4128], [89, 0]]),
});

const MINUTE = 60_000;
const BTC_INTERVAL = 15 * MINUTE;
const VALID_SYMBOL = /^[A-Z0-9]{2,60}USDT$/;
const valid = value => value != null && Number.isFinite(Number(value));
const tri = value => value === true || value === false ? value : null;

export function and3(...values) {
  const xs = values.map(tri);
  if (xs.includes(false)) return false;
  return xs.includes(null) ? null : true;
}

export function or3(...values) {
  const xs = values.map(tri);
  if (xs.includes(true)) return true;
  return xs.includes(null) ? null : false;
}

export function not3(value) {
  const x = tri(value);
  return x === null ? null : !x;
}

function normalizedPrebars(raw, decisionAt) {
  if (!Number.isSafeInteger(decisionAt) || decisionAt <= 0 || decisionAt % MINUTE !== 0 || !Array.isArray(raw)) return null;
  const byOpen = new Map();
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 11) continue;
    const openTime = Number(row[0]);
    if (!Number.isSafeInteger(openTime) || byOpen.has(openTime)) return null;
    byOpen.set(openTime, row);
  }
  const bars = [];
  for (let i = 3; i >= 1; i--) {
    const openTime = decisionAt - i * MINUTE, row = byOpen.get(openTime);
    if (!row) return null;
    const bar = {
      openTime,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      closeTime: Number(row[6]),
      quoteVolume: Number(row[7]),
      takerBuyQuote: Number(row[10]),
    };
    if (bar.closeTime !== openTime + MINUTE - 1 || bar.closeTime >= decisionAt ||
        !(bar.quoteVolume > 0) || !(bar.takerBuyQuote >= 0 && bar.takerBuyQuote <= bar.quoteVolume) ||
        ![bar.open, bar.high, bar.low, bar.close].every(x => Number.isFinite(x) && x > 0)) return null;
    bars.push(bar);
  }
  return bars;
}

function normalizedBtc(raw, decisionAt) {
  if (!Number.isSafeInteger(decisionAt) || decisionAt <= 0 || !Array.isArray(raw)) return null;
  const rows = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const openTime = Number(row[0]), close = Number(row[4]), closeTime = Number(row[6]);
    if (!Number.isSafeInteger(openTime) || openTime % BTC_INTERVAL !== 0 ||
        closeTime !== openTime + BTC_INTERVAL - 1 || closeTime >= decisionAt || !(close > 0)) continue;
    rows.push({openTime, close, closeTime});
  }
  rows.sort((a, b) => a.openTime - b.openTime);
  const unique = [...new Map(rows.map(x => [x.openTime, x])).values()].slice(-9);
  if (unique.length !== 9) return null;
  for (let i = 1; i < unique.length; i++) if (unique[i].openTime - unique[i - 1].openTime !== BTC_INTERVAL) return null;
  const last = unique.at(-1), freshnessMs = decisionAt - (last.openTime + BTC_INTERVAL);
  if (freshnessMs < 0 || freshnessMs >= BTC_INTERVAL) return null;
  return {bars: unique, freshnessMs};
}

export function b06133Inputs({features, prebars, btcBars, decisionAt, marketErrors = null}) {
  const f = features && typeof features === 'object' ? features : {};
  const bars = normalizedPrebars(prebars, decisionAt);
  const btc = normalizedBtc(btcBars, decisionAt);
  let absorption = null, buyerShareRise = null;
  if (bars) {
    const buy = bars.reduce((sum, b) => sum + b.takerBuyQuote, 0);
    const quote = bars.reduce((sum, b) => sum + b.quoteVolume, 0);
    const shares = bars.map(b => b.takerBuyQuote / b.quoteVolume);
    absorption = quote - buy >= buy && bars[2].close >= bars[0].open;
    buyerShareRise = shares[2] > shares[0] && shares[2] > shares[1];
  }
  const volumeTails = valid(f.volumeRatio) ? Number(f.volumeRatio) < 1 || Number(f.volumeRatio) >= 4 : null;
  const fresh15over30 = [f.return15m, f.return30m].every(valid)
    ? 2 * Number(f.return15m) > Number(f.return30m) : null;
  const fresh5over15 = [f.return5m, f.return15m].every(valid)
    ? 3 * Number(f.return5m) > Number(f.return15m) : null;
  const recentHourLead = [f.return15m, f.return60m].every(valid) && Number(f.return15m) > -1
    ? Number(f.return15m) > 0 && Number(f.return15m) >
      (1 + Number(f.return60m)) / (1 + Number(f.return15m)) - 1
    : null;
  const btcRegime = btc ? {
    known: true,
    return30m: btc.bars[8].close / btc.bars[6].close - 1,
    return2h: btc.bars[8].close / btc.bars[0].close - 1,
    freshnessMs: btc.freshnessMs,
  } : {known: false, return30m: null, return2h: null, freshnessMs: null};
  const btcAnyUp = btcRegime.known ? btcRegime.return30m > 0 || btcRegime.return2h > 0 : null;
  return {
    factors: {absorption, volumeTails, fresh15over30, btcAnyUp, buyerShareRise, fresh5over15, recentHourLead},
    source: {
      decisionAt,
      featureValues: {
        volumeRatio: valid(f.volumeRatio) ? Number(f.volumeRatio) : null,
        return5m: valid(f.return5m) ? Number(f.return5m) : null,
        return15m: valid(f.return15m) ? Number(f.return15m) : null,
        return30m: valid(f.return30m) ? Number(f.return30m) : null,
        return60m: valid(f.return60m) ? Number(f.return60m) : null,
      },
      prebars: bars,
      btc: btcRegime,
      btcBars: btc?.bars ?? null,
      marketErrors,
    },
  };
}

export function evaluateB06133Factors(factors = {}) {
  const r62 = and3(factors.absorption, factors.volumeTails, factors.fresh15over30, factors.btcAnyUp);
  const rescue = and3(factors.buyerShareRise, not3(factors.fresh5over15), not3(factors.recentHourLead));
  const result = or3(r62, rescue);
  const branch = result === true
    ? r62 === true && rescue === true ? 'BOTH' : r62 === true ? 'R62' : 'BUYER_SHARE_RESCUE'
    : null;
  return {result, allowed: result === true, branch, r62, rescue};
}

export function evaluateB06133(input) {
  const prepared = b06133Inputs(input), decision = evaluateB06133Factors(prepared.factors);
  return {
    version: B06133_VERSION,
    rule: B06133_RULE,
    ...decision,
    reason: decision.allowed ? 'B06133_ALLOW' : decision.result === null ? 'B06133_INPUT_UNKNOWN' : 'B06133_REJECT',
    factors: prepared.factors,
    source: prepared.source,
  };
}

async function fetchKlines({symbol, interval, startTime, endTime, limit, fetchFn}) {
  const params = new URLSearchParams({symbol, interval, startTime: String(startTime), endTime: String(endTime), limit: String(limit)});
  const response = await fetchFn('https://fapi.binance.com/fapi/v1/klines?' + params, {
    method: 'GET', signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw Error(`B06133_MARKET_${symbol}_${interval}_${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw Error(`B06133_MARKET_${symbol}_${interval}_INVALID`);
  return rows;
}

/** Two bounded point reads only: three symbol minutes and nine BTC 15m bars. */
export async function fetchB06133Inputs(symbol, decisionAt, fetchFn = fetch) {
  const market = String(symbol ?? '').toUpperCase();
  if (!VALID_SYMBOL.test(market) || !Number.isSafeInteger(decisionAt) || decisionAt <= 0 || decisionAt % MINUTE !== 0)
    throw Error('B06133_MARKET_INPUT');
  const lastBtcOpen = Math.floor(decisionAt / BTC_INTERVAL) * BTC_INTERVAL - BTC_INTERVAL;
  const [prebars, btcBars] = await Promise.allSettled([
    fetchKlines({symbol: market, interval: '1m', startTime: decisionAt - 3 * MINUTE,
      endTime: decisionAt - 1, limit: 3, fetchFn}),
    fetchKlines({symbol: 'BTCUSDT', interval: '15m', startTime: lastBtcOpen - 8 * BTC_INTERVAL,
      endTime: decisionAt - 1, limit: 9, fetchFn}),
  ]);
  const errors={
    prebars: prebars.status === 'rejected' ? String(prebars.reason?.message ?? prebars.reason).slice(0,300) : null,
    btc: btcBars.status === 'rejected' ? String(btcBars.reason?.message ?? btcBars.reason).slice(0,300) : null,
  };
  return {prebars:prebars.status === 'fulfilled' ? prebars.value : null,
    btcBars:btcBars.status === 'fulfilled' ? btcBars.value : null,
    marketErrors:errors.prebars||errors.btc?errors:null};
}
