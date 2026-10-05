export const VERSION = 'SHADOW_TRADER_V1_1.0.0';
export const TREND = 'SHADOW_TREND_LONG_V1';
export const SQUEEZE = 'SHADOW_SHORT_SQUEEZE_LONG_V1';
export const STRATEGIES = Object.freeze([TREND, SQUEEZE]);
export const INTERVAL_MS = Object.freeze({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 });

const finite = Number.isFinite;
const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
export const number = (value) => {
  const parsed = Number(value);
  return finite(parsed) ? parsed : null;
};

export function median(values) {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : (xs[middle - 1] + xs[middle]) / 2;
}

export function fundingDistribution(rows, eligibleSymbols, config = {}) {
  const bottom = number(config.funding_bottom_percentile) ?? 0.025;
  const zMax = number(config.funding_robust_z_max) ?? -3;
  const samples = rows
    .filter((row) => eligibleSymbols.has(String(row?.symbol || '')))
    .map((row) => ({ symbol: String(row.symbol), funding: number(row.lastFundingRate) }))
    .filter((row) => row.funding !== null);
  const values = samples.map((row) => row.funding);
  const center = median(values);
  const mad = center === null ? null : median(values.map((value) => Math.abs(value - center)));
  const sorted = [...values].sort((a, b) => a - b);
  const enriched = samples.map((row) => {
    const percentile = sorted.length <= 1 ? 0 : sorted.filter((value) => value <= row.funding).length / sorted.length;
    const robustZ = mad && mad > 0 && center !== null ? 0.6745 * (row.funding - center) / mad : null;
    const outlier = row.funding < 0 && (percentile <= bottom || robustZ !== null && robustZ <= zMax);
    return { ...row, percentile, median: center, mad, robust_z: robustZ, outlier };
  }).sort((a, b) => a.funding - b.funding || a.symbol.localeCompare(b.symbol));
  return { median: center, mad, count: samples.length, rows: enriched };
}

export function parseKlines(raw, interval, decisionAt) {
  const width = typeof interval === 'number' ? interval : INTERVAL_MS[interval];
  if (!width || !Array.isArray(raw)) throw new Error('KLINE_INPUT_INVALID');
  const rows = raw.map((row) => ({
    open_at: number(row?.[0]), open: number(row?.[1]), high: number(row?.[2]), low: number(row?.[3]),
    close: number(row?.[4]), volume: number(row?.[5]), close_at: number(row?.[6]), quote_volume: number(row?.[7]),
    trades: number(row?.[8]), taker_buy_base: number(row?.[9]), taker_buy_quote: number(row?.[10]),
  })).filter((row) => row.close_at !== null && row.close_at < decisionAt).sort((a, b) => a.open_at - b.open_at);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!Number.isSafeInteger(row.open_at) || row.open_at % width !== 0 || row.close_at !== row.open_at + width - 1 ||
      ![row.open, row.high, row.low, row.close, row.volume, row.quote_volume, row.taker_buy_quote].every(finite) ||
      Math.min(row.open, row.high, row.low, row.close) <= 0 || row.high < Math.max(row.open, row.close) ||
      row.low > Math.min(row.open, row.close) || row.volume < 0 || row.quote_volume < 0 || row.taker_buy_quote < 0 ||
      row.taker_buy_quote > row.quote_volume * (1 + 1e-8) || index > 0 && row.open_at - rows[index - 1].open_at !== width) {
      throw new Error('KLINE_NONCAUSAL_OR_INVALID');
    }
  }
  return rows;
}

function sma(rows, period, key = 'close') {
  return rows.length >= period ? mean(rows.slice(-period).map((row) => row[key])) : null;
}

function emaSeries(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  let value = mean(values.slice(0, period));
  output[period - 1] = value;
  for (let index = period; index < values.length; index++) {
    value += (values[index] - value) * 2 / (period + 1);
    output[index] = value;
  }
  return output;
}

