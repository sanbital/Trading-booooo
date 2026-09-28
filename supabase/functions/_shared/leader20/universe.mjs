import {CLOCK_VERSION,preparationSlot,SLOT_MS,CAPTURE_MS,PREWARM_MS} from './clock.mjs';
import {hash} from '../gpt-final-review/contract.mjs';

export const LEADER20 = 'LEADER20_DYNAMIC_1';
export const SELECTION_VERSION = 'BINANCE_USDM_COIN_ROLLING24H_TOP20_6H_KST_1';
export const EPOCH_MS = 6 * 3600_000;
const KST_MS = 9 * 3600_000;
const time = Number.isSafeInteger;
const number = x => typeof x === 'number' || typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function require(ok, reason) { if (!ok) throw Error('LEADER20_' + reason); }

export function epochBoundary(at) {
  require(time(at) && at > 0, 'CLOCK_INVALID');
  return Math.floor((at + KST_MS) / EPOCH_MS) * EPOCH_MS - KST_MS;
}
export const nextBoundary = at => epochBoundary(at) + EPOCH_MS;
export function coinContract(s) {
  return s?.status === 'TRADING' && s.contractType === 'PERPETUAL' &&
    s.quoteAsset === 'USDT' && s.marginAsset === 'USDT' && s.underlyingType === 'COIN' &&
    typeof s.symbol === 'string' && /^[\p{L}\p{N}]{1,24}USDT$/u.test(s.symbol);
}

/** A complete exchange snapshot is required. No volume/momentum admission threshold. */
export async function selectEpoch({exchangeInfo, tickers, requestedAt, observedAt, previous = null, clock = false}) {
  require(time(requestedAt) && time(observedAt) && observedAt >= requestedAt && observedAt - requestedAt < 30000, 'SOURCE_TIME');
  require(Array.isArray(exchangeInfo?.symbols) && Array.isArray(tickers), 'SOURCE_SHAPE');
  require(new Set(exchangeInfo.symbols.map(x => x.symbol)).size === exchangeInfo.symbols.length, 'DUPLICATE_METADATA');
  const universe = exchangeInfo.symbols.filter(coinContract).map(x => x.symbol).sort(compare);
  require(universe.length >= 20, 'UNIVERSE_INCOMPLETE');
  const bySymbol = new Map();
  for (const t of tickers) {
    require(typeof t?.symbol === 'string' && !bySymbol.has(t.symbol), 'DUPLICATE_TICKER');
    bySymbol.set(t.symbol, t);
  }
  const eligible = universe.map(symbol => {
    const t = bySymbol.get(symbol), change = number(t?.priceChangePercent), volume = number(t?.quoteVolume);
    require(t && Number.isFinite(change) && Number.isFinite(volume) && volume >= 0, 'TICKER_COVERAGE');
    require(time(t.openTime) && time(t.closeTime) && t.closeTime > t.openTime &&
      t.closeTime <= observedAt + 1000, 'TICKER_TIME');
    return {symbol, price_change_percent: change, quote_volume: volume, open_time: t.openTime, close_time: t.closeTime, ticker_age_ms: observedAt - t.closeTime};
  }).sort((a, b) => b.price_change_percent - a.price_change_percent || b.quote_volume - a.quote_volume || compare(a.symbol, b.symbol));
  // A quiet contract may report an older closeTime in a fresh all-market response.
  // Keep its actual rolling statistic and timestamp; never filter the universe by trade activity.
  // A response whose entire eligible market is stale still cannot publish an epoch.
  const freshestClose = Math.max(...eligible.map(x => x.close_time));
  require(observedAt - freshestClose < 30000, 'TICKER_SOURCE_STALE');
  // Restart never moves the regular boundary. A late first installation is explicitly BOOTSTRAP.
  const slot=preparationSlot(requestedAt);
  const scheduled = clock ? slot-CAPTURE_MS-PREWARM_MS : previous ? epochBoundary(requestedAt) : requestedAt;
  require(clock||!previous||requestedAt>=previous.next_refresh_at_ms,'EPOCH_NOT_DUE');
  require(!clock||requestedAt>=scheduled&&requestedAt<slot-CAPTURE_MS,'CLOCK_PREPARATION_NOT_DUE');
  require(observedAt < nextBoundary(requestedAt), 'SOURCE_CROSSED_BOUNDARY');
  const sources = {exchange_info: exchangeInfo, ticker_24hr: tickers};
  return {strategy: LEADER20, selection_version: clock?CLOCK_VERSION:SELECTION_VERSION, kind: previous ? 'SCHEDULED' : 'BOOTSTRAP',
    scheduled_at_ms: scheduled, requested_at_ms: requestedAt, observed_at_ms: observedAt,
    effective_at_ms: observedAt, next_refresh_at_ms: clock?scheduled+SLOT_MS:nextBoundary(observedAt),
    ...(clock?{capture_slot_ms:slot}:{}),
    universe, expected_count: universe.length, covered_count: eligible.length, source_freshest_close_ms: freshestClose,
    members: eligible.slice(0, 20).map((x, i) => ({rank: i + 1, ...x})),
    source: 'BINANCE_FAPI_V1_EXCHANGE_INFO_AND_TICKER_24HR',
    source_hash: await hash(sources), sources};
}

export async function fetchEpoch(previous, {fetchFn = fetch, now = Date.now,clock=false} = {}) {
  const requestedAt = now();
  const get = async path => {
    const r = await fetchFn('https://fapi.binance.com/fapi/v1/' + path, {signal: AbortSignal.timeout(8000)});
    require(r.ok, 'HTTP_' + r.status);
    return r.json();
  };
  const [exchangeInfo, tickers] = await Promise.all([get('exchangeInfo'), get('ticker/24hr')]);
  return selectEpoch({exchangeInfo, tickers, requestedAt, observedAt: now(), previous,clock});
}

/** Membership never supplies a BUY or an EXIT. Stale membership still supplies a watch. */
export function membership(epoch, symbol, at, hasExposure = false) {
  const member = epoch?.members?.find(x => x.symbol === symbol) ?? null;
  return {member, watch: !!member || hasExposure, manage_only: !member && hasExposure,
    entry_eligible: !!member && at >= epoch.effective_at_ms && at < epoch.next_refresh_at_ms,
    reason: !member ? 'UNIVERSE_EXPIRED' : at >= epoch.next_refresh_at_ms ? 'DEFER_UNIVERSE_STALE' : null};
}
