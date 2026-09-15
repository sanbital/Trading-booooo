/**
 * V24 LEADER CONTINUATION -- deterministic strategy core for Binance USDT perpetual LONG.
 *
 * "Buy today's strong movers that are still strong right now. Hold while the move is
 *  intact and protect realised net profit. Leave when the reason to be long breaks."
 *
 * This module is PURE. No IO, no clock, no exchange access, no order submission. Every
 * function takes an explicit `now` and explicit, already-closed market data. That is what
 * makes the same code usable by the live executor and by the replay engine without
 * look-ahead: a bar is only visible once `closeMs < now`.
 *
 * UNITS (never mixed):
 *   return  -- decimal fraction of PRICE (unleveraged)
 *   bps     -- return * 10_000
 *   atr     -- price units
 *   usdt    -- account currency, after leverage
 *   R0      -- initial price risk of the position in USDT = q0 * (E - S0)
 *
 * Missing / insufficient data is UNKNOWN. UNKNOWN never passes a gate. It is never
 * coerced to a neutral value and never read as "not weak, therefore fine".
 *
 * Thresholds in V24_POLICY are PREREGISTERED STARTING VALUES, not discovered constants.
 * `parametersValidatedByBacktest` stays false until a promotion gate says otherwise.
 */

export const V24_VERSION = 'V24_LEADER_CONTINUATION_1';
export const MIN = 60_000, M3 = 180_000, M5 = 300_000, M15 = 900_000, DAY = 86_400_000;

export const V24_POLICY = Object.freeze({
  policyVersion: V24_VERSION,

  // --- LEADER -------------------------------------------------------------
  rankLimit: 10,            // top-N by KST day return
  minDayReturn: 0,          // strictly positive day return required (see leaderGate)
  minQuoteVolume24h: 5_000_000,

  // --- TREND (closed 5m bars) ---------------------------------------------
  minRvol15: 1.5,
  requireRelativeStrength: true,

  // --- SETUP --------------------------------------------------------------
  pullbackMinBars: 2, pullbackMaxBars: 8,
  breakoutLookback1m: 15,
  breakoutHoldMs: 10_000,
  maxChaseAtr3m: 0.25,      // never chase more than this * ATR14_3m above the trigger
  minRvol1: 1.5,

  // --- ORDER FLOW ---------------------------------------------------------
  minBuyShare60s: 0.55,
  minBuyShare180s: 0.50,
  minImbalance25bps: 0.05,
  minTapeTrades60s: 8,      // sample floor: too few prints is UNKNOWN, not "fine"
  minTapeQuote60s: 2_000,

  // --- COST / RISK --------------------------------------------------------
  maxSpreadBps: 10,
  maxDepthShare: 0.05,      // order notional <= 5% of the thinner 25bps side
  edgeToCostRatio: 2.0,
  minEdgeSamples: 30,
  latencyReserveBps: 2,

  // --- STOP ---------------------------------------------------------------
  stopAtrPad: 0.20,         // S0 = setup_low - max(2 tick, 0.20 * ATR14_3m)
  stopMinTicks: 2,
  maxStopDistancePct: 0.035,// wider than this: size down, and if still too wide, skip
  riskFractionOfEquity: 0.005,

  // --- EXIT ---------------------------------------------------------------
  profitLockArmR: 1.0, profitLockFloorR: 0.20,
  profitLockArm2R: 2.0, profitLockCapture2: 0.60,
  trailHigherLowAtr: 0.20,
  trailPeakAtr: 2.0,
  breakBuyShare60s: 0.45,
  breakImbalance25bps: -0.10,
  breakBuyShare180s: 0.50,

  // --- FAILURE / TIME -----------------------------------------------------
  failWindowMs: 5 * MIN,
  failBidDepthDropPct: 0.40,
  timeStopAfterMs: 5 * MIN,
  timeStopMaxR: 0.30,
  reentryCooldownMs: 5 * MIN,

  parametersValidatedByBacktest: false,
});

/* ========================================================================== *
 * 0. primitives
 * ========================================================================== */

const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN));
const fin = v => Number.isFinite(num(v));
export const UNKNOWN = Object.freeze({ known: false });
const known = value => ({ known: true, value });

/** KST day boundary. KST 00:00 is UTC 15:00 of the previous day. */
export function kstDayStart(t) {
  if (!Number.isSafeInteger(t) || t < 0) throw Error('INVALID_TIMESTAMP');
  return Math.floor((t + 9 * 3_600_000) / DAY) * DAY - 9 * 3_600_000;
}

/**
 * A bar is usable only when it is CLOSED strictly before `now`. Binance closeTime is
 * inclusive (t + interval - 1), so the test is closeMs < now, never closeMs <= now.
 */
export function closedBars(bars, now, interval) {
  if (!Array.isArray(bars) || !Number.isSafeInteger(now)) return [];
  const out = [];
  for (const b of bars) {
    const t = num(b.t), close = num(b.closeMs ?? (t + interval - 1));
    if (!Number.isSafeInteger(t) || t % interval !== 0) continue;
    if (close !== t + interval - 1) continue;
    if (close >= now) continue;                     // still open -> invisible
    if (!(num(b.o) > 0 && num(b.h) > 0 && num(b.l) > 0 && num(b.c) > 0)) continue;
    if (num(b.l) > Math.min(num(b.o), num(b.c)) || num(b.h) < Math.max(num(b.o), num(b.c))) continue;
    out.push({ t, o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c),
      qv: num(b.qv ?? 0), tbq: num(b.tbq ?? NaN), closeMs: close });
  }
  out.sort((a, b) => a.t - b.t);
  // contiguity: a gap means the indicator window is not what it claims to be
  for (let i = 1; i < out.length; i++) if (out[i].t - out[i - 1].t !== interval) return out.slice(i);
  return out;
}

/** Aggregate closed 1m bars into closed `k`-minute bars aligned to the epoch. */
export function resample(bars1m, k) {
  if (!Number.isInteger(k) || k < 1) throw Error('INVALID_RESAMPLE');
  const span = k * MIN, buckets = new Map();
  for (const b of bars1m) {
    const t = Math.floor(b.t / span) * span;
    const cur = buckets.get(t);
    if (!cur) buckets.set(t, { t, o: b.o, h: b.h, l: b.l, c: b.c, qv: b.qv, tbq: b.tbq, n: 1, closeMs: t + span - 1 });
    else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
      cur.c = b.c; cur.qv += b.qv; cur.tbq += b.tbq; cur.n += 1;
    }
  }
  // Only fully-populated buckets are closed bars.
  return [...buckets.values()].filter(x => x.n === k).sort((a, b) => a.t - b.t);
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return UNKNOWN;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, x) => a + x, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return Number.isFinite(e) ? known(e) : UNKNOWN;
}