function atr(rows, period = 14) {
  if (rows.length <= period) return null;
  const ranges = rows.slice(1).map((row, index) => Math.max(
    row.high - row.low,
    Math.abs(row.high - rows[index].close),
    Math.abs(row.low - rows[index].close),
  ));
  let value = mean(ranges.slice(0, period));
  for (const current of ranges.slice(period)) value = (value * (period - 1) + current) / period;
  return value;
}

function macd(rows) {
  const closes = rows.map((row) => row.close);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const dif = closes.map((_, index) => finite(fast[index]) && finite(slow[index]) ? fast[index] - slow[index] : null);
  const start = dif.findIndex(finite);
  if (start < 0) return { dif: null, dea: null, hist: null, hist_delta: null };
  const signalTail = emaSeries(dif.slice(start), 9);
  const signal = Array(start).fill(null).concat(signalTail);
  const hist = dif.map((value, index) => finite(value) && finite(signal[index]) ? value - signal[index] : null);
  const valid = hist.filter(finite);
  return {
    dif: [...dif].reverse().find(finite) ?? null,
    dea: [...signal].reverse().find(finite) ?? null,
    hist: valid.at(-1) ?? null,
    hist_delta: valid.length > 1 ? valid.at(-1) - valid.at(-2) : null,
  };
}

function obv(rows) {
  if (!rows.length) return { value: null, delta5: null, slope15: null };
  let value = 0;
  const series = [0];
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].close > rows[index - 1].close) value += rows[index].quote_volume;
    else if (rows[index].close < rows[index - 1].close) value -= rows[index].quote_volume;
    series.push(value);
  }
  return { value, delta5: series.length > 5 ? value - series.at(-6) : null, slope15: slope(series.slice(-15)) };
}

