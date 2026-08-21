export type P10Venue = "upbit_spot" | "binance_spot" | "binance_futures";
export type P10Side = "LONG" | "SHORT";

export const P10_STRATEGY_KEY = "P10_DONCHIAN_BREAKOUT_E10_SLOW_4R";
export const P10_REVISION = "P10-LIVE-1.0.0";
export const P10_HOUR_MS = 3_600_000;

export const P10_CONFIG = Object.freeze({
  breakoutLookback: 72,
  breakoutBufferAtr: 0.10,
  minVolumeRatio: 1.60,
  trendMinPct: 1.20,
  trendMaxPct: 20,
  minCloseLocation: 0.74,
  minEmaSlope6Pct: 0.10,
  maxEntryGapAtr: 0.50,
  stopAtr: 2.00,
  targetR: 4.00,
  trailAtr: 2.50,
  breakEvenAtR: 1.50,
  partialAtR: 2.00,
  partialFraction: 0.40,
  lossTimeStopBars: 24,
  maxHoldBars: 96,
});

export interface P10Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

export interface P10PreparedBar extends P10Bar {
  ema20: number;
  ema50: number;
  ema100: number;
  ema20Slope6Pct: number;
  atr14: number;
  rsi14: number;
  ret24Pct: number;
  ret72Pct: number;
  efficiency24: number;
  high72Prev: number;
  low72Prev: number;
  volumeRatio: number;
  quoteVolumeMean20: number;
}

export interface P10BenchmarkState {
  regime: "BULL" | "BEAR" | "RANGE";
  ret24Pct: number;
  ret72Pct: number;
}

export interface P10Signal {
  strategyKey: typeof P10_STRATEGY_KEY;
  revision: typeof P10_REVISION;
  venue: P10Venue;
  side: P10Side;
  signalTime: number;
  referenceClose: number;
  atr14: number;
  score: number;
  stopReference: number;
  benchmark: P10BenchmarkState;
  asset: {
    ret24Pct: number;
    ret72Pct: number;
    ema20: number;
    ema50: number;
    ema20Slope6Pct: number;
    rsi14: number;
    volumeRatio: number;
    quoteVolumeMean20: number;
    closeLocation: number;
    high72Prev: number;
    low72Prev: number;
  };
}

export interface P10EntryPlan {
  allowed: boolean;
  reason: string | null;
  side: P10Side;
  entryPrice: number;
  initialRisk: number;
  riskPct: number;
  stopPrice: number;
  partialTarget: number;
  finalTarget: number;
}

export interface P10ExitInput {
  side: P10Side;
  entryPrice: number;
  initialRisk: number;
  currentStop: number;
  partialDone: boolean;
  executablePrice: number;
  entryBarTime: number;
  openedAtMs: number;
  nowMs: number;
  lastPolicyBarTime: number;
  latestCompletedBar: P10PreparedBar | null;
  roundTripCostBps: number;
}

export interface P10ExitDecision {
  action: "NONE" | "TARGET_1" | "TARGET_2" | "STOP" | "RULE" | "TIME";
  reason: string | null;
  fraction: number;
  nextStop: number;
  policyBarTime: number;
}

const finite = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (now: number, before: number) => before > 0 ? (now / before - 1) * 100 : 0;

function ema(values: number[], period: number) {
  const output = new Array<number>(values.length).fill(Number.NaN);
  if (!values.length) return output;
  const alpha = 2 / (period + 1);
  let value = values[0];
  output[0] = value;
  for (let index = 1; index < values.length; index++) {
    value = values[index] * alpha + value * (1 - alpha);
    output[index] = value;
  }
  return output;
}

function wilder(values: number[], period: number) {
  const output = new Array<number>(values.length).fill(Number.NaN);
  if (!values.length) return output;
  let value = values[0];
  output[0] = value;
  for (let index = 1; index < values.length; index++) {
    value = (value * (period - 1) + values[index]) / period;
    output[index] = value;
  }
  return output;
}

function rolling(values: number[], period: number, kind: "max" | "min" | "mean") {
  const output = new Array<number>(values.length).fill(Number.NaN);
  for (let index = 0; index < values.length; index++) {
    const slice = values.slice(Math.max(0, index - period + 1), index + 1);
    output[index] = kind === "max"
      ? Math.max(...slice)
      : kind === "min"
      ? Math.min(...slice)
      : mean(slice);
  }
  return output;
}