/** Series of EMA values so "is EMA21 rising vs 3 bars ago" can be answered honestly. */
export function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return [];
  const k = 2 / (period + 1), out = [];
  let e = values.slice(0, period).reduce((a, x) => a + x, 0) / period;
  out.push(e);
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

/** Wilder-smoothed ATR in price units. Needs period+1 bars for the first true range. */
export function atrWilder(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return UNKNOWN;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  if (tr.length < period) return UNKNOWN;
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a > 0 ? known(a) : UNKNOWN;
}

/** VWAP over bars = sum(quote) / sum(base). Never uses mark/index/premium volume. */
export function vwap(bars) {
  let q = 0, b = 0;
  for (const x of bars) { if (!(x.qv >= 0)) return UNKNOWN; q += x.qv; b += x.qv / ((x.h + x.l + x.c) / 3 || 1); }
  return b > 0 ? known(q / b) : UNKNOWN;
}

/** Anchored VWAP from a setup start, computed from quote and base volume directly. */
export function anchoredVwap(bars, fromT) {
  let q = 0, base = 0;
  for (const x of bars) {
    if (x.t < fromT) continue;
    const typical = (x.h + x.l + x.c) / 3;
    if (!(typical > 0) || !(x.qv >= 0)) return UNKNOWN;
    q += x.qv; base += x.qv / typical;
  }
  return base > 0 ? known(q / base) : UNKNOWN;
}

/**
 * RVOL15: last CLOSED 15m quote volume over the median comparable 15m bucket of the
 * previous 24h. The current bucket is excluded from the denominator, and a partially
 * elapsed bar is never compared against completed ones.
 */
export function rvol15(closed15) {
  if (closed15.length < 10) return UNKNOWN;
  const cur = closed15.at(-1).qv, hist = closed15.slice(-97, -1).map(x => x.qv).filter(x => x > 0);
  if (hist.length < 8) return UNKNOWN;
  const s = [...hist].sort((a, b) => a - b), m = s.length % 2
    ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return m > 0 ? known(cur / m) : UNKNOWN;
}

/** RVOL1: last closed 1m quote volume over the median of the previous 20 closed 1m bars. */
export function rvol1(closed1) {
  if (closed1.length < 21) return UNKNOWN;
  const cur = closed1.at(-1).qv, hist = closed1.slice(-21, -1).map(x => x.qv).filter(x => x > 0);
  if (hist.length < 10) return UNKNOWN;
  const s = [...hist].sort((a, b) => a - b), m = s.length % 2
    ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return m > 0 ? known(cur / m) : UNKNOWN;
}

/* ========================================================================== *
 * 1. tape (aggTrades) -- aggressive buy/sell split
 * ========================================================================== */

/**
 * Binance aggTrade `m` = "buyer is maker". m===false means the AGGRESSOR was the buyer.
 * Notional is p*q. Aggregate-trade count is not the raw trade count and is never
 * reported as such.
 */
export function tapeWindow(trades, startMs, endMs, policy = V24_POLICY) {
  if (!Array.isArray(trades) || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs)
    return { known: false, reason: 'TAPE_INPUT_INVALID' };
  let buy = 0, sell = 0, n = 0, first = null, last = null;
  const seen = new Set();
  for (const r of trades) {
    const id = r.a ?? r.id, T = num(r.T ?? r.time), p = num(r.p ?? r.price), q = num(r.q ?? r.qty);
    const m = r.m ?? r.isBuyerMaker;
    if (id == null || !Number.isSafeInteger(T) || !(p > 0) || !(q > 0) || typeof m !== 'boolean')
      return { known: false, reason: 'TAPE_ROW_INVALID' };
    if (T < startMs || T >= endMs) continue;       // half-open [start, end)
    if (seen.has(id)) continue; seen.add(id);
    const notional = p * q;
    if (m) sell += notional; else buy += notional;
    n += 1;
    if (first === null || p < first) first = first === null ? p : first;
    last = p;
  }
  const total = buy + sell;
  if (n === 0 || total <= 0) return { known: false, reason: 'TAPE_EMPTY', aggCount: n };
  return {
    known: true, buyQuote: buy, sellQuote: sell, totalQuote: total,
    buyShare: buy / total, delta: buy - sell, aggCount: n,
    sufficient: n >= policy.minTapeTrades60s && total >= policy.minTapeQuote60s,
  };
}

/* ========================================================================== *
 * 2. book -- spread, depth, imbalance, walked fill price
 * ========================================================================== */

/** Walk `qty` through one side of the book. Returns UNKNOWN if depth is insufficient. */
export function walkBook(levels, qty) {
  if (!Array.isArray(levels) || !(qty > 0)) return UNKNOWN;
  let need = qty, cost = 0;
  for (const lv of levels) {
    const p = num(lv[0] ?? lv.price), q = num(lv[1] ?? lv.qty);
    if (!(p > 0) || !(q > 0)) return UNKNOWN;
    const take = Math.min(need, q);
    cost += take * p; need -= take;
    if (need <= 1e-12) return known(cost / qty);
  }
  return UNKNOWN;                                   // not enough depth: NOT fillable
}

/** Depth in USDT within `bps` of mid on one side. */
export function depthWithin(levels, mid, bps, side) {
  if (!Array.isArray(levels) || !(mid > 0) || !(bps > 0)) return UNKNOWN;
  const lim = side === 'bid' ? mid * (1 - bps / 10_000) : mid * (1 + bps / 10_000);
  let usdt = 0;
  for (const lv of levels) {
    const p = num(lv[0] ?? lv.price), q = num(lv[1] ?? lv.qty);
    if (!(p > 0) || !(q > 0)) return UNKNOWN;
    if (side === 'bid' ? p < lim : p > lim) break;
    usdt += p * q;
  }
  return known(usdt);
}

export function bookMetrics(book, qty, policy = V24_POLICY) {
  const bid = num(book?.bestBid), ask = num(book?.bestAsk);
  if (!(bid > 0 && ask >= bid)) return { known: false, reason: 'BOOK_INVALID' };
  if (book?.valid === false || book?.sequenceOk === false)
    return { known: false, reason: 'BOOK_SEQUENCE_INVALID' };
  const mid = (bid + ask) / 2, spreadBps = (ask - bid) / mid * 10_000;
  const bd = depthWithin(book.bids, mid, 25, 'bid'), ad = depthWithin(book.asks, mid, 25, 'ask');
  const buyVwap = walkBook(book.asks, qty), sellVwap = walkBook(book.bids, qty);
  if (!bd.known || !ad.known) return { known: false, reason: 'DEPTH_UNKNOWN', spreadBps, mid };
  const imb = (bd.value + ad.value) > 0 ? (bd.value - ad.value) / (bd.value + ad.value) : null;
  return {
    known: true, mid, spreadBps, bidDepth25: bd.value, askDepth25: ad.value, imbalance25: imb,
    fillable: buyVwap.known && sellVwap.known,
    buyVwap: buyVwap.known ? buyVwap.value : null,
    sellVwap: sellVwap.known ? sellVwap.value : null,
  };
}

