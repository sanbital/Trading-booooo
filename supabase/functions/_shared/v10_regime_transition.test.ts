import { buildV10RegimeSnapshot, evaluateV10RegimeTransition } from "./v10_regime_transition.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const BASE = Date.parse("2026-09-01T06:00:00Z");
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    observed_at: new Date(BASE - 60_000).toISOString(),
    model_revision: "MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET",
    predicted_regime: "RISK_OFF",
    bull_score: 41,
    confidence: 0.66,
    sample_size: 300,
    trading_influence: true,
    features: {
      source: "BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE",
      breadth_30m: {
        binance_spot: { sample_size: 100 },
        binance_futures: { sample_size: 100 },
        upbit_spot: { sample_size: 50 },
      },
      conditional_forecast: { horizons: [] },
    },
    ...overrides,
  };
}

Deno.test("UNKNOWN blocks entry but does not force exit", () => {
  const snapshot = buildV10RegimeSnapshot([], BASE);
  assert(snapshot.signal === "UNKNOWN", "expected UNKNOWN");
  assert(snapshot.blockNewEntries, "UNKNOWN must block entries");
  const directive = evaluateV10RegimeTransition({
    lane: "RANGE",
    completedBarOpenMs: BASE - 900_000,
    snapshot,
  });
  assert(!directive.forceFullExit, "UNKNOWN must not force-close a held position");
});

Deno.test("BEAR_REBREAK requires two distinct consecutive 15m bars", () => {
  const snapshot = buildV10RegimeSnapshot([row()], BASE);
  assert(snapshot.signal === "BEAR_REBREAK", "expected BEAR_REBREAK");
  assert(!snapshot.strong, "ordinary risk-off must not be strong");
  const first = evaluateV10RegimeTransition({
    lane: "RANGE",
    completedBarOpenMs: BASE - 900_000,
    snapshot,
  });
  assert(
    !first.forceFullExit && first.nextState.consecutiveDangerCount === 1,
    "first bar is watch",
  );
  const duplicate = evaluateV10RegimeTransition({
    lane: "RANGE",
    previousState: first.nextState,
    completedBarOpenMs: BASE - 900_000,
    snapshot,
  });
  assert(
    !duplicate.forceFullExit && duplicate.nextState.consecutiveDangerCount === 1,
    "same bar cannot double count",
  );
  const second = evaluateV10RegimeTransition({
    lane: "RANGE",
    previousState: first.nextState,
    completedBarOpenMs: BASE,
    snapshot,
  });
  assert(
    second.forceFullExit && second.nextState.consecutiveDangerCount === 2,
    "second consecutive bar exits",
  );
});

Deno.test("strong single BEAR_REBREAK exits immediately", () => {
  const strongRow = row({
    bull_score: 37,
    confidence: 0.72,
    features: {
      source: "BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE",
      breadth_30m: {
        binance_spot: { sample_size: 100 },
        binance_futures: { sample_size: 100 },
        upbit_spot: { sample_size: 50 },
      },
      conditional_forecast: {
        horizons: [
          { horizon_minutes: 120, direction: "DOWN", confidence: "HIGH", probability: 0.70 },
        ],
      },
    },
  });
  const snapshot = buildV10RegimeSnapshot([strongRow], BASE);
  assert(snapshot.strong, "expected strong transition");
  const directive = evaluateV10RegimeTransition({
    lane: "BULL",
    completedBarOpenMs: BASE - 900_000,
    snapshot,
  });
  assert(directive.forceFullExit, "strong single transition must exit");
});

Deno.test("BULL_DECELERATING exits BULL only after two bars", () => {
  const decel = row({
    predicted_regime: "BULL",
    bull_score: 57,
    confidence: 0.68,
    features: {
      source: "BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE",
      breadth_30m: {
        binance_spot: { sample_size: 100 },
        binance_futures: { sample_size: 100 },
        upbit_spot: { sample_size: 50 },
      },
      conditional_forecast: {
        horizons: [
          { horizon_minutes: 360, direction: "DOWN", confidence: "MEDIUM", probability: 0.60 },
        ],
      },
    },
  });
  const snapshot = buildV10RegimeSnapshot([decel], BASE);
  assert(snapshot.signal === "BULL_DECELERATING", "expected decelerating");
  const first = evaluateV10RegimeTransition({
    lane: "BULL",
    completedBarOpenMs: BASE - 900_000,
    snapshot,
  });
  const second = evaluateV10RegimeTransition({
    lane: "BULL",
    previousState: first.nextState,
    completedBarOpenMs: BASE,
    snapshot,
  });
  assert(!first.forceFullExit && second.forceFullExit, "BULL deceleration needs two bars");
  const rangeLane = evaluateV10RegimeTransition({
    lane: "RANGE",
    completedBarOpenMs: BASE - 900_000,
    snapshot,
  });
  assert(!rangeLane.forceFullExit, "BULL deceleration must not force RANGE exit");
});

Deno.test("future observer row is never used for an earlier completed bar", () => {
  const future = row({ observed_at: new Date(BASE + 1).toISOString() });
  const snapshot = buildV10RegimeSnapshot([future], BASE);
  assert(snapshot.signal === "UNKNOWN", "future data must be rejected");
});