function efficiency(values: number[], period: number) {
  const output = new Array<number>(values.length).fill(0);
  for (let index = period; index < values.length; index++) {
    let path = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor++) {
      path += Math.abs(values[cursor] - values[cursor - 1]);
    }
    output[index] = path > 0
      ? Math.min(1, Math.abs(values[index] - values[index - period]) / path)
      : 0;
  }
  return output;
}

function rsi(closes: number[], period = 14) {
  const gains = new Array<number>(closes.length).fill(0);
  const losses = new Array<number>(closes.length).fill(0);
  for (let index = 1; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1];
    gains[index] = Math.max(change, 0);
    losses[index] = Math.max(-change, 0);
  }
  const averageGain = wilder(gains, period);
  const averageLoss = wilder(losses, period);
  return closes.map((_, index) => {
    if (averageLoss[index] === 0) return averageGain[index] === 0 ? 50 : 100;
    const relativeStrength = averageGain[index] / averageLoss[index];
    return 100 - 100 / (1 + relativeStrength);
  });
}

export function prepareP10Bars(input: P10Bar[]): P10PreparedBar[] {
  const bars = [...input]
    .filter((bar) => bar.time > 0 && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0)
    .sort((left, right) => left.time - right.time)
    .filter((bar, index, rows) => index === 0 || bar.time !== rows[index - 1].time);
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const volumes = bars.map((bar) => Math.max(0, bar.quoteVolume || bar.volume));
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema100 = ema(closes, 100);
  const trueRanges = bars.map((bar, index) =>
    index === 0 ? bar.high - bar.low : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[index - 1].close),
      Math.abs(bar.low - bars[index - 1].close),
    )
  );
  const atr14 = wilder(trueRanges, 14);
  const rsi14 = rsi(closes, 14);
  const efficiency24 = efficiency(closes, 24);
  const high72 = rolling(highs, 72, "max");
  const low72 = rolling(lows, 72, "min");
  const volume20 = rolling(volumes, 20, "mean");
  return bars.map((bar, index) => ({
    ...bar,
    ema20: ema20[index],
    ema50: ema50[index],
    ema100: ema100[index],
    ema20Slope6Pct: index >= 6 ? pct(ema20[index], ema20[index - 6]) : 0,
    atr14: atr14[index],
    rsi14: rsi14[index],
    ret24Pct: index >= 24 ? pct(bar.close, bars[index - 24].close) : 0,
    ret72Pct: index >= 72 ? pct(bar.close, bars[index - 72].close) : 0,
    efficiency24: efficiency24[index],
    high72Prev: index > 0 ? high72[index - 1] : bar.high,
    low72Prev: index > 0 ? low72[index - 1] : bar.low,
    volumeRatio: volume20[index] > 0 ? volumes[index] / volume20[index] : 0,
    quoteVolumeMean20: volume20[index],
  }));
}

export function p10BenchmarkStates(input: P10Bar[]) {
  const bars = prepareP10Bars(input);
  const output = new Map<number, P10BenchmarkState>();
  for (let index = 100; index < bars.length; index++) {
    const bar = bars[index];
    const emaSeparationPct = pct(bar.ema20, bar.ema50);
    const bull = bar.close > bar.ema20 && bar.ema20 > bar.ema50 &&
      bar.ema50 > bar.ema100 && emaSeparationPct >= 0.15 &&
      bar.ret24Pct >= 0.20 && bar.ret72Pct >= 0.5;
    const bear = bar.close < bar.ema20 && bar.ema20 < bar.ema50 &&
      bar.ema50 < bar.ema100 && emaSeparationPct <= -0.15 &&
      bar.ret24Pct <= -0.20 && bar.ret72Pct <= -0.5;
    output.set(bar.time, {
      regime: bull ? "BULL" : bear ? "BEAR" : "RANGE",
      ret24Pct: bar.ret24Pct,
      ret72Pct: bar.ret72Pct,
    });
  }
  return output;
}

export function p10LiquidityFloor(venue: P10Venue) {
  if (venue === "upbit_spot") return 100_000_000;
  return venue === "binance_futures" ? 500_000 : 100_000;
}

export function p10RoundTripCostBps(venue: P10Venue) {
  if (venue === "upbit_spot") return 20;
  if (venue === "binance_futures") return 18;
  return 26;
}

function p10RegimeEligible(state: P10BenchmarkState, side: P10Side) {
  if (side === "LONG") {
    return state.regime !== "BEAR" && state.ret24Pct >= 0.10 && state.ret72Pct >= 0;
  }
  return state.regime !== "BULL" && state.ret24Pct <= -0.10 && state.ret72Pct <= 0;
}

