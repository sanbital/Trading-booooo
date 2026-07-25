// Scalp entry signal (Stage 3 — pure decision core).
//
// Inverts the decision hierarchy for scalp mode:
//   - ENTRY is driven by orderbook microstructure (buy-side imbalance, a persistent
//     bid wall for support, low ask absorption, tight spread, healthy dynamic state).
//   - TREND is only a VETO: a strong higher-timeframe downtrend hard-blocks; a weak
//     downtrend just penalizes the win-probability estimate (does not block).
//   - The probability-weighted provisional edge (fees only) must still clear a margin.
//     Precise stressed slippage is applied later, at order time, by cost-model.evaluateEdge.
//
// Pure and side-effect free so it can be unit-tested and reused by the scanner engine.

import { provisionalNetEdge } from "./cost-model.ts";

export interface ScalpMicro {
  samples: number;
  spread_bps: number | null;
  book_imbalance: number;        // > 0 => buy-side pressure
  imbalance_stability: number;   // 0..1, higher = steadier
  trade_pressure: number;        // > 0 => buys lifting offers
  live_book_age_ms: number | null;
  persistent_bid_wall: boolean;  // a resting support wall is present
  ask_absorption_score: number;  // higher = offers absorbing buys (bad)
  breakout_score: number;        // higher = clean upside break (good)
  dynamic_status: string;        // NEUTRAL / BREAKOUT_CONFIRMED / SPOOF_LIKE_RISK / ASK_ABSORPTION_RISK / SUPPORT_BREAKDOWN_RISK / INSUFFICIENT
}

export interface ScalpTrend {
  h4_trend_signal: number;   // strong-down veto axis
  composite_trend: number;   // weak-down penalty axis
}

export interface ScalpSignalConfig {
  minImbalance: number;      // buy-side pressure floor, e.g. 0.8
  minStability: number;      // e.g. 0.5
  maxSpreadBps: number;      // e.g. 8
  maxAskAbsorption: number;  // e.g. 0.5
  requireBidWall: boolean;   // require a resting support wall
  maxBookAgeMs: number;      // stale book => skip, e.g. 3000
  minSamples: number;        // e.g. 3
  strongDownVeto: number;    // h4 trend <= this => hard veto, e.g. -0.5
  weakDownThreshold: number; // composite <= this => penalty, e.g. -0.15
  weakDownPenalty: number;   // pWin multiplier when weak down, e.g. 0.85
  basePWin: number;          // baseline win prob, e.g. 0.5
  pWinFloor: number;         // clamp, e.g. 0.3
  pWinCeil: number;          // clamp, e.g. 0.85
  targetPct: number;         // scalp target width, e.g. 0.004
  stopPct: number;           // scalp stop width, e.g. 0.003
  roundTripFeeFraction: number; // e.g. 0.001
  minimumEdge: number;       // provisional edge floor, e.g. 0.0015
}

export const DEFAULT_SCALP_SIGNAL: ScalpSignalConfig = {
  minImbalance: 0.8,
  minStability: 0.5,
  maxSpreadBps: 8,
  maxAskAbsorption: 0.5,
  requireBidWall: true,
  maxBookAgeMs: 3000,
  minSamples: 3,
  strongDownVeto: -0.5,
  weakDownThreshold: -0.15,
  weakDownPenalty: 0.85,
  basePWin: 0.5,
  pWinFloor: 0.3,
  pWinCeil: 0.85,
  targetPct: 0.006,         // scalp target (R:R 2:1 vs stop). See note below.
  stopPct: 0.003,           // scalp stop
  roundTripFeeFraction: 0.001,
  minimumEdge: 0.0015,
  // NOTE on the fee math: with 0.1% round-trip fees and a 0.15% minimum edge, the
  // probability-weighted GROSS edge must exceed ~0.25%. A near-symmetric target/stop
  // (e.g. 0.4%/0.3%) needs pWin >= ~0.79 to clear that — unrealistic. A 2:1 target/stop
  // (0.6%/0.3%) only needs pWin >= ~0.61, which strong orderbook signals can reach.
  // This is the concrete form of "fees eat symmetric scalps": positive expectancy
  // requires favorable reward:risk, not just small quick profits. Tune to taste.
};

const BLOCKING_DYNAMIC = new Set([
  "SPOOF_LIKE_RISK",
  "ASK_ABSORPTION_RISK",
  "SUPPORT_BREAKDOWN_RISK",
  "INSUFFICIENT",
]);

// Stage 5: hard bounds for scalp tunables. Any override — operator, env, or a future
// self-correction pass — is clamped into these ranges. This is the "target/stop bounds"
// safety rail: learning can nudge parameters but can never push them into regimes where
// the fee math collapses or the stop becomes reckless.
export interface ScalpBounds { min: number; max: number }
export const SCALP_BOUNDS: Record<string, ScalpBounds> = {
  minImbalance: { min: 0.3, max: 5 },
  minStability: { min: 0.2, max: 0.95 },
  maxSpreadBps: { min: 2, max: 30 },
  maxAskAbsorption: { min: 0.1, max: 1 },
  strongDownVeto: { min: -1, max: -0.2 },
  weakDownThreshold: { min: -0.5, max: 0 },
  weakDownPenalty: { min: 0.5, max: 1 },
  basePWin: { min: 0.4, max: 0.6 },
  targetPct: { min: 0.003, max: 0.02 },   // 0.3%–2% target
  stopPct: { min: 0.002, max: 0.015 },     // 0.2%–1.5% stop
  minimumEdge: { min: 0.0010, max: 0.005 }, // 0.10%–0.50% edge floor
};

