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
  targetPct: { min: 0.003, max: 0.02 },
  stopPct: { min: 0.002, max: 0.015 },
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
  const imbalanceContribution = clamp(micro.book_imbalance, -0.40, 0.60) * 0.18;
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

  let pWin = cfg.basePWin + imbalanceContribution + pressureContribution +
    stabilityContribution + breakoutContribution + bidWallContribution -
    absorptionPenalty + dynamicAdjustment;
  if (trend.composite_trend <= cfg.weakDownThreshold) pWin *= cfg.weakDownPenalty;
  pWin = clamp(pWin, cfg.pWinFloor, cfg.pWinCeil);

  const signalScore = clamp((pWin - cfg.pWinFloor) / (cfg.pWinCeil - cfg.pWinFloor), 0, 1);
  const provisionalEdge = provisionalNetEdge(pWin, cfg.targetPct, cfg.stopPct, cfg.roundTripFeeFraction);
  if (provisionalEdge < cfg.minimumEdge) waitReasons.push("edge_below_minimum");

  reasons.push(...waitReasons, ...avoidReasons);
  const decision: ScalpSignalResult["decision"] = avoidReasons.length
    ? "AVOID"
    : waitReasons.length
    ? "WAIT"
    : "BUY";

  return { decision, vetoed, pWin, signalScore, provisionalEdge, targetPct: cfg.targetPct, stopPct: cfg.stopPct, reasons };
}