function p10SignalScore(bar: P10PreparedBar, state: P10BenchmarkState, side: P10Side) {
  const direction = side === "LONG" ? 1 : -1;
  return direction * bar.ret24Pct + direction * (bar.ret24Pct - state.ret24Pct) +
    bar.volumeRatio * 0.25 + bar.efficiency24;
}

function p10SignalEligible(
  bar: P10PreparedBar,
  previous: P10PreparedBar,
  state: P10BenchmarkState,
  side: P10Side,
  liquidityFloor: number,
) {
  const long = side === "LONG";
  const direction = long ? 1 : -1;
  if (
    !p10RegimeEligible(state, side) || bar.atr14 <= 0 || previous.atr14 <= 0 ||
    bar.close <= 0 || bar.high <= bar.low || bar.volumeRatio < P10_CONFIG.minVolumeRatio ||
    bar.quoteVolumeMean20 < liquidityFloor
  ) return false;
  const atrPct = bar.atr14 / bar.close * 100;
  if (atrPct < 0.15 || atrPct > 6 || P10_CONFIG.stopAtr * atrPct > 5) return false;
  const directionalReturn24 = direction * bar.ret24Pct;
  if (
    directionalReturn24 < P10_CONFIG.trendMinPct ||
    directionalReturn24 > P10_CONFIG.trendMaxPct
  ) return false;
  const closeLocation = (bar.close - bar.low) / (bar.high - bar.low);
  const directionalCloseLocation = long ? closeLocation : 1 - closeLocation;
  const candleDirection = long ? bar.close > bar.open : bar.close < bar.open;
  const emaDirection = long ? bar.ema20 > bar.ema50 : bar.ema20 < bar.ema50;
  const rsiDirection = long
    ? bar.rsi14 >= 48 && bar.rsi14 <= 84
    : bar.rsi14 >= 16 && bar.rsi14 <= 52;
  if (
    !candleDirection || !emaDirection || !rsiDirection ||
    direction * bar.ema20Slope6Pct < P10_CONFIG.minEmaSlope6Pct ||
    directionalCloseLocation < P10_CONFIG.minCloseLocation
  ) return false;
  return long
    ? bar.close > bar.high72Prev + P10_CONFIG.breakoutBufferAtr * bar.atr14 &&
      previous.close <= bar.high72Prev
    : bar.close < bar.low72Prev - P10_CONFIG.breakoutBufferAtr * bar.atr14 &&
      previous.close >= bar.low72Prev;
}

export function detectLatestP10Signal(
  venue: P10Venue,
  input: P10Bar[],
  benchmarkInput: P10Bar[],
): P10Signal | null {
  const bars = prepareP10Bars(input);
  if (bars.length < 106) return null;
  const bar = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const state = p10BenchmarkStates(benchmarkInput).get(bar.time);
  if (!state) return null;
  const permitted: P10Side[] = venue === "binance_futures" ? ["LONG", "SHORT"] : ["LONG"];
  const eligible = permitted.filter((side) =>
    p10SignalEligible(bar, previous, state, side, p10LiquidityFloor(venue))
  );
  if (!eligible.length) return null;
  const side =
    eligible.sort((left, right) =>
      p10SignalScore(bar, state, right) - p10SignalScore(bar, state, left)
    )[0];
  const closeLocation = (bar.close - bar.low) / (bar.high - bar.low);
  return {
    strategyKey: P10_STRATEGY_KEY,
    revision: P10_REVISION,
    venue,
    side,
    signalTime: bar.time,
    referenceClose: bar.close,
    atr14: bar.atr14,
    score: p10SignalScore(bar, state, side),
    stopReference: side === "LONG"
      ? bar.close - P10_CONFIG.stopAtr * bar.atr14
      : bar.close + P10_CONFIG.stopAtr * bar.atr14,
    benchmark: state,
    asset: {
      ret24Pct: bar.ret24Pct,
      ret72Pct: bar.ret72Pct,
      ema20: bar.ema20,
      ema50: bar.ema50,
      ema20Slope6Pct: bar.ema20Slope6Pct,
      rsi14: bar.rsi14,
      volumeRatio: bar.volumeRatio,
      quoteVolumeMean20: bar.quoteVolumeMean20,
      closeLocation,
      high72Prev: bar.high72Prev,
      low72Prev: bar.low72Prev,
    },
  };
}