/**
 * Round-trip execution cost in bps. The walked buy/sell VWAP spread ALREADY contains
 * spread and depth impact, so spread is not added again on top of it. Funding is a
 * separate signed cashflow and is deliberately not folded in here.
 */
export function executionCostBps(bookM, entryFeeRate, exitFeeRate, policy = V24_POLICY) {
  if (!bookM?.known || !bookM.fillable) return UNKNOWN;
  if (!(fin(entryFeeRate) && fin(exitFeeRate) && entryFeeRate >= 0 && exitFeeRate >= 0)) return UNKNOWN;
  const impact = (bookM.buyVwap - bookM.sellVwap) / bookM.mid * 10_000;
  return known(impact + (entryFeeRate + exitFeeRate) * 10_000 + policy.latencyReserveBps);
}

/* ========================================================================== *
 * 3. UniverseRanker -- LEADER
 * ========================================================================== */

/**
 * Rank by KST day return using ONLY bars closed before `now`. dayOpen is the open of the
 * 15m bar that starts the KST day; a missing day-open is UNKNOWN, never substituted with
 * a UTC open or with the first bar that happens to be available.
 */
export function dayReturn(closed15, now) {
  if (!closed15.length) return UNKNOWN;
  const dayStart = kstDayStart(now - 1);            // at exact midnight rank the closed day
  const open = closed15.find(b => b.t === dayStart)?.o;
  const last = closed15.at(-1)?.c;
  if (!(open > 0) || !(last > 0)) return UNKNOWN;
  return known({ dayStart, dayOpen: open, last, r: last / open - 1 });
}

