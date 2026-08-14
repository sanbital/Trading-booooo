// Scalp entry signal (balanced turnover profile).
//
// Agreed hierarchy:
//   - ENTRY is driven by current orderbook and trade flow.
//   - Higher-timeframe trend has a veto only when it is clearly bearish.
//   - Microstructure factors are combined into pWin; they are not all separate hard gates.
//   - Hard blocks are reserved for stale/invalid data, excessive spread, explicit order-flow
//     danger states, and an expected edge that does not clear fees/slippage plus margin.

import { provisionalNetEdge } from "./cost-model.ts";

export interface ScalpMicro {
  samples: number;
  spread_bps: number | null;
  book_imbalance: number;        // normalized -1..1; > 0 means bid-side dominance
  imbalance_stability: number;   // 0..1
  trade_pressure: number;        // normalized -1..1; > 0 means buyer aggression
  live_book_age_ms: number | null;
  persistent_bid_wall: boolean;
  ask_absorption_score: number;  // 0..1
  breakout_score: number;        // 0..1
  dynamic_status: string;
}

export interface ScalpTrend {
  h4_trend_signal: number;
  composite_trend: number;
}

export interface ScalpSignalConfig {
  minImbalance: number;      // diagnostic center, not a standalone veto
  minStability: number;      // diagnostic center, not a standalone veto
  maxSpreadBps: number;      // true execution-cost gate
  maxAskAbsorption: number;  // penalty threshold; explicit risk status remains a hard block
  requireBidWall: boolean;   // optional operator override; false by default
  maxBookAgeMs: number;
  minSamples: number;
  strongDownVeto: number;
  weakDownThreshold: number;
  weakDownPenalty: number;
  basePWin: number;
  pWinFloor: number;
  pWinCeil: number;
  targetPct: number;
  stopPct: number;
  roundTripFeeFraction: number;
  minimumEdge: number;
  /** v5.3: P(a barrier is touched before the max holding time). Supplied by geometry.ts. */
  resolveProbability: number;
  /**
   * v5.7: the driftless probability of touching the target first, S/(T+S).
   *
   * THE BUG THIS FIXES. Through v5.6 pWin was built as `basePWin + microstructure terms`
   * with no reference to where the barriers actually are, so a 4% target was assigned the
   * same probability as a 0.6% one and its expected value was inflated accordingly. That
   * is what made wide-target sizing look attractive.
   *
   * P(target first) depends on the barrier geometry before any signal exists. The
   * microstructure model can only supply an EDGE over that baseline:
   *
   *     pWin = neutralWinRate + signalEdge
   *
   * Supplied by geometry.ts. Leave at 0 to fall back to the legacy absolute basePWin.
   */
  neutralWinRate: number;
  /** v5.3: half-life used to decay scan-time alpha when the signal is re-priced at order time. */
  alphaHalfLifeMs: number;
}

export const DEFAULT_SCALP_SIGNAL: ScalpSignalConfig = {
  // book_imbalance is a normalized difference in [-1, 1]. The old 0.8 threshold
  // required near-total bid dominance and unintentionally eliminated almost every market.
  minImbalance: 0.08,
  minStability: 0.30,
  maxSpreadBps: 15,
  maxAskAbsorption: 0.75,
  requireBidWall: false,
  maxBookAgeMs: 5000,
  minSamples: 2,
  strongDownVeto: -0.65,
  weakDownThreshold: -0.20,
  weakDownPenalty: 0.92,
  basePWin: 0.52,
  pWinFloor: 0.30,
  pWinCeil: 0.85,
  targetPct: 0.006,
  stopPct: 0.003,
  roundTripFeeFraction: 0.001,
  // Original agreement: costs must be cleared with about 0.10% net margin.
  minimumEdge: 0.001,
  // 1 preserves the v5.2.5 (barrier-always-resolves) behavior; geometry.ts overrides it.
  resolveProbability: 1,
  // 0 = not supplied; the legacy absolute basePWin is used instead.
  neutralWinRate: 0,
  // Microstructure alpha decays in seconds, not minutes. See refreshPWinAtOrderTime().
  alphaHalfLifeMs: 20_000,
};

const HARD_RISK_DYNAMIC = new Set([
  "SPOOF_LIKE_RISK",
  "ASK_ABSORPTION_RISK",
  "SUPPORT_BREAKDOWN_RISK",
]);

export interface ScalpBounds { min: number; max: number }
export const SCALP_BOUNDS: Record<string, ScalpBounds> = {
  minImbalance: { min: -0.10, max: 0.50 },
  minStability: { min: 0.10, max: 0.90 },
  maxSpreadBps: { min: 3, max: 30 },
  maxAskAbsorption: { min: 0.20, max: 0.95 },
  strongDownVeto: { min: -1, max: -0.30 },
  weakDownThreshold: { min: -0.50, max: 0 },
  weakDownPenalty: { min: 0.70, max: 1 },
  basePWin: { min: 0.45, max: 0.62 },
  targetPct: { min: 0.003, max: 0.05 },
  stopPct: { min: 0.0015, max: 0.025 },
  minimumEdge: { min: 0.001, max: 0.003 },
};

