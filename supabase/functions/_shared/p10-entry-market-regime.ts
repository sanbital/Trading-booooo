import {
  P10_MARKET_RISK_CONFIG,
  type P10MarketRiskObservation,
} from "./p10-market-risk.ts";
import type { P10Side } from "./p10-policy.ts";

export const P10_ENTRY_REGIME_REVISION = "P10-ENTRY-REGIME-1.0.0-SHADOW";

export type P10EntryRegimeVerdict = "ALLOW" | "BLOCK" | "UNAVAILABLE";

type Forecast = {
  horizonMinutes: number;
  direction: string;
  probability: number;
  confidence: string;
};

type ValidObservation = {
  id: string;
  observedAt: number;
  observedAtIso: string;
  regime: string;
  bullScore: number;
  confidence: number;
  sampleSize: number;
  phase: string;
  forecasts: Forecast[];
};

export interface P10EntryRegimeDecision {
  verdict: P10EntryRegimeVerdict;
  reason: string;
  audit: {
    revision: string;
    checked_at: string;
    mode: "SHADOW";
    side: P10Side;
    source_error: string | null;
    latest: {
      id: string;
      observed_at: string;
      regime: string;
      bull_score: number;
      confidence: number;
      sample_size: number;
      phase: string;
      horizons: Forecast[];
    } | null;
  };
}

const finite = (value: unknown, fallback = Number.NaN) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function forecastsOf(features: Record<string, unknown>): Forecast[] {
  const conditional = record(features.conditional_forecast);
  const momentum = record(features.momentum_phase);
  const phaseForecast = record(momentum.forecast);
  const rows = Array.isArray(conditional.horizons)
    ? conditional.horizons
    : Array.isArray(phaseForecast.horizons)
    ? phaseForecast.horizons
    : [];
  return rows.map((value) => {
    const row = record(value);
    return {
      horizonMinutes: finite(row.horizon_minutes, 0),
      direction: String(row.direction || "").toUpperCase(),
      probability: finite(row.probability, 0),
      confidence: String(row.confidence || "").toUpperCase(),
    };
  }).filter((row) => row.horizonMinutes > 0);
}

function validObservation(
  row: P10MarketRiskObservation,
  nowMs: number,
): ValidObservation | null {
  if (row.trading_influence !== true) return null;
  if (row.model_revision !== P10_MARKET_RISK_CONFIG.modelRevision) return null;
  const features = record(row.features);
  if (features.source !== P10_MARKET_RISK_CONFIG.source) return null;

  const breadth30 = record(features.breadth_30m);
  const spotBreadth = record(breadth30.binance_spot);
  const futuresBreadth = record(breadth30.binance_futures);
  const upbitBreadth = record(breadth30.upbit_spot);
  if (
    finite(spotBreadth.sample_size, 0) < 80 ||
    finite(futuresBreadth.sample_size, 0) < 80 ||
    finite(upbitBreadth.sample_size, 0) < 40
  ) return null;

  const observedAt = Date.parse(String(row.observed_at || ""));
  const bullScore = finite(row.bull_score);
  const confidence = finite(row.confidence);
  const sampleSize = finite(row.sample_size);
  const regime = String(row.predicted_regime || "").toUpperCase();
  if (!Number.isFinite(observedAt) || observedAt > nowMs + 30_000) return null;
  if (nowMs - observedAt > P10_MARKET_RISK_CONFIG.latestMaxAgeMs) return null;
  if (!(bullScore >= 0 && bullScore <= 100)) return null;
  if (confidence < P10_MARKET_RISK_CONFIG.minimumConfidence || confidence > 1) return null;
  if (sampleSize < P10_MARKET_RISK_CONFIG.minimumSampleSize) return null;
  if (!["RISK_OFF", "NEUTRAL", "BULL", "STRONG_BULL"].includes(regime)) return null;

  const momentum = record(features.momentum_phase);
  return {
    id: String(row.id || row.observation_bucket || row.observed_at || observedAt),
    observedAt,
    observedAtIso: new Date(observedAt).toISOString(),
    regime,
    bullScore,
    confidence,
    sampleSize,
    phase: String(momentum.phase || "UNKNOWN").toUpperCase(),
    forecasts: forecastsOf(features),
  };
}

function horizon(row: ValidObservation, minutes: number): Forecast | null {
  return row.forecasts.find((forecast) => forecast.horizonMinutes === minutes) || null;
}

function forecastConfirmed(
  forecast: Forecast | null,
  direction: "UP" | "DOWN",
  minimumProbability = 0.55,
) {
  if (!forecast) return false;
  return forecast.direction === direction &&
    (forecast.confidence === "MEDIUM" || forecast.confidence === "HIGH") &&
    forecast.probability >= minimumProbability;
}