export function rankLeaders(rows, policy = V24_POLICY) {
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.symbol)) throw Error('DUPLICATE_SYMBOL');
    seen.add(r.symbol);
  }
  if (new Set(rows.map(r => r.asOf)).size > 1) throw Error('MIXED_SNAPSHOT_TIMES');
  return [...rows]
    .sort((a, b) => b.dayReturn - a.dayReturn || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

export function leaderGate(f, policy = V24_POLICY) {
  if (!fin(f?.dayReturn) || !fin(f?.rank)) return { pass: false, reason: 'LEADER_UNKNOWN' };
  if (f.dayReturn <= policy.minDayReturn) return { pass: false, reason: 'DAY_RETURN_NOT_POSITIVE' };
  if (f.rank > policy.rankLimit) return { pass: false, reason: 'OUTSIDE_TOP_N' };
  if (!fin(f?.quoteVolume24h) || f.quoteVolume24h < policy.minQuoteVolume24h)
    return { pass: false, reason: 'LIQUIDITY' };
  return { pass: true, reason: 'LEADER' };
}

/* ========================================================================== *
 * 4. FeatureEngine + TREND
 * ========================================================================== */

/**
 * Build every feature from closed bars only. `btc5` supplies the market reference leg for
 * relative strength; BTC direction shapes relative strength, it is NOT a hard on/off
 * switch for entry.
 */
export function buildFeatures({ bars1m, bars5m, bars15m, btc5m, now, policy = V24_POLICY }) {
  const c1 = closedBars(bars1m, now, MIN);
  const c5 = bars5m ? closedBars(bars5m, now, M5) : resample(c1, 5).filter(b => b.closeMs < now);
  const c3 = resample(c1, 3).filter(b => b.closeMs < now);
  const c15 = closedBars(bars15m, now, M15);
  const b5 = btc5m ? closedBars(btc5m, now, M5) : [];

  const closes5 = c5.map(b => b.c);
  const e9 = emaSeries(closes5, 9), e21 = emaSeries(closes5, 21), e50 = emaSeries(closes5, 50);
  const atr3 = atrWilder(c3, 14), atr5 = atrWilder(c5, 14);
  const e21_3 = emaSeries(c3.map(b => b.c), 21);

  const r15 = c5.length >= 4 ? c5.at(-1).c / c5.at(-4).c - 1 : null;
  const btcR15 = b5.length >= 4 ? b5.at(-1).c / b5.at(-4).c - 1 : null;

  return {
    version: V24_VERSION, asOf: now,
    closed1m: c1, closed3m: c3, closed5m: c5, closed15m: c15,
    last5mClose: c5.length ? c5.at(-1).c : null,
    ema9_5m: e9.length ? e9.at(-1) : null,
    ema21_5m: e21.length ? e21.at(-1) : null,
    ema50_5m: e50.length ? e50.at(-1) : null,
    ema21_5m_prev3: e21.length >= 4 ? e21.at(-4) : null,
    ema21_3m: e21_3.length ? e21_3.at(-1) : null,
    ema21_3m_series: e21_3,
    atr14_3m: atr3.known ? atr3.value : null,
    atr14_5m: atr5.known ? atr5.value : null,
    return15m: r15, btcReturn15m: btcR15,
    rs15: r15 !== null && btcR15 !== null ? r15 - btcR15 : null,
    rvol15: (() => { const v = rvol15(c15); return v.known ? v.value : null; })(),
    rvol1: (() => { const v = rvol1(c1); return v.known ? v.value : null; })(),
    quoteVolume24h: c15.length >= 96 ? c15.slice(-96).reduce((a, x) => a + x.qv, 0) : null,
    dayReturn: (() => { const v = dayReturn(c15, now); return v.known ? v.value.r : null; })(),
    dayStart: (() => { const v = dayReturn(c15, now); return v.known ? v.value.dayStart : null; })(),
  };
}

export function trendGate(f, policy = V24_POLICY) {
  const need = [f?.last5mClose, f?.ema9_5m, f?.ema21_5m, f?.ema21_5m_prev3, f?.rvol15];
  if (need.some(x => !fin(x))) return { pass: false, reason: 'TREND_UNKNOWN' };
  if (!(f.last5mClose > f.ema21_5m)) return { pass: false, reason: 'BELOW_EMA21_5M' };
  if (!(f.ema9_5m > f.ema21_5m)) return { pass: false, reason: 'EMA_STACK' };
  if (!(f.ema21_5m > f.ema21_5m_prev3)) return { pass: false, reason: 'EMA21_NOT_RISING' };
  if (policy.requireRelativeStrength) {
    if (!fin(f?.rs15)) return { pass: false, reason: 'RS_UNKNOWN' };
    if (!(f.rs15 > 0)) return { pass: false, reason: 'RELATIVE_STRENGTH' };
  }
  if (!(f.rvol15 >= policy.minRvol15)) return { pass: false, reason: 'VOLUME_ACCELERATION' };
  return { pass: true, reason: 'TREND' };
}

/* ========================================================================== *
 * 5. SETUP A (pullback / consolidation then re-acceleration) and B (breakout hold)
 * ========================================================================== */

/**
 * SETUP_A: an up-leg, then 2..8 closed 1m bars of pullback OR sideways drift on lighter
 * volume, then a closed 1m bar that takes out the highest high of the previous 3 closed
 * bars with RVOL1 confirmation. A deep retracement is explicitly NOT required -- a flat
 * consolidation that breaks upward qualifies on the same path.
 */
export function setupA(f, policy = V24_POLICY) {
  const c1 = f.closed1m;
  if (c1.length < 25) return { pass: false, reason: 'SETUP_A_INSUFFICIENT_HISTORY' };
  const trigger = c1.at(-1);
  const prior3 = c1.slice(-4, -1);
  if (prior3.length !== 3) return { pass: false, reason: 'SETUP_A_INSUFFICIENT_HISTORY' };
  const breakLevel = Math.max(...prior3.map(b => b.h));
  if (!(trigger.c > breakLevel)) return { pass: false, reason: 'NO_1M_BREAK' };
  if (!fin(f.rvol1) || !(f.rvol1 >= policy.minRvol1)) return { pass: false, reason: 'RVOL1' };

  // Locate the consolidation by anchoring on the SWING HIGH rather than by walking back
  // while "high <= breakLevel". The latter silently absorbs the leg bar that set the
  // level (its high EQUALS breakLevel), which both overstates the pullback and inflates
  // its volume. The consolidation is, by definition, the bars that come after the high.
  const windowLen = policy.pullbackMaxBars + 2;
  const win = c1.slice(-(windowLen + 1), -1);           // candidates before the trigger
  if (win.length < policy.pullbackMinBars + 1) return { pass: false, reason: 'SETUP_A_INSUFFICIENT_HISTORY' };
  let swingIdx = 0;
  for (let i = 1; i < win.length; i++) if (win[i].h > win[swingIdx].h) swingIdx = i;

  const consolidation = win.slice(swingIdx + 1);
  const nBars = consolidation.length;
  if (nBars < policy.pullbackMinBars) return { pass: false, reason: 'NO_CONSOLIDATION' };
  if (nBars > policy.pullbackMaxBars) return { pass: false, reason: 'CONSOLIDATION_TOO_LONG' };
  const lo = Math.min(...consolidation.map(b => b.l));
  const hi = Math.max(...consolidation.map(b => b.h));
  const pullQv = consolidation.reduce((a, x) => a + x.qv, 0);

  // The advance into that high, measured over the same number of bars so the volume
  // comparison is like-for-like rather than a longer window beating a shorter one.
  const legEnd = c1.length - 1 - nBars;                 // index of the swing-high bar
  const leg = c1.slice(Math.max(0, legEnd - nBars + 1), legEnd + 1);
  if (leg.length < policy.pullbackMinBars) return { pass: false, reason: 'NO_PRIOR_LEG' };
  const legQv = leg.reduce((a, x) => a + x.qv, 0);
  if (!(leg.at(-1).c > leg[0].o)) return { pass: false, reason: 'PRIOR_LEG_NOT_UP' };
  if (!(pullQv < legQv)) return { pass: false, reason: 'PULLBACK_VOLUME_NOT_LIGHTER' };

  // Reclaim of the setup's own anchored VWAP.
  const setupStart = leg[0].t;
  const av = anchoredVwap(c1, setupStart);
  if (!av.known) return { pass: false, reason: 'AVWAP_UNKNOWN' };
  if (!(trigger.c >= av.value)) return { pass: false, reason: 'BELOW_ANCHORED_VWAP' };

  return {
    pass: true, reason: 'SETUP_A', setupType: 'A',
    triggerLevel: breakLevel, setupLow: lo, setupHigh: hi,
    setupStartT: setupStart, consolidationBars: nBars,
    anchoredVwap: av.value, triggerBarT: trigger.t, triggerClose: trigger.c,
  };
}

/**
 * SETUP_B: continuation through the high of the last 15 closed 1m bars, where price is
 * still above the breakout level `breakoutHoldMs` later and the tape confirms. This is
 * the path that takes a leader which never pulls back.
 */
export function setupB(f, hold, policy = V24_POLICY) {
  const c1 = f.closed1m;
  if (c1.length < policy.breakoutLookback1m + 6) return { pass: false, reason: 'SETUP_B_INSUFFICIENT_HISTORY' };
  const trigger = c1.at(-1);
  const prior = c1.slice(-(policy.breakoutLookback1m + 1), -1);
  if (prior.length !== policy.breakoutLookback1m) return { pass: false, reason: 'SETUP_B_INSUFFICIENT_HISTORY' };
  const breakLevel = Math.max(...prior.map(b => b.h));
  if (!(trigger.c > breakLevel)) return { pass: false, reason: 'NO_15M_HIGH_BREAK' };

  // Hold proof: an explicit observation that price stayed above the level for the
  // required dwell. Absent proof this is UNKNOWN -- never assumed to have held.
  if (!hold || hold.heldMs === undefined) return { pass: false, reason: 'HOLD_PROOF_MISSING' };
  if (!(hold.heldMs >= policy.breakoutHoldMs)) return { pass: false, reason: 'HOLD_TOO_SHORT' };
  if (!(hold.minPrice > breakLevel)) return { pass: false, reason: 'LOST_BREAK_LEVEL' };

  // Volume and aggressive-buy participation must both be expanding.
  if (!fin(f.rvol1) || !(f.rvol1 >= policy.minRvol1)) return { pass: false, reason: 'RVOL1' };
  const tb = trigger.tbq, prevTb = c1.at(-2)?.tbq;
  if (!fin(tb) || !fin(prevTb) || !(trigger.qv > 0) || !(c1.at(-2).qv > 0))
    return { pass: false, reason: 'TAKER_SPLIT_UNKNOWN' };
  if (!(tb / trigger.qv > prevTb / c1.at(-2).qv)) return { pass: false, reason: 'BUY_SHARE_NOT_EXPANDING' };

  // Structural support for the stop: the base the breakout came out of.
  const lo = Math.min(...prior.slice(-6).map(b => b.l));
  return {
    pass: true, reason: 'SETUP_B', setupType: 'B',
    triggerLevel: breakLevel, setupLow: lo, setupHigh: Math.max(...prior.map(b => b.h)),
    setupStartT: prior[0].t, consolidationBars: 0,
    anchoredVwap: null, triggerBarT: trigger.t, triggerClose: trigger.c,
  };
}

/** Do not keep chasing a breakout that has already run far past its trigger. */
export function chaseGate(setup, price, atr3m, policy = V24_POLICY) {
  if (!fin(price) || !fin(atr3m) || !(atr3m > 0) || !fin(setup?.triggerLevel))
    return { pass: false, reason: 'CHASE_UNKNOWN' };
  const dist = price - setup.triggerLevel;
  if (dist > policy.maxChaseAtr3m * atr3m) return { pass: false, reason: 'CHASE_TOO_FAR' };
  return { pass: true, reason: 'CHASE_OK', distanceAtr: dist / atr3m };
}

/* ========================================================================== *
 * 6. ORDER FLOW CONFIRMATION
 * ========================================================================== */

/**
 * Requires positive evidence that buying is winning on BOTH the 60s and the 180s scale,
 * plus price actually holding the trigger. A strong 10s burst cannot overwrite a 3-minute
 * selling imbalance, and a thin tape is UNKNOWN rather than "not weak".
 */
export function orderFlowGate({ t60, t180, imbalance30sAvg, price, triggerLevel }, policy = V24_POLICY) {
  const codes = [];
  if (!t60?.known || !t180?.known) return { pass: false, reason: 'FLOW_UNKNOWN', codes: ['TAPE_UNAVAILABLE'] };
  if (!t60.sufficient) return { pass: false, reason: 'FLOW_SAMPLE_INSUFFICIENT', codes: ['TAPE_THIN_60S'] };
  if (!(t60.buyShare >= policy.minBuyShare60s)) codes.push('BUY_SHARE_60S');
  if (!(t180.buyShare >= policy.minBuyShare180s)) codes.push('BUY_SHARE_180S');
  if (!(t60.delta > 0)) codes.push('DELTA_60S');
  if (!fin(imbalance30sAvg)) return { pass: false, reason: 'IMBALANCE_UNKNOWN', codes: ['IMBALANCE_UNAVAILABLE'] };
  if (!(imbalance30sAvg >= policy.minImbalance25bps)) codes.push('BOOK_IMBALANCE');
  if (!fin(price) || !fin(triggerLevel) || !(price > triggerLevel)) codes.push('PRICE_LOST_TRIGGER');
  return codes.length
    ? { pass: false, reason: 'FLOW_NOT_CONFIRMED', codes }
    : { pass: true, reason: 'FLOW_CONFIRMED', codes: [] };
}

/**
 * Absorption: heavy aggressive buying that does not move price is evidence AGAINST
 * continuation. Recorded as a flag, not silently ignored.
 */
export function absorptionFlag(t60, priceChange60s) {
  if (!t60?.known || !fin(priceChange60s)) return null;
  return t60.buyShare >= 0.60 && priceChange60s <= 0 ? 'BUY_ABSORBED' : null;
}

/* ========================================================================== *
 * 7. RiskSizer -- structural stop first, size second
 * ========================================================================== */

/** S0 = setup_low - max(2 ticks, 0.20 * ATR14_3m). Fixed BEFORE the order is sent. */
export function structuralStop(setupLow, atr3m, tick, policy = V24_POLICY) {
  if (!(setupLow > 0) || !(atr3m > 0) || !(tick > 0)) return UNKNOWN;
  const pad = Math.max(policy.stopMinTicks * tick, policy.stopAtrPad * atr3m);
  const raw = setupLow - pad;
  if (!(raw > 0)) return UNKNOWN;
  return known(Math.floor(raw / tick + 1e-9) * tick);  // a LONG stop rounds DOWN
}

/**
 * Size from risk, then clamp by every other binding constraint. The stop is NEVER moved
 * up to fit the risk budget -- if the structural stop is too far, the size shrinks, and
 * if it is still not viable the signal is skipped.
 */
export function sizePosition({
  entryPrice, stopPrice, riskBudgetUsdt, maxNotionalUsdt, leverage,
  availableMarginUsdt, bidDepth25, askDepth25, qtyStep, minNotionalUsdt,
  entryFeeRate, exitFeeRate, slipReserveBps = V24_POLICY.latencyReserveBps,
}, policy = V24_POLICY) {
  const bad = r => ({ ok: false, reason: r, quantity: 0 });
  if (![entryPrice, stopPrice, riskBudgetUsdt, maxNotionalUsdt, leverage, qtyStep].every(fin))
    return bad('SIZE_INPUT_INVALID');
  if (!(entryPrice > 0 && stopPrice > 0 && stopPrice < entryPrice && qtyStep > 0 && leverage > 0))
    return bad('SIZE_INPUT_INVALID');

  const stopDistPct = 1 - stopPrice / entryPrice;
  if (stopDistPct > policy.maxStopDistancePct) return bad('STOP_TOO_WIDE');

  // Per-unit loss must include what it actually costs to get out at the stop.
  const perUnitLoss = (entryPrice - stopPrice)
    + entryPrice * entryFeeRate + stopPrice * exitFeeRate
    + entryPrice * (slipReserveBps / 10_000);
  if (!(perUnitLoss > 0)) return bad('SIZE_INPUT_INVALID');

  const qRisk = riskBudgetUsdt / perUnitLoss;
  const qNotional = maxNotionalUsdt / entryPrice;
  const qMargin = (availableMarginUsdt * leverage) / entryPrice;
  const thinner = Math.min(fin(bidDepth25) ? bidDepth25 : Infinity, fin(askDepth25) ? askDepth25 : Infinity);
  const qLiquidity = Number.isFinite(thinner) ? (thinner * policy.maxDepthShare) / entryPrice : Infinity;

  const raw = Math.min(qRisk, qNotional, qMargin, qLiquidity);
  const q = Math.floor(raw / qtyStep + 1e-9) * qtyStep;
  if (!(q > 0)) return bad('QTY_BELOW_STEP');
  if (fin(minNotionalUsdt) && q * entryPrice < minNotionalUsdt) return bad('BELOW_MIN_NOTIONAL');

  const binding = raw === qRisk ? 'RISK' : raw === qLiquidity ? 'LIQUIDITY'
    : raw === qMargin ? 'MARGIN' : 'NOTIONAL';
  return {
    ok: true, reason: 'SIZED', quantity: q, binding,
    notionalUsdt: q * entryPrice, marginUsdt: q * entryPrice / leverage,
    riskUsdt: q * perUnitLoss, stopDistPct,
    R0: q * (entryPrice - stopPrice),
  };
}

/* ========================================================================== *
 * 8. COST EDGE GATE
 * ========================================================================== */

/**
 * Expected value must clear cost by `edgeToCostRatio` AND rest on a real sample. There is
 * no default win probability: without `samples >= minEdgeSamples` this returns UNKNOWN and
 * the entry is not approved.
 */
export function costEdgeGate({ expectedEdgeBps, samples, costBps, spreadBps, notionalUsdt,
  bidDepth25, askDepth25 }, policy = V24_POLICY) {
  if (!fin(costBps)) return { pass: false, reason: 'COST_UNKNOWN' };
  if (!fin(spreadBps) || spreadBps > policy.maxSpreadBps) return { pass: false, reason: 'SPREAD' };
  const thinner = Math.min(fin(bidDepth25) ? bidDepth25 : -1, fin(askDepth25) ? askDepth25 : -1);
  if (!(thinner > 0)) return { pass: false, reason: 'DEPTH_UNKNOWN' };
  if (!(notionalUsdt <= thinner * policy.maxDepthShare)) return { pass: false, reason: 'ORDER_TOO_LARGE_FOR_BOOK' };
  if (!fin(samples) || samples < policy.minEdgeSamples) return { pass: false, reason: 'EDGE_SAMPLE_INSUFFICIENT' };
  if (!fin(expectedEdgeBps)) return { pass: false, reason: 'EDGE_UNKNOWN' };
  if (!(expectedEdgeBps >= policy.edgeToCostRatio * costBps))
    return { pass: false, reason: 'EDGE_BELOW_COST_MULTIPLE' };
  return { pass: true, reason: 'COST_EDGE_OK', netEdgeBps: expectedEdgeBps - costBps };
}

/* ========================================================================== *
 * 9. EntryPolicy -- the state machine
 * ========================================================================== */

export const ENTRY_STATES = Object.freeze(
  ['UNIVERSE', 'LEADER', 'SETUP_FORMING', 'TRIGGER_CONFIRMED', 'EXECUTION_CHECKED', 'ENTRY_INTENT']);

/**
 * ENTRY = LEADER and TREND and (SETUP_A or SETUP_B) and ORDER_FLOW_CONFIRMED
 *         and DATA_VALID and COST_EDGE_VALID and RISK_VALID
 * Returns ENTER or SKIP with the stage it stopped at and every reason code.
 */
export function evaluateEntry(ctx, policy = V24_POLICY) {
  const { features: f, leader, book, t60, t180, imbalance30sAvg, holdProof,
    edge, sizing, now, symbol, dataQuality } = ctx;
  const trail = [];
  const out = (state, decision, reason, extra = {}) => ({
    decision, state, reason, symbol, policyVersion: V24_VERSION, signalTime: now,
    setupId: extra.setupId ?? null, setupType: extra.setupType ?? null,
    reasonCodes: [...trail, reason], proposedQuantity: extra.quantity ?? 0,
    initialStop: extra.initialStop ?? null, estimatedCostBps: extra.costBps ?? null,
    triggerLevel: extra.triggerLevel ?? null, R0: extra.R0 ?? null,
    dataQuality: dataQuality ?? 'UNKNOWN',
    parametersValidatedByBacktest: false, ...extra,
  });

  if (dataQuality && dataQuality !== 'OK') return out('UNIVERSE', 'SKIP', `DATA_${dataQuality}`);

  const L = leaderGate(leader, policy); trail.push(L.reason);
  if (!L.pass) return out('UNIVERSE', 'SKIP', L.reason);

  const T = trendGate(f, policy); trail.push(T.reason);
  if (!T.pass) return out('LEADER', 'SKIP', T.reason);

  const a = setupA(f, policy);
  const b = a.pass ? { pass: false, reason: 'SETUP_A_TAKEN' } : setupB(f, holdProof, policy);
  const setup = a.pass ? a : (b.pass ? b : null);
  if (!setup) { trail.push(a.reason, b.reason); return out('SETUP_FORMING', 'SKIP', a.reason); }
  trail.push(setup.reason);

  const price = ctx.price ?? f.closed1m.at(-1)?.c;
  const C = chaseGate(setup, price, f.atr14_3m, policy); trail.push(C.reason);
  if (!C.pass) return out('SETUP_FORMING', 'SKIP', C.reason, { setupType: setup.setupType });

  const F = orderFlowGate({ t60, t180, imbalance30sAvg, price, triggerLevel: setup.triggerLevel }, policy);
  trail.push(F.reason);
  if (!F.pass) return out('TRIGGER_CONFIRMED', 'SKIP', F.reason,
    { setupType: setup.setupType, flowCodes: F.codes });

  const bm = book?.known ? book : bookMetrics(book, sizing?.probeQuantity ?? 0, policy);
  if (!bm?.known) return out('TRIGGER_CONFIRMED', 'SKIP', 'BOOK_UNKNOWN', { setupType: setup.setupType });
  const cost = executionCostBps(bm, ctx.entryFeeRate, ctx.exitFeeRate, policy);
  if (!cost.known) return out('EXECUTION_CHECKED', 'SKIP', 'COST_UNKNOWN', { setupType: setup.setupType });

  const stop = structuralStop(setup.setupLow, f.atr14_3m, ctx.priceTick, policy);
  if (!stop.known) return out('EXECUTION_CHECKED', 'SKIP', 'STOP_UNKNOWN', { setupType: setup.setupType });
  if (!(stop.value < price)) return out('EXECUTION_CHECKED', 'SKIP', 'STOP_ABOVE_PRICE', { setupType: setup.setupType });

  const E = costEdgeGate({ expectedEdgeBps: edge?.expectedEdgeBps, samples: edge?.samples,
    costBps: cost.value, spreadBps: bm.spreadBps, notionalUsdt: sizing?.maxNotionalUsdt,
    bidDepth25: bm.bidDepth25, askDepth25: bm.askDepth25 }, policy);
  trail.push(E.reason);
  if (!E.pass) return out('EXECUTION_CHECKED', 'SKIP', E.reason,
    { setupType: setup.setupType, costBps: cost.value, initialStop: stop.value });

  const S = sizePosition({ ...sizing, entryPrice: price, stopPrice: stop.value,
    bidDepth25: bm.bidDepth25, askDepth25: bm.askDepth25,
    entryFeeRate: ctx.entryFeeRate, exitFeeRate: ctx.exitFeeRate }, policy);
  trail.push(S.reason);
  if (!S.ok) return out('EXECUTION_CHECKED', 'SKIP', S.reason,
    { setupType: setup.setupType, costBps: cost.value, initialStop: stop.value });

  return out('ENTRY_INTENT', 'ENTER', 'V24_ENTRY_CONFIRMED', {
    setupId: `${symbol}:${setup.setupType}:${setup.triggerBarT}`,
    setupType: setup.setupType, triggerLevel: setup.triggerLevel,
    setupLow: setup.setupLow, initialStop: stop.value, quantity: S.quantity,
    R0: S.R0, costBps: cost.value, netEdgeBps: E.netEdgeBps,
    binding: S.binding, notionalUsdt: S.notionalUsdt, marginUsdt: S.marginUsdt,
    absorption: absorptionFlag(t60, ctx.priceChange60s),
  });
}

/* ========================================================================== *
 * 10. ExitPolicy -- realisable net profit, not chart profit
 * ========================================================================== */

/**
 * G(t): net USDT that could actually be realised RIGHT NOW, at prices the book can fill.
 *
 *   G = realised gross on already-closed parts
 *     + remaining * (executable sell VWAP - entry)
 *     + signed funding cashflow
 *     - fees already paid
 *     - estimated fee to close the remainder
 *     - latency reserve not yet expressed in price
 *
 * Slippage already embedded in an actual fill price is NOT subtracted again.
 */
export function netRealisable({ entryPrice, remainingQty, sellVwap, realisedGross,
  feesPaid, fundingCashflow = 0, exitFeeRate, latencyReserveBps = V24_POLICY.latencyReserveBps }) {
  const need = [entryPrice, remainingQty, realisedGross, feesPaid, exitFeeRate];
  if (need.some(x => !fin(x)) || entryPrice <= 0 || remainingQty < 0) return UNKNOWN;
  if (remainingQty > 0 && !(sellVwap > 0)) return UNKNOWN;     // cannot price the exit -> UNKNOWN
  const openLeg = remainingQty > 0 ? remainingQty * (sellVwap - entryPrice) : 0;
  const exitFee = remainingQty > 0 ? remainingQty * sellVwap * exitFeeRate : 0;
  const reserve = remainingQty > 0 ? remainingQty * entryPrice * (latencyReserveBps / 10_000) : 0;
  return known(realisedGross + openLeg + fundingCashflow - feesPaid - exitFee - reserve);
}

/**
 * Profit lock on NET R, ratcheting only upward:
 *   M <  1.0 R0 -> no lock (do not scratch a trade that has merely twitched up)
 *   M >= 1.0 R0 -> floor at least 0.20 R0
 *   M >= 2.0 R0 -> floor at least 0.60 M
 * `F` is a USDT floor on G, not a promise about the fill: a gap can still print through it.
 */
export function profitLockFloor(M, R0, priorFloor = 0, policy = V24_POLICY) {
  if (!fin(M) || !fin(R0) || R0 <= 0) return UNKNOWN;
  let F = fin(priorFloor) ? priorFloor : 0;
  if (M >= policy.profitLockArmR * R0) F = Math.max(F, policy.profitLockFloorR * R0);
  if (M >= policy.profitLockArm2R * R0) F = Math.max(F, policy.profitLockCapture2 * M);
  return known(F);
}

/**
 * Structural trail for the runner. No fixed upside target. The protective level is the
 * HIGHER of the two candidates and can never be lowered for a LONG.
 * `higherLow` must be a low confirmed by bars closed at or before `now` -- a low that is
 * only identifiable using later bars is look-ahead and is rejected by the caller.
 */
export function trailLevel({ confirmedHigherLow, peakPrice, atr3m, priorStop, tick }, policy = V24_POLICY) {
  if (!fin(atr3m) || atr3m <= 0 || !fin(peakPrice)) return UNKNOWN;
  const cands = [];
  if (fin(confirmedHigherLow)) cands.push(confirmedHigherLow - policy.trailHigherLowAtr * atr3m);
  cands.push(peakPrice - policy.trailPeakAtr * atr3m);
  let lvl = Math.max(...cands);
  if (fin(priorStop)) lvl = Math.max(lvl, priorStop);        // never widen
  if (fin(tick) && tick > 0) lvl = Math.ceil(lvl / tick - 1e-10) * tick;  // SELL trigger rounds UP
  return known(lvl);
}

/** Momentum has broken: price structure AND flow both say the reason to be long is gone. */
export function momentumBreak({ last1mClose, supportLow, t60, imbalance30sAvg,
  closed3m, ema21_3mSeries, t180 }, policy = V24_POLICY) {
  const codes = [];
  if (fin(last1mClose) && fin(supportLow) && last1mClose < supportLow &&
      t60?.known && t60.buyShare < policy.breakBuyShare60s &&
      fin(imbalance30sAvg) && imbalance30sAvg < policy.breakImbalance25bps)
    codes.push('V24_STRUCTURE_AND_FLOW_BREAK');

  if (Array.isArray(closed3m) && Array.isArray(ema21_3mSeries) &&
      closed3m.length >= 2 && ema21_3mSeries.length >= 2 &&
      closed3m.at(-1).c < ema21_3mSeries.at(-1) && closed3m.at(-2).c < ema21_3mSeries.at(-2) &&
      t180?.known && t180.buyShare < policy.breakBuyShare180s)
    codes.push('V24_TWO_3M_BELOW_EMA21');

  return codes.length ? { broken: true, codes } : { broken: false, codes: [] };
}

/**
 * First `failWindowMs` after entry: a failed entry is ended without waiting for the
 * structural stop. A single print or a one-tick book flicker is not enough -- price must
 * have LOST the level and flow must confirm. Note bid-depth comparison must be made on a
 * like-for-like band, otherwise a price move alone looks like vanishing liquidity.
 */
export function earlyFailure({ heldMs, price, triggerLevel, setupLow, t60, t180,
  imbalance30sAvg, bidDepth25, bidDepth25Baseline }, policy = V24_POLICY) {
  if (!fin(heldMs) || heldMs > policy.failWindowMs) return { fail: false, codes: [] };
  const lost = fin(price) && (fin(triggerLevel) || fin(setupLow)) &&
    price < Math.max(fin(triggerLevel) ? triggerLevel : -Infinity, fin(setupLow) ? setupLow : -Infinity);
  if (!lost) return { fail: false, codes: [] };
  if (!t60?.known || !(t60.buyShare < policy.breakBuyShare60s)) return { fail: false, codes: [] };

  const corroboration = [];
  if (t180?.known && t180.buyShare < 0.50) corroboration.push('FLOW_3M_SELLING');
  if (fin(bidDepth25) && fin(bidDepth25Baseline) && bidDepth25Baseline > 0 &&
      bidDepth25 <= bidDepth25Baseline * (1 - policy.failBidDepthDropPct))
    corroboration.push('BID_DEPTH_COLLAPSE');
  if (fin(imbalance30sAvg) && imbalance30sAvg < policy.breakImbalance25bps)
    corroboration.push('BOOK_IMBALANCE_NEGATIVE');

  return corroboration.length
    ? { fail: true, codes: ['V24_ENTRY_FAILED_EARLY', ...corroboration] }
    : { fail: false, codes: [] };
}

/** Re-acceleration never came: small excursion, level not held, 3m flow not buying. */
export function timeStop({ heldMs, M, R0, priceHoldsTrigger, t180 }, policy = V24_POLICY) {
  if (!fin(heldMs) || heldMs < policy.timeStopAfterMs) return { exit: false, codes: [] };
  if (!fin(M) || !fin(R0) || R0 <= 0) return { exit: false, codes: [] };
  if (!(M < policy.timeStopMaxR * R0)) return { exit: false, codes: [] };
  if (priceHoldsTrigger) return { exit: false, codes: [] };
  if (!t180?.known || !(t180.buyShare <= policy.minBuyShare180s)) return { exit: false, codes: [] };
  return { exit: true, codes: ['V24_TIME_STOP_NO_REACCELERATION'] };
}

/**
 * One exit decision. Ordering is deliberate: hard protection first (it must never wait on
 * a confirmation), then profit lock, then structure, then the slower discretionary
 * overlays. Output is HOLD | UPDATE_PROTECTION | REDUCE | EXIT.
 */
export function evaluateExit(ctx, policy = V24_POLICY) {
  const { position, now, book, t60, t180, imbalance30sAvg, features, funding = 0 } = ctx;
  const E = num(position.entryPrice), q = num(position.remainingQty), R0 = num(position.R0);
  const heldMs = now - num(position.entryAt);
  const mk = (action, reason, extra = {}) => ({
    action, reason, policyVersion: V24_VERSION, at: now,
    remainingQty: q, protectionStage: extra.stage ?? null,
    stopPrice: extra.stopPrice ?? position.stopPrice ?? null,
    G: extra.G ?? null, M: extra.M ?? null, floor: extra.floor ?? null,
    priceBasis: extra.priceBasis ?? null,
    parametersValidatedByBacktest: false, ...extra,
  });

  if (!(E > 0) || !(q > 0) || !(R0 > 0) || !Number.isFinite(heldMs) || heldMs < 0)
    return mk('HOLD', 'V24_EXIT_STATE_INVALID');

  const bm = book?.known ? book : bookMetrics(book, q, policy);
  const sell = bm?.known && bm.fillable ? bm.sellVwap : null;
  const bid = bm?.known ? bm.mid && num(book?.bestBid) : null;

  // 1. Hard structural stop -- exchange-resident and never waits for confirmation.
  const hardStop = num(position.stopPrice);
  if (fin(hardStop) && fin(bid) && bid <= hardStop)
    return mk('EXIT', 'V24_STRUCTURAL_STOP', { stage: 'HARD_STOP', stopPrice: hardStop, priceBasis: bid });

  // 2. Net-profit accounting.
  const g = netRealisable({ entryPrice: E, remainingQty: q, sellVwap: sell,
    realisedGross: num(position.realisedGross ?? 0), feesPaid: num(position.feesPaid ?? 0),
    fundingCashflow: funding, exitFeeRate: ctx.exitFeeRate });
  const M = g.known ? Math.max(num(position.M ?? 0), g.value) : num(position.M ?? 0);
  const floor = profitLockFloor(M, R0, num(position.profitFloor ?? 0), policy);

  // 3. Profit lock: give back only what the ratchet allows.
  if (g.known && floor.known && floor.value > 0 && g.value <= floor.value)
    return mk('EXIT', 'V24_PROFIT_LOCK', { stage: 'PROFIT_LOCK', G: g.value, M, floor: floor.value });

  // 4. Early failure and time stop.
  const ef = earlyFailure({ heldMs, price: bid, triggerLevel: position.triggerLevel,
    setupLow: position.setupLow, t60, t180, imbalance30sAvg,
    bidDepth25: bm?.known ? bm.bidDepth25 : null,
    bidDepth25Baseline: position.bidDepth25Baseline }, policy);
  if (ef.fail) return mk('EXIT', ef.codes[0], { stage: 'EARLY_FAILURE', codes: ef.codes, G: g.known ? g.value : null, M });

  const ts = timeStop({ heldMs, M, R0,
    priceHoldsTrigger: fin(bid) && fin(position.triggerLevel) && bid > position.triggerLevel, t180 }, policy);
  if (ts.exit) return mk('EXIT', ts.codes[0], { stage: 'TIME_STOP', codes: ts.codes, G: g.known ? g.value : null, M });

  // 5. Momentum break on the trade's own timescale.
  const mb = momentumBreak({ last1mClose: features?.closed1m?.at(-1)?.c,
    supportLow: position.confirmedHigherLow ?? position.setupLow, t60, imbalance30sAvg,
    closed3m: features?.closed3m, ema21_3mSeries: features?.ema21_3m_series, t180 }, policy);
  if (mb.broken) return mk('EXIT', mb.codes[0], { stage: 'MOMENTUM_BREAK', codes: mb.codes, G: g.known ? g.value : null, M });

  // 6. Otherwise ratchet protection upward and keep holding the trend.
  const trail = trailLevel({ confirmedHigherLow: position.confirmedHigherLow,
    peakPrice: num(position.peakPrice ?? E), atr3m: features?.atr14_3m,
    priorStop: hardStop, tick: ctx.priceTick }, policy);
  if (trail.known && fin(hardStop) && trail.value > hardStop)
    return mk('UPDATE_PROTECTION', 'V24_TRAIL_RAISED',
      { stage: 'TRAIL', stopPrice: trail.value, G: g.known ? g.value : null, M, floor: floor.known ? floor.value : null });

  return mk('HOLD', 'V24_HOLD', { stage: 'HOLD', G: g.known ? g.value : null, M,
    floor: floor.known ? floor.value : null, stopPrice: hardStop });
}

/** Re-entry discipline: a new setup and recovered flow, never the same signal again. */
export function reentryAllowed({ lastExitAt, now, lastSetupId, candidateSetupId, t60 }, policy = V24_POLICY) {
  if (!fin(lastExitAt)) return { allowed: true, reason: 'NO_PRIOR_EXIT' };
  if (now - lastExitAt < policy.reentryCooldownMs) return { allowed: false, reason: 'COOLDOWN' };
  if (lastSetupId && candidateSetupId === lastSetupId) return { allowed: false, reason: 'SAME_SETUP' };
  if (!t60?.known || !(t60.buyShare >= policy.minBuyShare60s)) return { allowed: false, reason: 'FLOW_NOT_RECOVERED' };
  return { allowed: true, reason: 'REENTRY_OK' };
}
