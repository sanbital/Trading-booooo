// V10 integrated regime lanes. Single source of truth for research/shadow/production.
export type V10Lane = "BULL" | "RANGE" | "BEAR" | "CASH";
export type V10Side = "LONG";

export const V10_LANES_REVISION = "V10-LANES-2.0.0";
export const V10_LANE_UNIVERSE = Object.freeze([
  "ETHUSDT","XRPUSDT","SOLUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","BCHUSDT",
  "DOTUSDT","TRXUSDT","NEARUSDT","ETCUSDT","XLMUSDT","ATOMUSDT","UNIUSDT",
] as const);
export const V10_LANE_COST_BPS = 21;
export const V10_LANE_LIQUIDITY_24H_USDT = 50_000_000;

export const V10_LANE_CONFIG = Object.freeze({
  BULL: Object.freeze({
    fingerprint: "BULL_V10_LANES_2_0_0",
    btc72MinExclusive: 0.04,
    atrRatioMin: 1.60,
    bbPosMax: -0.20,
    assetR24Min: -0.02,
    holdHours: 12,
    cooldownHours: 12,
    side: "LONG" as const,
  }),
  RANGE: Object.freeze({
    fingerprint: "RANGE_V10_LANES_2_0_0",
    btc72MinInclusive: -0.05,
    btc72MaxInclusive: 0.04,
    atrRatioMin: 1.65,
    bbPosMax: -1.05,
    holdHours: 6,
    cooldownHours: 6,
    side: "LONG" as const,
  }),
  BEAR: Object.freeze({
    fingerprint: "BEAR_V10_LANES_2_0_0",
    btc72MaxExclusive: -0.05,
    atrRatioMin: 1.70,
    bbPosMax: -1.30,
    holdHours: 24,
    cooldownHours: 24,
    side: "LONG" as const,
  }),
});

export interface V10LaneObservation {
  symbol: string;
  completedBarAt: number;
  btcRet72: number | null;
  atr14h: number | null;
  atr30dPriorMean: number | null;
  bbPos20h: number | null;
  assetRet24: number | null;
  quoteVolume24h: number | null;
  barsContinuous: boolean;
}

export interface V10LaneDecision {
  lane: V10Lane;
  fingerprint: string | null;
  side: V10Side | null;
  holdHours: number | null;
  cooldownHours: number | null;
  reason: string;
}

function finite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function atrRatio(obs: V10LaneObservation): number | null {
  if (!finite(obs.atr14h) || !finite(obs.atr30dPriorMean) || obs.atr30dPriorMean <= 0) return null;
  return obs.atr14h / obs.atr30dPriorMean;
}

export function structuralLane(btcRet72: number | null): V10Lane {
  if (!finite(btcRet72)) return "CASH";
  if (btcRet72 < V10_LANE_CONFIG.BEAR.btc72MaxExclusive) return "BEAR";
  if (btcRet72 > V10_LANE_CONFIG.BULL.btc72MinExclusive) return "BULL";
  return "RANGE";
}

export function routeLane(obs: V10LaneObservation): V10LaneDecision {
  if (!V10_LANE_UNIVERSE.includes(obs.symbol as (typeof V10_LANE_UNIVERSE)[number])) {
    return { lane: "CASH", fingerprint: null, side: null, holdHours: null, cooldownHours: null, reason: "UNIVERSE" };
  }
  if (!obs.barsContinuous) {
    return { lane: "CASH", fingerprint: null, side: null, holdHours: null, cooldownHours: null, reason: "BAR_GAP" };
  }
  if (!finite(obs.quoteVolume24h) || obs.quoteVolume24h < V10_LANE_LIQUIDITY_24H_USDT) {
    return { lane: "CASH", fingerprint: null, side: null, holdHours: null, cooldownHours: null, reason: "LIQUIDITY" };
  }
  if (!finite(obs.bbPos20h)) {
    return { lane: "CASH", fingerprint: null, side: null, holdHours: null, cooldownHours: null, reason: "BB_MISSING" };
  }
  const ratio = atrRatio(obs);
  if (ratio === null) {
    return { lane: "CASH", fingerprint: null, side: null, holdHours: null, cooldownHours: null, reason: "ATR_MISSING" };
  }

  const structural = structuralLane(obs.btcRet72);
  if (structural === "BULL") {
    const c = V10_LANE_CONFIG.BULL;
    if (!finite(obs.assetRet24)) return { lane: "CASH", fingerprint: null, side: null, holdHours: null, cooldownHours: null, reason: "R24_MISSING" };
    if (ratio >= c.atrRatioMin && obs.bbPos20h <= c.bbPosMax && obs.assetRet24 >= c.assetR24Min) {
      return { lane: "BULL", fingerprint: c.fingerprint, side: c.side, holdHours: c.holdHours, cooldownHours: c.cooldownHours, reason: "BULL_PULLBACK" };
    }
  } else if (structural === "RANGE") {
    const c = V10_LANE_CONFIG.RANGE;
    if (ratio >= c.atrRatioMin && obs.bbPos20h <= c.bbPosMax) {
      return { lane: "RANGE", fingerprint: c.fingerprint, side: c.side, holdHours: c.holdHours, cooldownHours: c.cooldownHours, reason: "RANGE_MEAN_REVERSION" };
    }
  } else if (structural === "BEAR") {
    const c = V10_LANE_CONFIG.BEAR;
    if (ratio >= c.atrRatioMin && obs.bbPos20h <= c.bbPosMax) {
      return { lane: "BEAR", fingerprint: c.fingerprint, side: c.side, holdHours: c.holdHours, cooldownHours: c.cooldownHours, reason: "BEAR_CAPITULATION_REBOUND" };
    }
  }
  return { lane: "CASH", fingerprint: null, side: null, holdHours: null, cooldownHours: null, reason: "NO_EDGE" };
}
