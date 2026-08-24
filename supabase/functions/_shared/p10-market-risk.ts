export type P10MarketRiskSide = "LONG" | "SHORT";
export type P10MarketRiskRegime = "RISK_OFF" | "NEUTRAL" | "BULL" | "STRONG_BULL";
export type P10MarketRiskAction = "NONE" | "MARKET_RISK_PARTIAL" | "MARKET_RISK_EXIT";
export type P10MarketRiskStatus =
  | "DISABLED"
  | "STALE"
  | "HOLD"
  | "WATCH"
  | "DEFENSIVE"
  | "CRITICAL_FAST"
  | "CRITICAL_PERSIST"
  | "RECOVERED";

export const P10_MARKET_RISK_REVISION = "P10-MARKET-RISK-1.0.0";

export const P10_MARKET_RISK_CONFIG = Object.freeze({
  modelRevision: "MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET",
  source: "BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE",
  latestMaxAgeMs: 12 * 60_000,
  historyMaxAgeMs: 30 * 60_000,
  minimumGapMs: 2 * 60_000,
  maximumGapMs: 8 * 60_000,
  persistentWindowMs: 25 * 60_000,
  minimumSampleSize: 240,
  minimumConfidence: 0.60,
  extremeConfidence: 0.65,
  longAdverseBelow: 42,
  longExtremeAtOrBelow: 38,
  longRecoveryAtOrAbove: 46,
  shortAdverseAtOrAbove: 58,
  shortExtremeAtOrAbove: 62,
  shortRecoveryAtOrBelow: 54,
  partialConfirmations: 2,
  persistentConfirmations: 4,
  partialFraction: 0.50,
});

export interface P10MarketRiskObservation {
  id?: unknown;
  observation_bucket?: unknown;
  observed_at?: unknown;
  model_revision?: unknown;
  predicted_regime?: unknown;
  bull_score?: unknown;
  confidence?: unknown;
  sample_size?: unknown;
  trading_influence?: unknown;
  features?: unknown;
}

export interface P10MarketRiskAudit {
  checked_at: string;
  overlay_revision: string;
  model_revision: string;
  status: P10MarketRiskStatus;
  reason: string;
  confirmation_count: number;
  observation_ids: string[];
  latest: {
    id: string;
    observed_at: string;
    regime: P10MarketRiskRegime;
    bull_score: number;
    confidence: number;
    sample_size: number;
    phase: string | null;
  } | null;
  source_error: string | null;
}

export interface P10MarketRiskDecision {
  action: P10MarketRiskAction;
  reason: string;
  fraction: number;
  audit: P10MarketRiskAudit;
}

type NormalizedObservation = {
  id: string;
  observedAt: number;
  observedAtIso: string;
  regime: P10MarketRiskRegime;
  bullScore: number;
  confidence: number;
  sampleSize: number;
  features: Record<string, unknown>;
};

type BaseExitDecision = {
  action: string;
  reason: string | null;
  fraction: number;
  nextStop: number;
  policyBarTime: number;
};

const finite = (value: unknown, fallback = Number.NaN) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizeObservation(
  row: P10MarketRiskObservation,
  nowMs: number,
): NormalizedObservation | null {
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
  const regime = String(row.predicted_regime || "") as P10MarketRiskRegime;
  if (!Number.isFinite(observedAt) || observedAt > nowMs + 30_000) return null;
  if (nowMs - observedAt > P10_MARKET_RISK_CONFIG.historyMaxAgeMs) return null;
  if (!(bullScore >= 0 && bullScore <= 100)) return null;
  if (!(confidence >= 0 && confidence <= 1)) return null;
  if (!(sampleSize >= P10_MARKET_RISK_CONFIG.minimumSampleSize)) return null;
  if (!["RISK_OFF", "NEUTRAL", "BULL", "STRONG_BULL"].includes(regime)) return null;
  return {
    id: String(row.id || row.observation_bucket || row.observed_at || observedAt),
    observedAt,
    observedAtIso: new Date(observedAt).toISOString(),
    regime,
    bullScore,
    confidence,
    sampleSize,
    features,
  };
}

