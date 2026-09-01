import { P10_MARKET_RISK_CONFIG } from "./p10-market-risk.ts";
import { V10_EXIT_BAR_INTERVAL_MS, type V10Lane } from "./v10_lane_exit_config.ts";

export const V10_REGIME_TRANSITION_REVISION = "V10-REGIME-TRANSITION-EXIT-1.0.0";
// One-way risk reduction switch only. It does not enable entries or any lane.
export const V10_REGIME_TRANSITION_LIVE_EXIT_COMPILED = true;

export type V10RegimeSignal =
  | "BULL_TREND"
  | "BULL_DECELERATING"
  | "RANGE"
  | "BEAR_REBREAK"
  | "UNKNOWN";

export interface V10RegimeSnapshot {
  signal: V10RegimeSignal;
  valid: boolean;
  strong: boolean;
  blockNewEntries: boolean;
  observationId: string | null;
  observedAt: string | null;
  confidence: number | null;
  bullScore: number | null;
  reason: string;
}

export interface V10RegimeTransitionState {
  lastCompletedBarOpenMs: number | null;
  lastSignal: V10RegimeSignal;
  consecutiveDangerCount: number;
}

export interface V10RegimeTransitionDirective {
  forceFullExit: boolean;
  blockNewEntries: boolean;
  nextState: V10RegimeTransitionState;
  reason: string;
  diagnostics: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function finite(value: unknown, fallback = Number.NaN): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function forecastRows(features: Row): Row[] {
  const conditional = record(features.conditional_forecast);
  const phase = record(features.momentum_phase);
  const phaseForecast = record(phase.forecast);
  const raw = Array.isArray(conditional.horizons)
    ? conditional.horizons
    : Array.isArray(phaseForecast.horizons)
    ? phaseForecast.horizons
    : [];
  return raw.map(record);
}

function hasLongHorizonDown(features: Row): boolean {
  return forecastRows(features).some((forecast) => {
    const horizon = finite(forecast.horizon_minutes);
    const confidence = String(forecast.confidence || "").toUpperCase();
    const probability = finite(forecast.probability);
    return (horizon === 120 || horizon === 360) &&
      String(forecast.direction || "").toUpperCase() === "DOWN" &&
      (confidence === "MEDIUM" || confidence === "HIGH") &&
      probability >= 0.55;
  });
}

function normalizedObservation(rows: readonly Row[], atMs: number): {
  row: Row;
  observedAtMs: number;
  regime: string;
  bullScore: number;
  confidence: number;
  features: Row;
} | null {
  const ordered = [...rows].sort((a, b) =>
    Date.parse(String(b.observed_at || "")) - Date.parse(String(a.observed_at || ""))
  );
  for (const row of ordered) {
    if (row.trading_influence !== true) continue;
    if (row.model_revision !== P10_MARKET_RISK_CONFIG.modelRevision) continue;
    const observedAtMs = Date.parse(String(row.observed_at || ""));
    if (!Number.isFinite(observedAtMs) || observedAtMs > atMs) continue;
    if (atMs - observedAtMs > P10_MARKET_RISK_CONFIG.latestMaxAgeMs) continue;
    const features = record(row.features);
    if (features.source !== P10_MARKET_RISK_CONFIG.source) continue;
    const breadth30 = record(features.breadth_30m);
    const spot = record(breadth30.binance_spot);
    const futures = record(breadth30.binance_futures);
    const upbit = record(breadth30.upbit_spot);
    if (
      finite(spot.sample_size, 0) < 80 ||
      finite(futures.sample_size, 0) < 80 ||
      finite(upbit.sample_size, 0) < 40
    ) continue;
    const bullScore = finite(row.bull_score);
    const confidence = finite(row.confidence);
    const sampleSize = finite(row.sample_size, 0);
    const regime = String(row.predicted_regime || "").toUpperCase();
    if (!(bullScore >= 0 && bullScore <= 100)) continue;
    if (!(confidence >= P10_MARKET_RISK_CONFIG.minimumConfidence && confidence <= 1)) continue;
    if (sampleSize < P10_MARKET_RISK_CONFIG.minimumSampleSize) continue;
    if (!["RISK_OFF", "NEUTRAL", "BULL", "STRONG_BULL"].includes(regime)) continue;
    return { row, observedAtMs, regime, bullScore, confidence, features };
  }
  return null;
}

export function buildV10RegimeSnapshot(
  rows: readonly Row[],
  completedAtMs: number,
  sourceError: string | null = null,
): V10RegimeSnapshot {
  if (sourceError) {
    return {
      signal: "UNKNOWN",
      valid: false,
      strong: false,
      blockNewEntries: true,
      observationId: null,
      observedAt: null,
      confidence: null,
      bullScore: null,
      reason: `REGIME_SOURCE_ERROR:${sourceError}`,
    };
  }
  const normalized = normalizedObservation(rows, completedAtMs);
  if (!normalized) {
    return {
      signal: "UNKNOWN",
      valid: false,
      strong: false,
      blockNewEntries: true,
      observationId: null,
      observedAt: null,
      confidence: null,
      bullScore: null,
      reason: "REGIME_OBSERVATION_INVALID_OR_STALE",
    };
  }
  const adverseForecast = hasLongHorizonDown(normalized.features);
  let signal: V10RegimeSignal;
  if (normalized.regime === "RISK_OFF") signal = "BEAR_REBREAK";
  else if (normalized.regime === "NEUTRAL") signal = "RANGE";
  else signal = adverseForecast ? "BULL_DECELERATING" : "BULL_TREND";
  const strong = signal === "BEAR_REBREAK" && (
    (normalized.bullScore <= P10_MARKET_RISK_CONFIG.longExtremeAtOrBelow &&
      normalized.confidence >= P10_MARKET_RISK_CONFIG.extremeConfidence) ||
    (normalized.confidence >= P10_MARKET_RISK_CONFIG.transitionFastConfidence && adverseForecast)
  );
  return {
    signal,
    valid: true,
    strong,
    blockNewEntries: false,
    observationId: String(
      normalized.row.id || normalized.row.observation_bucket || normalized.row.observed_at || "",
    ) || null,
    observedAt: new Date(normalized.observedAtMs).toISOString(),
    confidence: normalized.confidence,
    bullScore: normalized.bullScore,
    reason: `REGIME_${signal}${strong ? "_STRONG" : ""}`,
  };
}

function initialState(): V10RegimeTransitionState {
  return { lastCompletedBarOpenMs: null, lastSignal: "UNKNOWN", consecutiveDangerCount: 0 };
}

function normalizeState(value: unknown): V10RegimeTransitionState {
  const row = record(value);
  const last = finite(row.lastCompletedBarOpenMs, Number.NaN);
  const signal = String(row.lastSignal || "UNKNOWN") as V10RegimeSignal;
  const count = Math.max(0, Math.floor(finite(row.consecutiveDangerCount, 0)));
  return {
    lastCompletedBarOpenMs: Number.isFinite(last) ? last : null,
    lastSignal:
      ["BULL_TREND", "BULL_DECELERATING", "RANGE", "BEAR_REBREAK", "UNKNOWN"].includes(signal)
        ? signal
        : "UNKNOWN",
    consecutiveDangerCount: count,
  };
}

function dangerousForLane(lane: V10Lane, signal: V10RegimeSignal): boolean {
  if (signal === "BEAR_REBREAK") return true;
  return lane === "BULL" && signal === "BULL_DECELERATING";
}

export function evaluateV10RegimeTransition(input: {
  lane: V10Lane;
  previousState?: unknown;
  completedBarOpenMs: number;
  snapshot: V10RegimeSnapshot;
}): V10RegimeTransitionDirective {
  const previous = input.previousState === undefined
    ? initialState()
    : normalizeState(input.previousState);
  if (
    previous.lastCompletedBarOpenMs !== null &&
    input.completedBarOpenMs <= previous.lastCompletedBarOpenMs
  ) {
    return {
      forceFullExit: false,
      blockNewEntries: input.snapshot.blockNewEntries,
      nextState: previous,
      reason: "REGIME_DUPLICATE_OR_STALE_BAR",
      diagnostics: { snapshot: input.snapshot, transitionRevision: V10_REGIME_TRANSITION_REVISION },
    };
  }
  if (!input.snapshot.valid || input.snapshot.signal === "UNKNOWN") {
    const nextState = {
      lastCompletedBarOpenMs: input.completedBarOpenMs,
      lastSignal: "UNKNOWN" as const,
      consecutiveDangerCount: 0,
    };
    return {
      forceFullExit: false,
      blockNewEntries: true,
      nextState,
      reason: "REGIME_UNKNOWN_ENTRY_BLOCK_ONLY",
      diagnostics: { snapshot: input.snapshot, transitionRevision: V10_REGIME_TRANSITION_REVISION },
    };
  }
  const dangerous = dangerousForLane(input.lane, input.snapshot.signal);
  const consecutiveBar = previous.lastCompletedBarOpenMs !== null &&
    input.completedBarOpenMs - previous.lastCompletedBarOpenMs === V10_EXIT_BAR_INTERVAL_MS;
  const count = dangerous
    ? (consecutiveBar && previous.consecutiveDangerCount > 0
      ? previous.consecutiveDangerCount + 1
      : 1)
    : 0;
  const forceFullExit = dangerous && (input.snapshot.strong || count >= 2);
  const nextState = {
    lastCompletedBarOpenMs: input.completedBarOpenMs,
    lastSignal: input.snapshot.signal,
    consecutiveDangerCount: count,
  };
  return {
    forceFullExit,
    blockNewEntries: input.snapshot.blockNewEntries,
    nextState,
    reason: forceFullExit
      ? `REGIME_TRANSITION_EXIT_${input.lane}_${input.snapshot.signal}`
      : dangerous
      ? `REGIME_TRANSITION_WATCH_${input.lane}_${input.snapshot.signal}_${count}`
      : `REGIME_TRANSITION_HOLD_${input.lane}_${input.snapshot.signal}`,
    diagnostics: {
      snapshot: input.snapshot,
      consecutiveDangerCount: count,
      transitionRevision: V10_REGIME_TRANSITION_REVISION,
    },
  };
}