function clampBound(key: string, value: number, fallback: number): number {
  const b = SCALP_BOUNDS[key];
  if (!Number.isFinite(value)) return fallback;
  if (!b) return value;
  return Math.max(b.min, Math.min(b.max, value));
}

export function resolveScalpSignalConfig(overrides: Partial<ScalpSignalConfig> = {}): ScalpSignalConfig {
  const merged: ScalpSignalConfig = { ...DEFAULT_SCALP_SIGNAL, ...overrides };
  for (const key of Object.keys(SCALP_BOUNDS)) {
    (merged as any)[key] = clampBound(key, (merged as any)[key], (DEFAULT_SCALP_SIGNAL as any)[key]);
  }
  if (merged.targetPct <= merged.stopPct) {
    merged.targetPct = clampBound("targetPct", merged.stopPct * 2, DEFAULT_SCALP_SIGNAL.targetPct);
  }
  return merged;
}

export interface ScalpSignalResult {
  decision: "BUY" | "WAIT" | "AVOID";
  vetoed: boolean;
  pWin: number;
  signalScore: number;
  provisionalEdge: number;
  targetPct: number;
  stopPct: number;
  reasons: string[];
  /** v5.3: pWin term contributed by the resting orderbook, so it can be recomputed
   *  against a fresh book at order time instead of being reused from scan time. */
  imbalanceContribution: number;
  /** v5.3: multiplicative trend penalty already applied to the signal edge (1 = none). */
  trendPenalty: number;
  /** v5.7: barrier-implied baseline the edge was added to. */
  neutralWinRate: number;
  /** v5.7: the edge the microstructure model claims over that baseline. */
  signalEdge: number;
  /** v5.3: raw feature values, persisted for the pWin calibration loop. */
  features: Record<string, number>;
}

/** v5.3: the pWin term contributed by the resting book, isolated so it can be re-priced. */
export function imbalanceContribution(bookImbalance: number): number {
  return clamp(bookImbalance, -0.40, 0.60) * 0.18;
}

/**
 * v5.3: re-price a scan-time pWin against the orderbook that exists at order time.
 *
 * v5.2.5 computed pWin during the scan and then reused that number verbatim when the
 * order was actually placed, refreshing only the depth used for slippage. With a 60s
 * scan cadence the signal driving the entry could be a minute old — far beyond the
 * useful life of orderbook alpha — while `maxBookAgeMs: 5000` gave the false impression
 * that freshness was being enforced.
 *
 * The book term is recomputed from the live book. Everything else (trade pressure,
 * breakout, absorption) cannot be recomputed without re-observing, so it is decayed
 * toward the base rate with `alphaHalfLifeMs`.
 */