function normalizeObservations(
  rows: readonly P10MarketRiskObservation[],
  nowMs: number,
): NormalizedObservation[] {
  const seen = new Set<string>();
  return rows
    .map((row) => normalizeObservation(row, nowMs))
    .filter((row): row is NormalizedObservation => Boolean(row))
    .sort((left, right) => right.observedAt - left.observedAt)
    .filter((row) => {
      const key = `${row.id}:${row.observedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isAdverse(row: NormalizedObservation, side: P10MarketRiskSide) {
  if (row.confidence < P10_MARKET_RISK_CONFIG.minimumConfidence) return false;
  return side === "LONG"
    ? row.regime === "RISK_OFF" && row.bullScore < P10_MARKET_RISK_CONFIG.longAdverseBelow
    : (row.regime === "BULL" || row.regime === "STRONG_BULL") &&
      row.bullScore >= P10_MARKET_RISK_CONFIG.shortAdverseAtOrAbove;
}

function isExtreme(row: NormalizedObservation, side: P10MarketRiskSide) {
  if (row.confidence < P10_MARKET_RISK_CONFIG.extremeConfidence) return false;
  return side === "LONG"
    ? row.bullScore <= P10_MARKET_RISK_CONFIG.longExtremeAtOrBelow
    : row.bullScore >= P10_MARKET_RISK_CONFIG.shortExtremeAtOrAbove;
}

function isRecovered(row: NormalizedObservation, side: P10MarketRiskSide) {
  return side === "LONG"
    ? row.bullScore >= P10_MARKET_RISK_CONFIG.longRecoveryAtOrAbove
    : row.bullScore <= P10_MARKET_RISK_CONFIG.shortRecoveryAtOrBelow;
}

function contiguousCount(
  rows: readonly NormalizedObservation[],
  predicate: (row: NormalizedObservation) => boolean,
) {
  let count = 0;
  for (let index = 0; index < rows.length; index++) {
    if (!predicate(rows[index])) break;
    if (index > 0) {
      const gap = rows[index - 1].observedAt - rows[index].observedAt;
      if (
        gap < P10_MARKET_RISK_CONFIG.minimumGapMs ||
        gap > P10_MARKET_RISK_CONFIG.maximumGapMs
      ) break;
    }
    count++;
  }
  return count;
}

function forecastRows(row: NormalizedObservation): Record<string, unknown>[] {
  const conditional = record(row.features.conditional_forecast);
  const phase = record(row.features.momentum_phase);
  const phaseForecast = record(phase.forecast);
  const raw = Array.isArray(conditional.horizons)
    ? conditional.horizons
    : Array.isArray(phaseForecast.horizons)
    ? phaseForecast.horizons
    : [];
  return raw.map(record);
}

function hasConfirmedLongHorizonAdverse(
  row: NormalizedObservation,
  side: P10MarketRiskSide,
) {
  const direction = side === "LONG" ? "DOWN" : "UP";
  return forecastRows(row).some((forecast) => {
    const horizon = finite(forecast.horizon_minutes);
    const confidence = String(forecast.confidence || "").toUpperCase();
    const probability = finite(forecast.probability);
    return (horizon === 120 || horizon === 360) &&
      String(forecast.direction || "").toUpperCase() === direction &&
      (confidence === "MEDIUM" || confidence === "HIGH") &&
      probability >= 0.55;
  });
}

function makeDecision(
  action: P10MarketRiskAction,
  reason: string,
  fraction: number,
  status: P10MarketRiskStatus,
  confirmationCount: number,
  rows: readonly NormalizedObservation[],
  nowMs: number,
  sourceError: string | null,
): P10MarketRiskDecision {
  const latest = rows[0] || null;
  const phase = latest ? record(latest.features.momentum_phase) : {};
  return {
    action,
    reason,
    fraction,
    audit: {
      checked_at: new Date(nowMs).toISOString(),
      overlay_revision: P10_MARKET_RISK_REVISION,
      model_revision: P10_MARKET_RISK_CONFIG.modelRevision,
      status,
      reason,
      confirmation_count: confirmationCount,
      observation_ids: rows.slice(0, Math.max(1, confirmationCount)).map((row) => row.id),
      latest: latest
        ? {
          id: latest.id,
          observed_at: latest.observedAtIso,
          regime: latest.regime,
          bull_score: latest.bullScore,
          confidence: latest.confidence,
          sample_size: latest.sampleSize,
          phase: typeof phase.phase === "string" ? phase.phase : null,
        }
        : null,
      source_error: sourceError ? sourceError.slice(0, 240) : null,
    },
  };
}

export function evaluateP10MarketRisk(input: {
  side: P10MarketRiskSide;
  observations: readonly P10MarketRiskObservation[];
  nowMs: number;
  partialAlreadyDone: boolean;
  sourceError?: string | null;
}): P10MarketRiskDecision {
  const sourceError = input.sourceError ? String(input.sourceError) : null;
  const rows = normalizeObservations(input.observations || [], input.nowMs);
  if (!rows.length) {
    return makeDecision(
      "NONE",
      sourceError ? "MARKET_RISK_SOURCE_ERROR" : "MARKET_RISK_UNAVAILABLE",
      0,
      "DISABLED",
      0,
      rows,
      input.nowMs,
      sourceError,
    );
  }
  if (input.nowMs - rows[0].observedAt > P10_MARKET_RISK_CONFIG.latestMaxAgeMs) {
    return makeDecision(
      "NONE",
      "MARKET_RISK_STALE",
      0,
      "STALE",
      0,
      rows,
      input.nowMs,
      sourceError,
    );
  }

  const confirmationCount = contiguousCount(
    rows,
    (row) => isAdverse(row, input.side),
  );
  if (!confirmationCount) {
    const recoveryCount = contiguousCount(rows, (row) => isRecovered(row, input.side));
    const recovered = input.partialAlreadyDone && recoveryCount >= 2;
    return makeDecision(
      "NONE",
      recovered ? "MARKET_RISK_RECOVERED" : "MARKET_RISK_HOLD",
      0,
      recovered ? "RECOVERED" : "HOLD",
      0,
      rows,
      input.nowMs,
      sourceError,
    );
  }

  if (confirmationCount === 1) {
    return makeDecision(
      "NONE",
      "MARKET_RISK_WATCH_1",
      0,
      "WATCH",
      confirmationCount,
      rows,
      input.nowMs,
      sourceError,
    );
  }

  const extremePair = rows.slice(0, 2).every((row) =>
    isAdverse(row, input.side) && isExtreme(row, input.side)
  );
  if (extremePair && hasConfirmedLongHorizonAdverse(rows[0], input.side)) {
    return makeDecision(
      "MARKET_RISK_EXIT",
      "MARKET_RISK_CRITICAL_FAST",
      1,
      "CRITICAL_FAST",
      confirmationCount,
      rows,
      input.nowMs,
      sourceError,
    );
  }

  const persistentRows = rows.slice(0, P10_MARKET_RISK_CONFIG.persistentConfirmations);
  const persistentWindow = persistentRows.length >= P10_MARKET_RISK_CONFIG.persistentConfirmations
    ? persistentRows[0].observedAt - persistentRows.at(-1)!.observedAt
    : Number.POSITIVE_INFINITY;
  if (
    confirmationCount >= P10_MARKET_RISK_CONFIG.persistentConfirmations &&
    persistentWindow <= P10_MARKET_RISK_CONFIG.persistentWindowMs
  ) {
    return makeDecision(
      "MARKET_RISK_EXIT",
      "MARKET_RISK_CRITICAL_PERSIST",
      1,
      "CRITICAL_PERSIST",
      confirmationCount,
      rows,
      input.nowMs,
      sourceError,
    );
  }

  if (input.partialAlreadyDone) {
    return makeDecision(
      "NONE",
      "MARKET_RISK_DEFENSIVE_ALREADY_REDUCED",
      0,
      "DEFENSIVE",
      confirmationCount,
      rows,
      input.nowMs,
      sourceError,
    );
  }
  return makeDecision(
    "MARKET_RISK_PARTIAL",
    "MARKET_RISK_DEFENSIVE_2_CONFIRMATIONS",
    P10_MARKET_RISK_CONFIG.partialFraction,
    "DEFENSIVE",
    confirmationCount,
    rows,
    input.nowMs,
    sourceError,
  );
}

export function applyP10MarketRiskOverlay<T extends BaseExitDecision>(
  base: T,
  marketRisk: P10MarketRiskDecision,
):
  | T
  | (Omit<T, "action" | "reason" | "fraction"> & {
    action: P10MarketRiskAction;
    reason: string;
    fraction: number;
  }) {
  if (base.action !== "NONE" || marketRisk.action === "NONE") return base;
  return {
    ...base,
    action: marketRisk.action,
    reason: marketRisk.reason,
    fraction: marketRisk.fraction,
  };
}

export function p10RequestedExitQuantity(input: {
  action: string;
  initialQuantity: number;
  remainingQuantity: number;
  fraction: number;
}) {
  const initial = Math.max(0, finite(input.initialQuantity, 0));
  const remaining = Math.max(0, finite(input.remainingQuantity, 0));
  const fraction = Math.max(0, Math.min(1, finite(input.fraction, 0)));
  if (input.action === "TARGET_1") return Math.min(remaining, initial * fraction);
  if (input.action === "MARKET_RISK_PARTIAL") return remaining * fraction;
  return remaining;
}