function slope(values) {
  const xs = values.filter(finite);
  if (xs.length < 2) return null;
  const mx = (xs.length - 1) / 2;
  const my = mean(xs);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index++) {
    numerator += (index - mx) * (xs[index] - my);
    denominator += (index - mx) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

export function candleState(rows) {
  const last = rows.at(-1);
  if (!last) return {};
  const range = Math.max(last.high - last.low, Number.EPSILON);
  return {
    open_at: last.open_at, close_at: last.close_at, open: last.open, high: last.high, low: last.low, close: last.close,
    body_ratio: Math.abs(last.close - last.open) / range,
    body_sign: Math.sign(last.close - last.open),
    upper_wick_ratio: (last.high - Math.max(last.open, last.close)) / range,
    lower_wick_ratio: (Math.min(last.open, last.close) - last.low) / range,
    close_location: (last.close - last.low) / range,
    ma7: sma(rows, 7), ma25: sma(rows, 25), ma50: sma(rows, 50), atr: atr(rows),
    realized_volatility: rows.length > 20 ? Math.sqrt(mean(rows.slice(-20).slice(1).map((row, index) =>
      Math.log(row.close / rows.slice(-20)[index].close) ** 2))) : null,
  };
}

function priorReturn(rows, bars) {
  return rows.length > bars ? rows.at(-1).close / rows.at(-1 - bars).close - 1 : null;
}

export function chartFeatures(oneMinute, fiveMinute) {
  const last = oneMinute.at(-1);
  if (!last || oneMinute.length < 55 || fiveMinute.length < 26) throw new Error('CHART_HISTORY_INSUFFICIENT');
  const state = candleState(oneMinute);
  const atrValue = state.atr;
  const recent = oneMinute.slice(-30);
  const closes = recent.map((row) => row.close);
  const trough = Math.min(...closes);
  const troughIndex = closes.indexOf(trough);
  const before = recent.slice(0, Math.max(1, troughIndex));
  const beforeHigh = Math.max(...before.map((row) => row.high));
  const decline = beforeHigh > 0 ? beforeHigh / trough - 1 : 0;
  const recovery = beforeHigh > trough ? (last.close - trough) / (beforeHigh - trough) : 0;
  const uShape = troughIndex >= 5 && troughIndex <= 24 && decline >= Math.max(0.003, (atrValue ?? 0) / last.close * 0.75) &&
    recovery >= 0.65 && slope(closes.slice(troughIndex)) > 0;
  const priorWindow = oneMinute.slice(-35, -3);
  const priorHigh = Math.max(...priorWindow.map((row) => row.high));
  const previousLow = Math.min(...oneMinute.slice(-10, -5).map((row) => row.low));
  const recentLow = Math.min(...oneMinute.slice(-5).map((row) => row.low));
  const previousHigh = Math.max(...oneMinute.slice(-10, -5).map((row) => row.high));
  const recentHigh = Math.max(...oneMinute.slice(-5).map((row) => row.high));
  const breakout = last.close > priorHigh;
  const nearHigh = (last.close / priorHigh - 1) >= -Math.max(0.004, (atrValue ?? 0) / last.close);
  const retest = breakout && oneMinute.slice(-3).some((row) => row.low <= priorHigh && row.close >= priorHigh);
  const upperReject = state.upper_wick_ratio >= 0.45 && state.close_location < 0.55;
  const consecutiveBull = (() => { let count = 0; for (const row of [...oneMinute].reverse()) { if (row.close > row.open) count++; else break; } return count; })();
  const consecutiveBear = (() => { let count = 0; for (const row of [...oneMinute].reverse()) { if (row.close < row.open) count++; else break; } return count; })();
  return {
    higher_high: recentHigh > previousHigh, higher_low: recentLow > previousLow, u_shape_recovery: uShape,
    previous_high: priorHigh, distance_to_previous_high_pct: (last.close / priorHigh - 1) * 100,
    previous_high_approach: nearHigh, previous_high_breakout: breakout, breakout_retest_support: retest,
    ma7: state.ma7, ma25: state.ma25, ma50: state.ma50, atr: atrValue,
    atr_pct: atrValue / last.close * 100, trendline_slope: slope(closes) / last.close,
    last_close: last.close, upper_rejection: upperReject, consecutive_bullish: consecutiveBull,
    consecutive_bearish: consecutiveBear, five_minute: candleState(fiveMinute),
    price_resilience: priorReturn(oneMinute, 15) >= -Math.max(0.003, (atrValue ?? 0) / last.close) &&
      last.close >= (state.ma25 ?? last.close) * 0.995 && consecutiveBear <= 2,
  };
}

export function technicalFeatures(oneMinute) {
  const last = oneMinute.at(-1);
  const momentum = macd(oneMinute);
  const volumeRecent = mean(oneMinute.slice(-3).map((row) => row.quote_volume));
  const volumeBase = mean(oneMinute.slice(-23, -3).map((row) => row.quote_volume));
  const tape = oneMinute.slice(-5);
  const quote = sum(tape.map((row) => row.quote_volume));
  const buy = sum(tape.map((row) => row.taker_buy_quote));
  const sell = Math.max(0, quote - buy);
  const balance = obv(oneMinute);
  return {
    dif: momentum.dif, dea: momentum.dea, macd_hist: momentum.hist, macd_hist_delta: momentum.hist_delta,
    volume: last?.quote_volume ?? null, volume_acceleration: volumeBase ? volumeRecent / volumeBase : null,
    obv: balance.value, obv_delta_5m: balance.delta5, obv_slope_15m: balance.slope15,
    taker_buy: buy, taker_sell: sell, taker_buy_share: quote > 0 ? buy / quote : null,
    momentum_5m_pct: priorReturn(oneMinute, 5) * 100,
    momentum_15m_pct: priorReturn(oneMinute, 15) * 100,
    momentum_1h_pct: priorReturn(oneMinute, 60) * 100,
  };
}

function nearestBefore(rows, target) {
  return [...rows].reverse().find((row) => row.at <= target) ?? null;
}

export function derivativeFeatures({ premium, oiHistory, basisKlines, decisionAt }) {
  const mark = number(premium?.markPrice);
  const index = number(premium?.indexPrice);
  const funding = number(premium?.lastFundingRate);
  const oiRows = (Array.isArray(oiHistory) ? oiHistory : []).map((row) => ({
    at: number(row.timestamp), oi: number(row.sumOpenInterest), value: number(row.sumOpenInterestValue),
  })).filter((row) => row.at !== null && row.at <= decisionAt && row.oi !== null).sort((a, b) => a.at - b.at);
  const currentOi = oiRows.at(-1);
  const change = (milliseconds) => {
    const prior = nearestBefore(oiRows, decisionAt - milliseconds);
    return currentOi && prior?.oi > 0 ? (currentOi.oi / prior.oi - 1) * 100 : null;
  };
  const basisRows = (Array.isArray(basisKlines) ? basisKlines : []).map((row) => ({
    at: number(row?.[6]), value: number(row?.[4]) * 10_000,
  })).filter((row) => row.at !== null && row.at < decisionAt && row.value !== null).sort((a, b) => a.at - b.at);
  const recentSlope = slope(basisRows.slice(-10).map((row) => row.value));
  const priorSlope = slope(basisRows.slice(-20, -10).map((row) => row.value));
  return {
    mark_price: mark, index_price: index, funding_rate: funding,
    basis: mark !== null && index ? mark - index : null,
    basis_bps: mark !== null && index ? (mark / index - 1) * 10_000 : null,
    basis_slope: recentSlope, basis_acceleration: recentSlope !== null && priorSlope !== null ? recentSlope - priorSlope : null,
    open_interest: currentOi?.oi ?? null, open_interest_value: currentOi?.value ?? null,
    oi_change_15m_pct: change(15 * 60_000), oi_change_1h_pct: change(60 * 60_000),
  };
}

function boolScore(checks) {
  return Object.values(checks).filter(Boolean).length;
}

export function evaluateCandidate(strategy, { chart, technical, derivatives, funding }) {
  if (!STRATEGIES.includes(strategy)) throw new Error('STRATEGY_INVALID');
  const chartChecks = strategy === TREND ? {
    structure: chart.higher_high || chart.higher_low,
    preferred_shape: chart.u_shape_recovery || chart.previous_high_approach || chart.previous_high_breakout,
    trend: chart.last_close >= chart.ma25 && chart.ma7 >= chart.ma25,
    breakout_quality: chart.breakout_retest_support || chart.previous_high_approach || chart.u_shape_recovery,
    candle_quality: !chart.upper_rejection,
  } : {
    resilience: chart.price_resilience,
    trend_not_broken: chart.last_close >= chart.ma25 * 0.995,
    structure: chart.higher_low || chart.u_shape_recovery || chart.previous_high_approach || chart.previous_high_breakout,
    candle_quality: !chart.upper_rejection,
  };
  const chartScore = boolScore(chartChecks);
  const chartPass = strategy === TREND ? chartScore >= 4 && chartChecks.preferred_shape : chartScore >= 3 && chartChecks.resilience;
  if (!chartPass) return { stage: 'CHART_STRUCTURE_FAIL', decision: 'SKIP', reasons: ['CHART_STRUCTURE_FAIL'], scores: { chart: chartScore }, chart_checks: chartChecks };

  const priceUp = technical.momentum_15m_pct >= 0 && technical.momentum_1h_pct >= 0;
  const oiSupport = derivatives.oi_change_15m_pct >= 0 || derivatives.oi_change_1h_pct >= 0;
  const confirmationChecks = {
    oi_supportive: strategy === SQUEEZE ? oiSupport && priceUp : derivatives.oi_change_1h_pct >= -0.5,
    basis_supportive: strategy === SQUEEZE ? derivatives.basis_bps <= 0 || derivatives.basis_slope <= 0 : derivatives.basis_slope >= -0.25,
    macd_supportive: technical.macd_hist > 0 || technical.macd_hist_delta > 0,
    volume_supportive: technical.volume_acceleration >= 0.9,
    obv_supportive: technical.obv_delta_5m > 0,
    taker_supportive: technical.taker_buy_share >= (strategy === SQUEEZE ? 0.50 : 0.48),
  };
  const confirmationScore = boolScore(confirmationChecks);
  const fundingPass = strategy === TREND || funding?.outlier === true && funding.funding < 0;
  const indicatorPass = fundingPass && confirmationScore >= 4 && (strategy === TREND || confirmationChecks.oi_supportive && chart.price_resilience);
  if (!indicatorPass) {
    const reasons = [];
    if (!fundingPass) reasons.push('FUNDING_NOT_EXTREME');
    if (!confirmationChecks.oi_supportive) reasons.push('OI_NOT_SUPPORTIVE');
    if (!confirmationChecks.basis_supportive) reasons.push('BASIS_NOT_SUPPORTIVE');
    if (!confirmationChecks.macd_supportive) reasons.push('MOMENTUM_DECAY');
    if (!confirmationChecks.volume_supportive) reasons.push('VOLUME_WEAK');
    return { stage: 'INDICATOR_CONFIRMATION_FAIL', decision: 'SKIP', reasons: reasons.length ? reasons : ['INDICATOR_CONFIRMATION_FAIL'], scores: { chart: chartScore, confirmation: confirmationScore }, chart_checks: chartChecks, confirmation_checks: confirmationChecks };
  }
  return { stage: 'SHORTLISTED', decision: 'WAIT', reasons: [], scores: { chart: chartScore, confirmation: confirmationScore }, chart_checks: chartChecks, confirmation_checks: confirmationChecks };
}

function vwap(levels, notional) {
  let remaining = notional;
  let base = 0;
  for (const [price, quantity] of levels) {
    const quote = Math.min(remaining, price * quantity);
    base += quote / price;
    remaining -= quote;
    if (remaining <= 1e-8) return notional / base;
  }
  return null;
}

export function microstructure({ depth, trades, decisionAt, notional }) {
  const parseSide = (rows, descending) => (Array.isArray(rows) ? rows : []).map((row) => [number(row?.[0]), number(row?.[1])])
    .filter(([price, quantity]) => price > 0 && quantity > 0).sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]);
  const bids = parseSide(depth?.bids, true);
  const asks = parseSide(depth?.asks, false);
  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  if (!(bestBid > 0 && bestAsk >= bestBid)) throw new Error('ORDERBOOK_INVALID');
  const mid = (bestBid + bestAsk) / 2;
  const topBids = bids.slice(0, 20);
  const topAsks = asks.slice(0, 20);
  const bidDepth = sum(topBids.map(([price, quantity]) => price * quantity));
  const askDepth = sum(topAsks.map(([price, quantity]) => price * quantity));
  const buyVwap = vwap(asks, notional);
  const sellVwap = vwap(bids, notional);
  const recent = (Array.isArray(trades) ? trades : []).filter((trade) => {
    const at = number(trade?.T);
    return at !== null && at <= decisionAt && decisionAt - at <= 15_000;
  });
  let takerBuy = 0;
  let takerSell = 0;
  for (const trade of recent) {
    const quote = number(trade.p) * number(trade.q);
    if (!finite(quote) || quote < 0) continue;
    if (trade.m === false) takerBuy += quote;
    else takerSell += quote;
  }
  return {
    best_bid: bestBid, best_ask: bestAsk, mid, spread_bps: (bestAsk - bestBid) / mid * 10_000,
    bid_depth: bidDepth, ask_depth: askDepth, book_imbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null,
    buy_vwap: buyVwap, sell_vwap: sellVwap,
    estimated_slippage_bps: buyVwap ? (buyVwap / bestAsk - 1) * 10_000 : null,
    estimated_exit_slippage_bps: sellVwap ? (1 - sellVwap / bestBid) * 10_000 : null,
    taker_buy: takerBuy, taker_sell: takerSell,
    taker_buy_share: takerBuy + takerSell > 0 ? takerBuy / (takerBuy + takerSell) : null,
    captured_at_ms: decisionAt,
  };
}