export function planP10Entry(
  side: P10Side,
  referenceClose: number,
  atr14: number,
  entryPrice: number,
): P10EntryPlan {
  const risk = P10_CONFIG.stopAtr * finite(atr14);
  const gapAtr = risk > 0 ? Math.abs(entryPrice - referenceClose) / finite(atr14) : Infinity;
  const riskPct = entryPrice > 0 ? risk / entryPrice * 100 : Infinity;
  const allowed = referenceClose > 0 && atr14 > 0 && entryPrice > 0 &&
    gapAtr <= P10_CONFIG.maxEntryGapAtr && riskPct <= 5;
  const direction = side === "LONG" ? 1 : -1;
  return {
    allowed,
    reason: allowed
      ? null
      : gapAtr > P10_CONFIG.maxEntryGapAtr
      ? `entry gap ${gapAtr.toFixed(4)} ATR exceeds ${P10_CONFIG.maxEntryGapAtr}`
      : riskPct > 5
      ? `initial stop risk ${riskPct.toFixed(4)}% exceeds 5%`
      : "invalid entry plan",
    side,
    entryPrice,
    initialRisk: risk,
    riskPct,
    stopPrice: entryPrice - direction * risk,
    partialTarget: entryPrice + direction * P10_CONFIG.partialAtR * risk,
    finalTarget: entryPrice + direction * P10_CONFIG.targetR * risk,
  };
}

export function evaluateP10Exit(input: P10ExitInput): P10ExitDecision {
  const long = input.side === "LONG";
  const direction = long ? 1 : -1;
  const partialTarget = input.entryPrice + direction * P10_CONFIG.partialAtR * input.initialRisk;
  const finalTarget = input.entryPrice + direction * P10_CONFIG.targetR * input.initialRisk;
  let nextStop = input.currentStop;
  let policyBarTime = input.lastPolicyBarTime;
  let ruleReason: string | null = null;
  const bar = input.latestCompletedBar;
  if (bar && bar.time > input.lastPolicyBarTime) {
    const favorableCloseR = direction * (bar.close - input.entryPrice) / input.initialRisk;
    if (favorableCloseR >= P10_CONFIG.breakEvenAtR) {
      const stressCostRate = Math.max(0, input.roundTripCostBps) * 1.5 / 10_000;
      const breakEven = long
        ? input.entryPrice * (1 + stressCostRate)
        : input.entryPrice * (1 - stressCostRate);
      nextStop = long ? Math.max(nextStop, breakEven) : Math.min(nextStop, breakEven);
    }
    if (favorableCloseR > 0 && bar.atr14 > 0) {
      const trailing = long
        ? bar.close - P10_CONFIG.trailAtr * bar.atr14
        : bar.close + P10_CONFIG.trailAtr * bar.atr14;
      nextStop = long ? Math.max(nextStop, trailing) : Math.min(nextStop, trailing);
    }
    const heldBars = Math.floor((bar.time - input.entryBarTime) / P10_HOUR_MS) + 1;
    const emaExit = long ? bar.close < bar.ema20 : bar.close > bar.ema20;
    const losingTimeExit = heldBars >= P10_CONFIG.lossTimeStopBars &&
      (long ? bar.close <= input.entryPrice : bar.close >= input.entryPrice);
    ruleReason = emaExit ? "EMA20_CLOSE" : losingTimeExit ? "LOSS_TIME_24H" : null;
    policyBarTime = bar.time;
  }
  const stopHit = long ? input.executablePrice <= nextStop : input.executablePrice >= nextStop;
  if (stopHit) {
    return { action: "STOP", reason: "STOP_FIRST", fraction: 1, nextStop, policyBarTime };
  }
  const targetHit = long
    ? input.executablePrice >= finalTarget
    : input.executablePrice <= finalTarget;
  if (targetHit) {
    return { action: "TARGET_2", reason: "FINAL_4R", fraction: 1, nextStop, policyBarTime };
  }
  const partialHit = !input.partialDone &&
    (long ? input.executablePrice >= partialTarget : input.executablePrice <= partialTarget);
  if (partialHit) {
    return {
      action: "TARGET_1",
      reason: "PARTIAL_2R_40PCT",
      fraction: P10_CONFIG.partialFraction,
      nextStop,
      policyBarTime,
    };
  }
  if (ruleReason) {
    return { action: "RULE", reason: ruleReason, fraction: 1, nextStop, policyBarTime };
  }
  if (input.nowMs - input.openedAtMs >= P10_CONFIG.maxHoldBars * P10_HOUR_MS) {
    return { action: "TIME", reason: "MAX_HOLD_96H", fraction: 1, nextStop, policyBarTime };
  }
  return { action: "NONE", reason: null, fraction: 0, nextStop, policyBarTime };
}