export function refreshPWinAtOrderTime(
  scanPWin: number,
  scanImbalanceContribution: number,
  freshBookImbalance: number,
  ageMs: number,
  cfg: ScalpSignalConfig = DEFAULT_SCALP_SIGNAL,
  trendPenalty = 1,
  neutralWinRate = 0,
): number {
  // v5.7: decay toward the BARRIER BASELINE, not toward a flat constant. As the signal
  // ages the estimate must fall back to what the geometry alone implies.
  const anchor = neutralWinRate > 0
    ? neutralWinRate
    : (cfg.neutralWinRate > 0 ? cfg.neutralWinRate : cfg.basePWin);
  const scanEdge = scanPWin - anchor - scanImbalanceContribution * trendPenalty;
  const decay = Math.pow(0.5, Math.max(0, ageMs) / Math.max(1, cfg.alphaHalfLifeMs));
  const refreshed = anchor + scanEdge * decay +
    imbalanceContribution(freshBookImbalance) * trendPenalty;
  return clamp(refreshed, cfg.pWinFloor, cfg.pWinCeil);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function evaluateScalpSignal(
  micro: ScalpMicro,
  trend: ScalpTrend,
  cfg: ScalpSignalConfig = DEFAULT_SCALP_SIGNAL,
): ScalpSignalResult {
  const reasons: string[] = [];
  const waitReasons: string[] = [];
  const avoidReasons: string[] = [];

  // Trend is a veto, not an entry signal.
  const vetoed = trend.h4_trend_signal <= cfg.strongDownVeto;
  if (vetoed) avoidReasons.push("trend_strong_down_veto");

  // Only data/execution integrity remains a hard WAIT.
  if (micro.samples < cfg.minSamples) waitReasons.push("insufficient_samples");
  if (micro.live_book_age_ms === null || micro.live_book_age_ms > cfg.maxBookAgeMs) {
    waitReasons.push("stale_book");
  }
  if (micro.spread_bps === null || micro.spread_bps > cfg.maxSpreadBps) {
    waitReasons.push("spread_too_wide");
  }
  if (cfg.requireBidWall && !micro.persistent_bid_wall) waitReasons.push("no_support_wall");
  if (HARD_RISK_DYNAMIC.has(micro.dynamic_status)) {
    avoidReasons.push(`dynamic_${micro.dynamic_status.toLowerCase()}`);
  }

  // These are diagnostics/score inputs, not standalone vetoes.
  if (micro.book_imbalance < cfg.minImbalance) reasons.push("weak_buy_imbalance");
  if (micro.imbalance_stability < cfg.minStability) reasons.push("unstable_imbalance");
  if (!micro.persistent_bid_wall) reasons.push("no_support_wall");
  if (micro.ask_absorption_score > cfg.maxAskAbsorption) reasons.push("ask_absorption_pressure");
  if (micro.dynamic_status === "INSUFFICIENT") reasons.push("dynamic_insufficient");

  // Combine current book + executed trades into one probability estimate.
  // No single ordinary micro factor must be perfect if the combined flow is strong.
  const imbalanceTerm = imbalanceContribution(micro.book_imbalance);
  const pressureContribution = clamp(micro.trade_pressure, -1, 1) * 0.12;
  const stabilityContribution = (clamp(micro.imbalance_stability, 0, 1) - 0.50) * 0.08;
  const breakoutContribution = clamp(micro.breakout_score, 0, 1) * 0.10;
  const bidWallContribution = micro.persistent_bid_wall ? 0.025 : 0;
  const absorptionPenalty = clamp(micro.ask_absorption_score, 0, 1) * 0.10;
  const dynamicAdjustment = micro.dynamic_status === "BREAKOUT_CONFIRMED"
    ? 0.03
    : micro.dynamic_status === "INSUFFICIENT"
    ? -0.03
    : 0;

  // The microstructure model produces an EDGE over the barrier baseline, not an absolute
  // probability. Summing these terms onto a flat 0.52 was the modelling error: it made
  // pWin independent of where the target and stop actually sit.
  let signalEdge = imbalanceTerm + pressureContribution + stabilityContribution +
    breakoutContribution + bidWallContribution - absorptionPenalty + dynamicAdjustment;
  // A weak downtrend erodes the EDGE. Applying it to the probability instead would drag
  // the estimate below the geometric baseline, which the trend cannot do.
  const trendPenalty = trend.composite_trend <= cfg.weakDownThreshold ? cfg.weakDownPenalty : 1;
  signalEdge *= trendPenalty;
  // Anchor: the driftless probability implied by this barrier pair. Falls back to the
  // legacy absolute base only when geometry has not supplied one.
  const anchor = cfg.neutralWinRate > 0
    ? cfg.neutralWinRate
    : (cfg.targetPct + cfg.stopPct > 0 ? cfg.stopPct / (cfg.targetPct + cfg.stopPct) : cfg.basePWin);
  const pWin = clamp(anchor + signalEdge, cfg.pWinFloor, cfg.pWinCeil);

  const signalScore = clamp((pWin - cfg.pWinFloor) / (cfg.pWinCeil - cfg.pWinFloor), 0, 1);
  const provisionalEdge = provisionalNetEdge(
    pWin,
    cfg.targetPct,
    cfg.stopPct,
    cfg.roundTripFeeFraction,
    cfg.resolveProbability,
  );
  if (provisionalEdge < cfg.minimumEdge) waitReasons.push("edge_below_minimum");

  reasons.push(...waitReasons, ...avoidReasons);
  const decision: ScalpSignalResult["decision"] = avoidReasons.length
    ? "AVOID"
    : waitReasons.length
    ? "WAIT"
    : "BUY";

  return {
    decision,
    vetoed,
    pWin,
    signalScore,
    provisionalEdge,
    targetPct: cfg.targetPct,
    stopPct: cfg.stopPct,
    reasons,
    imbalanceContribution: imbalanceTerm,
    trendPenalty,
    neutralWinRate: anchor,
    signalEdge,
    features: {
      book_imbalance: micro.book_imbalance,
      imbalance_stability: micro.imbalance_stability,
      trade_pressure: micro.trade_pressure,
      breakout_score: micro.breakout_score,
      ask_absorption_score: micro.ask_absorption_score,
      persistent_bid_wall: micro.persistent_bid_wall ? 1 : 0,
      spread_bps: micro.spread_bps ?? -1,
      samples: micro.samples,
      h4_trend_signal: trend.h4_trend_signal,
      composite_trend: trend.composite_trend,
      resolve_probability: cfg.resolveProbability,
    },
  };
}