export function microDecision(strategy, micro, parameters) {
  const reasons = [];
  if (micro.spread_bps > number(parameters.micro_max_spread_bps)) reasons.push('SPREAD_TOO_WIDE');
  if (micro.estimated_slippage_bps === null || micro.estimated_slippage_bps > number(parameters.micro_max_slippage_bps)) reasons.push('SLIPPAGE_TOO_HIGH');
  const notional = number(parameters.virtual_notional_quote);
  if (micro.bid_depth < notional || micro.ask_depth < notional || micro.buy_vwap === null || micro.sell_vwap === null) reasons.push('ORDERBOOK_UNFAVORABLE');
  if (micro.book_imbalance < number(parameters.micro_min_book_imbalance)) reasons.push('ORDERBOOK_UNFAVORABLE');
  const threshold = number(parameters.micro_min_taker_buy_share);
  if (micro.taker_buy_share === null || micro.taker_buy_share < threshold) reasons.push('TAKER_FLOW_UNFAVORABLE');
  return { executable: reasons.length === 0, reasons: [...new Set(reasons)], virtual_fill_price: reasons.length ? null : micro.buy_vwap };
}

export function weaknessScore(snapshot) {
  const chart = snapshot?.chart ?? {};
  const technical = snapshot?.technical ?? {};
  const derivatives = snapshot?.derivatives ?? {};
  const micro = snapshot?.microstructure ?? {};
  const reasons = [];
  if (chart.previous_high_breakout && !chart.breakout_retest_support || chart.upper_rejection) reasons.push('HIGH_RENEWAL_OR_BREAKOUT_FAILURE');
  if (!chart.higher_low && chart.last_close < chart.ma7) reasons.push('HIGHER_LOW_BREAK');
  if (chart.upper_rejection) reasons.push('STRONG_UPPER_WICK');
  if (technical.volume_acceleration < 0.8 && chart.distance_to_previous_high_pct >= -0.5) reasons.push('VOLUME_DIVERGENCE');
  if (technical.obv_delta_5m < 0) reasons.push('OBV_WEAKENING');
  if (technical.macd_hist_delta < 0 && technical.macd_hist <= 0) reasons.push('MACD_MOMENTUM_DECAY');
  if (derivatives.oi_change_15m_pct > 0 && technical.momentum_5m_pct < 0) reasons.push('OI_PRICE_NEGATIVE_DIVERGENCE');
  if (micro.taker_buy_share !== null && micro.taker_buy_share < 0.45) reasons.push('TAKER_BUY_WEAKENING');
  if (micro.book_imbalance < -0.2) reasons.push('ORDERBOOK_ASK_DOMINANCE');
  return { score: reasons.length, reasons, critical: reasons.includes('HIGHER_LOW_BREAK') || reasons.includes('OI_PRICE_NEGATIVE_DIVERGENCE') && reasons.includes('TAKER_BUY_WEAKENING') };
}

