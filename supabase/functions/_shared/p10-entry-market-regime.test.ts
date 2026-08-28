import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateP10EntryRegime, P10_ENTRY_REGIME_REVISION } from "./p10-entry-market-regime.ts";
import { P10_MARKET_RISK_CONFIG, type P10MarketRiskObservation } from "./p10-market-risk.ts";

const NOW = Date.parse("2026-08-28T09:31:30.669Z");

type HorizonInput = {
  minutes: number;
  direction: "UP" | "DOWN" | "NO_EDGE";
  probability: number;
  confidence?: "LOW" | "MEDIUM" | "HIGH";
};

function observation(input: {
  minutesAgo?: number;
  regime?: "RISK_OFF" | "NEUTRAL" | "BULL" | "STRONG_BULL";
  score?: number;
  confidence?: number;
  influence?: boolean;
  phase?: string;
  horizons?: HorizonInput[];
} = {}): P10MarketRiskObservation {
  const observedAt = new Date(NOW - (input.minutesAgo ?? 1) * 60_000).toISOString();
  return {
    id: `obs-${input.regime || "NEUTRAL"}-${input.minutesAgo ?? 1}`,
    observation_bucket: observedAt,
    observed_at: observedAt,
    model_revision: P10_MARKET_RISK_CONFIG.modelRevision,
    predicted_regime: input.regime || "NEUTRAL",
    bull_score: input.score ?? 45,
    confidence: input.confidence ?? 0.66,
    sample_size: 1297,
    trading_influence: input.influence ?? true,
    features: {
      source: P10_MARKET_RISK_CONFIG.source,
      breadth_30m: {
        binance_spot: { sample_size: 485 },
        binance_futures: { sample_size: 524 },
        upbit_spot: { sample_size: 288 },
      },
      momentum_phase: { phase: input.phase || "ROLLING_OVER" },
      conditional_forecast: {
        horizons: (input.horizons || [
          { minutes: 30, direction: "DOWN", probability: 0.56 },
          { minutes: 120, direction: "DOWN", probability: 0.62 },
          { minutes: 360, direction: "DOWN", probability: 0.61 },
        ]).map((row) => ({
          horizon_minutes: row.minutes,
          direction: row.direction,
          probability: row.probability,
          confidence: row.confidence || "MEDIUM",
        })),
      },
    },
  };
}

Deno.test("P10 entry regime shadow preserves BULL and STRONG_BULL LONG edge", () => {
  for (const regime of ["BULL", "STRONG_BULL"] as const) {
    const result = evaluateP10EntryRegime({
      side: "LONG",
      observations: [observation({ regime, score: regime === "BULL" ? 64 : 78 })],
      nowMs: NOW,
    });
    assertEquals(result.verdict, "ALLOW");
    assertEquals(result.reason, "LONG_BULL_EDGE_PRESERVED");
    assertEquals(result.audit.revision, P10_ENTRY_REGIME_REVISION);
    assertEquals(result.audit.mode, "SHADOW");
  }
});

Deno.test("P10 entry regime shadow blocks NEUTRAL and RISK_OFF LONG", () => {
  const neutral = evaluateP10EntryRegime({
    side: "LONG",
    observations: [observation({ regime: "NEUTRAL", score: 45 })],
    nowMs: NOW,
  });
  assertEquals(neutral.verdict, "BLOCK");
  assertEquals(neutral.reason, "LONG_NEUTRAL_BLOCK");

  const riskOff = evaluateP10EntryRegime({
    side: "LONG",
    observations: [observation({ regime: "RISK_OFF", score: 36 })],
    nowMs: NOW,
  });
  assertEquals(riskOff.verdict, "BLOCK");
  assertEquals(riskOff.reason, "LONG_RISK_OFF_BLOCK");
});

Deno.test("P10 entry regime shadow blocks SHORT in BULL regimes", () => {
  const result = evaluateP10EntryRegime({
    side: "SHORT",
    observations: [observation({ regime: "BULL", score: 63 })],
    nowMs: NOW,
  });
  assertEquals(result.verdict, "BLOCK");
  assertEquals(result.reason, "SHORT_BULL_REGIME_BLOCK");
});