function shortReboundPhase(phase: string) {
  return phase.includes("REBOUND") ||
    phase.includes("RECOVERY") ||
    phase === "IMPULSE_CONTINUATION";
}

function decision(
  side: P10Side,
  verdict: P10EntryRegimeVerdict,
  reason: string,
  latest: ValidObservation | null,
  nowMs: number,
  sourceError: string | null,
): P10EntryRegimeDecision {
  return {
    verdict,
    reason,
    audit: {
      revision: P10_ENTRY_REGIME_REVISION,
      checked_at: new Date(nowMs).toISOString(),
      mode: "SHADOW",
      side,
      source_error: sourceError,
      latest: latest
        ? {
          id: latest.id,
          observed_at: latest.observedAtIso,
          regime: latest.regime,
          bull_score: latest.bullScore,
          confidence: latest.confidence,
          sample_size: latest.sampleSize,
          phase: latest.phase,
          horizons: latest.forecasts,
        }
        : null,
    },
  };
}

/**
 * Shadow-only P10 entry regime evaluator.
 *
 * Evidence from actual P10 trades since the live cutover is deliberately encoded
 * asymmetrically:
 * - LONG keeps the empirically strong BULL / STRONG_BULL lane unchanged.
 * - LONG in NEUTRAL / RISK_OFF is marked BLOCK for shadow comparison.
 * - SHORT never treats RISK_OFF alone as permission. Tactical rebound phases are vetoed,
 *   and both 2h and 6h horizons must confirm downside persistence before shadow ALLOW.
 *
 * This function has no exchange/database side effects and cannot block an order by itself.
 */
export function evaluateP10EntryRegime(input: {
  side: P10Side;
  observations: readonly P10MarketRiskObservation[];
  nowMs: number;
  sourceError?: string | null;
}): P10EntryRegimeDecision {
  const sourceError = input.sourceError ? String(input.sourceError).slice(0, 240) : null;
  const latest = (input.observations || [])
    .map((row) => validObservation(row, input.nowMs))
    .filter((row): row is ValidObservation => Boolean(row))
    .sort((left, right) => right.observedAt - left.observedAt)[0] || null;

  if (!latest) {
    return decision(
      input.side,
      "UNAVAILABLE",
      sourceError ? "ENTRY_REGIME_SOURCE_ERROR" : "ENTRY_REGIME_UNAVAILABLE",
      null,
      input.nowMs,
      sourceError,
    );
  }

  if (input.side === "LONG") {
    if (latest.regime === "BULL" || latest.regime === "STRONG_BULL") {
      return decision(
        input.side,
        "ALLOW",
        "LONG_BULL_EDGE_PRESERVED",
        latest,
        input.nowMs,
        sourceError,
      );
    }
    return decision(
      input.side,
      "BLOCK",
      latest.regime === "RISK_OFF" ? "LONG_RISK_OFF_BLOCK" : "LONG_NEUTRAL_BLOCK",
      latest,
      input.nowMs,
      sourceError,
    );
  }

  if (latest.regime === "BULL" || latest.regime === "STRONG_BULL") {
    return decision(
      input.side,
      "BLOCK",
      "SHORT_BULL_REGIME_BLOCK",
      latest,
      input.nowMs,
      sourceError,
    );
  }

  if (shortReboundPhase(latest.phase)) {
    return decision(
      input.side,
      "BLOCK",
      "SHORT_TACTICAL_REBOUND_BLOCK",
      latest,
      input.nowMs,
      sourceError,
    );
  }

  const h30 = horizon(latest, 30);
  const h120 = horizon(latest, 120);
  const h360 = horizon(latest, 360);
  if (forecastConfirmed(h30, "UP", 0.58)) {
    return decision(
      input.side,
      "BLOCK",
      "SHORT_30M_REBOUND_RISK_BLOCK",
      latest,
      input.nowMs,
      sourceError,
    );
  }

  if (!(forecastConfirmed(h120, "DOWN") && forecastConfirmed(h360, "DOWN"))) {
    return decision(
      input.side,
      "BLOCK",
      "SHORT_DOWNSIDE_PERSISTENCE_NOT_CONFIRMED",
      latest,
      input.nowMs,
      sourceError,
    );
  }

  return decision(
    input.side,
    "ALLOW",
    latest.regime === "RISK_OFF"
      ? "SHORT_RISK_OFF_DOWNSIDE_CONFIRMED"
      : "SHORT_NEUTRAL_DOWNSIDE_CONFIRMED",
    latest,
    input.nowMs,
    sourceError,
  );
}