function clampBound(key: string, value: number, fallback: number): number {
  const b = SCALP_BOUNDS[key];
  if (!Number.isFinite(value)) return fallback;
  if (!b) return value;
  return Math.max(b.min, Math.min(b.max, value));
}

/**
 * Merge overrides onto the defaults, then clamp every bounded field. Callers should
 * ALWAYS build the runtime config through this — never pass raw overrides straight in.
 * Also enforces a structural invariant: target must exceed stop (positive reward:risk),
 * otherwise the strategy is negative-expectancy by construction.
 */
export function resolveScalpSignalConfig(overrides: Partial<ScalpSignalConfig> = {}): ScalpSignalConfig {
  const merged: ScalpSignalConfig = { ...DEFAULT_SCALP_SIGNAL, ...overrides };
  for (const key of Object.keys(SCALP_BOUNDS)) {
    (merged as any)[key] = clampBound(key, (merged as any)[key], (DEFAULT_SCALP_SIGNAL as any)[key]);
  }
  // Reward:risk invariant — target must be strictly greater than stop.
  if (merged.targetPct <= merged.stopPct) {
    merged.targetPct = clampBound("targetPct", merged.stopPct * 2, DEFAULT_SCALP_SIGNAL.targetPct);
  }
  return merged;
}


export interface ScalpSignalResult {
  decision: "BUY" | "WAIT" | "AVOID";
  vetoed: boolean;          // blocked by strong downtrend
  pWin: number;             // estimated win probability (post-penalty, clamped)
  signalScore: number;      // 0..1 strength of the orderbook signal
  provisionalEdge: number;  // prob-weighted gross minus fees
  targetPct: number;
  stopPct: number;
  reasons: string[];        // why it is not a BUY (for diagnostics)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Decide a scalp entry from live microstructure with trend as a veto.
 * Returns BUY only when the orderbook signal is clean, the trend does not veto,
 * and the fee-adjusted probability-weighted edge clears the minimum.
 */
export function evaluateScalpSignal(
  micro: ScalpMicro,
  trend: ScalpTrend,
  cfg: ScalpSignalConfig = DEFAULT_SCALP_SIGNAL,
): ScalpSignalResult {
  const reasons: string[] = [];

  // 1) Trend veto (strong downtrend hard-blocks).
  const vetoed = trend.h4_trend_signal <= cfg.strongDownVeto;
  if (vetoed) reasons.push("trend_strong_down_veto");

  // 2) Orderbook signal gates.
  if (micro.samples < cfg.minSamples) reasons.push("insufficient_samples");
  if (micro.live_book_age_ms !== null && micro.live_book_age_ms > cfg.maxBookAgeMs) reasons.push("stale_book");
  if (micro.spread_bps === null || micro.spread_bps > cfg.maxSpreadBps) reasons.push("spread_too_wide");
  if (micro.book_imbalance < cfg.minImbalance) reasons.push("weak_buy_imbalance");
  if (micro.imbalance_stability < cfg.minStability) reasons.push("unstable_imbalance");
  if (micro.ask_absorption_score > cfg.maxAskAbsorption) reasons.push("ask_absorption");
  if (cfg.requireBidWall && !micro.persistent_bid_wall) reasons.push("no_support_wall");
  if (BLOCKING_DYNAMIC.has(micro.dynamic_status)) reasons.push(`dynamic_${micro.dynamic_status.toLowerCase()}`);

  // 3) Win-probability estimate from signal strength.
  const imbalanceBonus = clamp((micro.book_imbalance - cfg.minImbalance) * 0.12, 0, 0.15);
  const stabilityBonus = clamp((micro.imbalance_stability - cfg.minStability) * 0.20, 0, 0.10);
  const breakoutBonus = clamp(micro.breakout_score * 0.10, 0, 0.10);
  let pWin = cfg.basePWin + imbalanceBonus + stabilityBonus + breakoutBonus;
  if (trend.composite_trend <= cfg.weakDownThreshold) pWin *= cfg.weakDownPenalty;
  pWin = clamp(pWin, cfg.pWinFloor, cfg.pWinCeil);

  const signalScore = clamp(
    0.4 * clamp(micro.book_imbalance / (cfg.minImbalance * 2), 0, 1) +
    0.3 * clamp(micro.imbalance_stability, 0, 1) +
    0.3 * clamp(micro.breakout_score, 0, 1),
    0, 1,
  );

  // 4) Provisional probability-weighted edge (fees only; slippage applied at order time).
  const provisionalEdge = provisionalNetEdge(pWin, cfg.targetPct, cfg.stopPct, cfg.roundTripFeeFraction);
  if (provisionalEdge < cfg.minimumEdge) reasons.push("edge_below_minimum");

  let decision: ScalpSignalResult["decision"];
  if (vetoed) {
    decision = "AVOID";
  } else if (reasons.length === 0) {
    decision = "BUY";
  } else {
    // AVOID only on genuine risk states (spoofing / ask absorption / support breakdown).
    // Everything else — thin edge, momentarily wide spread, weak imbalance, stale/thin
    // data — is a recoverable WAIT, not a reason to blacklist the market.
    const riskFlag = reasons.some((r) =>
      r === "dynamic_spoof_like_risk" ||
      r === "dynamic_ask_absorption_risk" ||
      r === "dynamic_support_breakdown_risk" ||
      r === "ask_absorption"
    );
    decision = riskFlag ? "AVOID" : "WAIT";
  }

  return { decision, vetoed, pWin, signalScore, provisionalEdge, targetPct: cfg.targetPct, stopPct: cfg.stopPct, reasons };
}