Deno.test("P10 entry regime shadow vetoes SHORT during capitulation/rebound phases", () => {
  for (
    const phase of [
      "CAPITULATION_REBOUND",
      "REBOUND_CONFIRMED",
      "RECOVERY_CONTINUATION",
      "IMPULSE_CONTINUATION",
    ]
  ) {
    const result = evaluateP10EntryRegime({
      side: "SHORT",
      observations: [observation({ regime: "RISK_OFF", score: 35, phase })],
      nowMs: NOW,
    });
    assertEquals(result.verdict, "BLOCK");
    assertEquals(result.reason, "SHORT_TACTICAL_REBOUND_BLOCK");
  }
});

Deno.test("P10 entry regime shadow allows SHORT only after 2h and 6h downside persistence", () => {
  const result = evaluateP10EntryRegime({
    side: "SHORT",
    observations: [observation({
      regime: "RISK_OFF",
      score: 36,
      phase: "ROLLING_OVER",
      horizons: [
        { minutes: 30, direction: "DOWN", probability: 0.57 },
        { minutes: 120, direction: "DOWN", probability: 0.62 },
        { minutes: 360, direction: "DOWN", probability: 0.61 },
      ],
    })],
    nowMs: NOW,
  });
  assertEquals(result.verdict, "ALLOW");
  assertEquals(result.reason, "SHORT_RISK_OFF_DOWNSIDE_CONFIRMED");
});

Deno.test("P10 entry regime shadow can allow NEUTRAL SHORT with persistent downside", () => {
  const result = evaluateP10EntryRegime({
    side: "SHORT",
    observations: [observation({
      regime: "NEUTRAL",
      score: 44,
      phase: "ROLLING_OVER",
    })],
    nowMs: NOW,
  });
  assertEquals(result.verdict, "ALLOW");
  assertEquals(result.reason, "SHORT_NEUTRAL_DOWNSIDE_CONFIRMED");
});

Deno.test("P10 entry regime shadow blocks SHORT when 30m rebound risk is strong", () => {
  const result = evaluateP10EntryRegime({
    side: "SHORT",
    observations: [observation({
      regime: "RISK_OFF",
      score: 36,
      phase: "ROLLING_OVER",
      horizons: [
        { minutes: 30, direction: "UP", probability: 0.60 },
        { minutes: 120, direction: "DOWN", probability: 0.62 },
        { minutes: 360, direction: "DOWN", probability: 0.61 },
      ],
    })],
    nowMs: NOW,
  });
  assertEquals(result.verdict, "BLOCK");
  assertEquals(result.reason, "SHORT_30M_REBOUND_RISK_BLOCK");
});

Deno.test("P10 entry regime shadow blocks SHORT without both medium and long downside confirmations", () => {
  const result = evaluateP10EntryRegime({
    side: "SHORT",
    observations: [observation({
      regime: "RISK_OFF",
      score: 36,
      phase: "ROLLING_OVER",
      horizons: [
        { minutes: 30, direction: "DOWN", probability: 0.56 },
        { minutes: 120, direction: "DOWN", probability: 0.62 },
        { minutes: 360, direction: "UP", probability: 0.57 },
      ],
    })],
    nowMs: NOW,
  });
  assertEquals(result.verdict, "BLOCK");
  assertEquals(result.reason, "SHORT_DOWNSIDE_PERSISTENCE_NOT_CONFIRMED");
});

Deno.test("P10 entry regime shadow is unavailable for stale or observation-only data", () => {
  const stale = evaluateP10EntryRegime({
    side: "LONG",
    observations: [observation({ minutesAgo: 13, regime: "BULL", score: 63 })],
    nowMs: NOW,
  });
  assertEquals(stale.verdict, "UNAVAILABLE");

  const observationOnly = evaluateP10EntryRegime({
    side: "LONG",
    observations: [observation({ influence: false, regime: "BULL", score: 63 })],
    nowMs: NOW,
  });
  assertEquals(observationOnly.verdict, "UNAVAILABLE");
});

Deno.test("P10 entry regime shadow records source error without creating a live block", () => {
  const result = evaluateP10EntryRegime({
    side: "SHORT",
    observations: [],
    nowMs: NOW,
    sourceError: "database timeout",
  });
  assertEquals(result.verdict, "UNAVAILABLE");
  assertEquals(result.reason, "ENTRY_REGIME_SOURCE_ERROR");
  assertEquals(result.audit.source_error, "database timeout");
});