export function positionDecision({ strategy, position, snapshot, at, parameters }) {
  const bid = number(snapshot?.microstructure?.best_bid);
  if (!(bid > 0)) return { action: 'HOLD', reason: 'MARKET_DATA_UNAVAILABLE', weakness: { score: 0, reasons: [] } };
  const underlying = (bid / number(position.entry_price) - 1) * 100;
  if (underlying <= -5 || bid <= number(position.hard_stop_price)) {
    return { action: 'HARD_STOP', reason: 'UNDERLYING_HARD_STOP_MINUS_5_PCT', trigger_return_pct: underlying, weakness: weaknessScore(snapshot) };
  }
  const weakness = weaknessScore(snapshot);
  const heldSeconds = Math.max(0, Math.floor((at - Date.parse(position.entry_at)) / 1000));
  if (strategy === SQUEEZE) {
    if (heldSeconds >= 3600) return { action: 'FULL_EXIT', reason: 'SQUEEZE_MAX_HOLD_60M', held_seconds: heldSeconds, trigger_return_pct: underlying, weakness };
    if (weakness.critical || weakness.score >= 3) return { action: 'FULL_EXIT', reason: 'SQUEEZE_THESIS_WEAKENED', held_seconds: heldSeconds, trigger_return_pct: underlying, weakness };
    return { action: 'HOLD', reason: 'SQUEEZE_THESIS_INTACT', held_seconds: heldSeconds, trigger_return_pct: underlying, weakness };
  }
  if (strategy !== TREND) throw new Error('POSITION_STRATEGY_INVALID');
  const profitableAfterCost = underlying > ((number(parameters.fee_bps_per_fill) ?? 5) * 2 + 5) / 100;
  if (!position.partial_exit_done && profitableAfterCost && weakness.score >= (number(parameters.weakness_partial_score) ?? 2)) {
    return { action: 'PARTIAL_EXIT', fraction: number(parameters.partial_exit_fraction) ?? 0.5, reason: 'FIRST_MEANINGFUL_TREND_WEAKNESS', held_seconds: heldSeconds, trigger_return_pct: underlying, weakness };
  }
  if (position.partial_exit_done && (weakness.critical || weakness.score >= (number(parameters.weakness_full_score) ?? 4) - 1)) {
    return { action: 'FULL_EXIT', reason: 'TREND_THESIS_EXHAUSTED_AFTER_PARTIAL', held_seconds: heldSeconds, trigger_return_pct: underlying, weakness };
  }
  if (!position.partial_exit_done && (weakness.critical && weakness.score >= 3 || weakness.score >= (number(parameters.weakness_full_score) ?? 4))) {
    return { action: 'FULL_EXIT', reason: 'TREND_THESIS_INVALIDATED', held_seconds: heldSeconds, trigger_return_pct: underlying, weakness };
  }
  return { action: 'HOLD', reason: 'TREND_THESIS_INTACT', held_seconds: heldSeconds, trigger_return_pct: underlying, weakness };
}

/** Future data is accepted only by this outcome scorer, never by candidate/entry code. */
export function candidateOutcome({ referencePrice, decisionAt, candles, evaluatedAt }) {
  if (!(referencePrice > 0) || !Number.isSafeInteger(decisionAt) || !Number.isSafeInteger(evaluatedAt) || evaluatedAt < decisionAt + 120 * 60_000) {
    throw new Error('CANDIDATE_OUTCOME_NOT_MATURE');
  }
  const firstFullMinute = Math.ceil(decisionAt / 60_000) * 60_000;
  const future = candles.filter((row) => row.open_at >= firstFullMinute && row.close_at <= evaluatedAt)
    .sort((a, b) => a.open_at - b.open_at);
  if (!future.length) throw new Error('CANDIDATE_OUTCOME_DATA_MISSING');
  const closeAfter = (minutes) => future.find((row) => row.close_at >= decisionAt + minutes * 60_000 - 1)?.close ?? null;
  const returns = {};
  for (const minutes of [5, 15, 30, 60, 120]) {
    const close = closeAfter(minutes);
    returns[`forward_${minutes}m_pct`] = close === null ? null : (close / referencePrice - 1) * 100;
  }
  return {
    ...returns,
    mfe_2h_pct: (Math.max(...future.map((row) => row.high)) / referencePrice - 1) * 100,
    mae_2h_pct: (Math.min(...future.map((row) => row.low)) / referencePrice - 1) * 100,
    candle_count: future.length,
  };
}

export function publicBinancePath(path) {
  const allowed = new Set([
    '/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/ticker/24hr', '/fapi/v1/premiumIndex',
    '/fapi/v1/klines', '/fapi/v1/premiumIndexKlines', '/fapi/v1/openInterest', '/fapi/v1/depth',
    '/fapi/v1/aggTrades', '/futures/data/openInterestHist', '/futures/data/globalLongShortAccountRatio',
    '/futures/data/topLongShortAccountRatio', '/futures/data/topLongShortPositionRatio',
  ]);
  if (!allowed.has(path)) throw new Error('BINANCE_PUBLIC_PATH_BLOCKED');
  return path;
}
