import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyP10MarketRiskOverlay,
  evaluateP10MarketRisk,
  P10_MARKET_RISK_CONFIG,
  type P10MarketRiskObservation,
  p10RequestedExitQuantity,
} from "./p10-market-risk.ts";

const NOW = Date.parse("2026-08-24T02:00:00.000Z");

function observation(
  minutesAgo: number,
  input: {
    regime?: string;
    score?: number;
    confidence?: number;
    influence?: boolean;
    direction120?: string;
    probability120?: number;
  } = {},
): P10MarketRiskObservation {
  const observedAt = new Date(NOW - minutesAgo * 60_000).toISOString();
  return {
    id: `obs-${minutesAgo}`,
    observation_bucket: observedAt,
    observed_at: observedAt,
    model_revision: P10_MARKET_RISK_CONFIG.modelRevision,
    predicted_regime: input.regime || "RISK_OFF",
    bull_score: input.score ?? 36,
    confidence: input.confidence ?? 0.70,
    sample_size: 1296,
    trading_influence: input.influence ?? true,
    features: {
      source: P10_MARKET_RISK_CONFIG.source,
      breadth_30m: {
        binance_spot: { sample_size: 480 },
        binance_futures: { sample_size: 520 },
        upbit_spot: { sample_size: 190 },
      },
      momentum_phase: { phase: "ROLLING_OVER" },
      conditional_forecast: {
        horizons: [{
          horizon_minutes: 120,
          direction: input.direction120 || "NO_EDGE",
          confidence: input.direction120 ? "MEDIUM" : "LOW",
          probability: input.probability120 ?? null,
        }],
      },
    },
  };
}

Deno.test("P10 market risk ignores historical observation-only rows", () => {
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [observation(1, { influence: false })],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "NONE");
  assertEquals(decision.audit.status, "DISABLED");
});

Deno.test("P10 market risk rejects research fallback without live 30m breadth", () => {
  const fallback = observation(1);
  (fallback.features as any).breadth_30m = null;
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [fallback],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "NONE");
  assertEquals(decision.audit.status, "DISABLED");
});

Deno.test("P10 market risk watches one adverse observation and partially exits after two", () => {
  const watch = evaluateP10MarketRisk({
    side: "LONG",
    observations: [observation(1)],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(watch.action, "NONE");
  assertEquals(watch.audit.status, "WATCH");

  const defensive = evaluateP10MarketRisk({
    side: "LONG",
    observations: [observation(1), observation(6)],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(defensive.action, "MARKET_RISK_PARTIAL");
  assertEquals(defensive.fraction, 0.5);
  assertEquals(defensive.audit.confirmation_count, 2);
});

Deno.test("P10 market partial is position-scoped and never repeats", () => {
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [observation(1), observation(6), observation(11)],
    nowMs: NOW,
    partialAlreadyDone: true,
  });
  assertEquals(decision.action, "NONE");
  assertEquals(decision.audit.status, "DEFENSIVE");
});

Deno.test("P10 market risk exits after four contiguous adverse observations", () => {
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [observation(1), observation(6), observation(11), observation(16)],
    nowMs: NOW,
    partialAlreadyDone: true,
  });
  assertEquals(decision.action, "MARKET_RISK_EXIT");
  assertEquals(decision.audit.status, "CRITICAL_PERSIST");
});

Deno.test("P10 market risk fast-exits only with extreme pair and confirmed longer horizon", () => {
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      observation(1, { direction120: "DOWN", probability120: 0.61 }),
      observation(6),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "MARKET_RISK_EXIT");
  assertEquals(decision.audit.status, "CRITICAL_FAST");

  const thirtyMinuteOnly = observation(1);
  (thirtyMinuteOnly.features as any).conditional_forecast.horizons = [{
    horizon_minutes: 30,
    direction: "DOWN",
    confidence: "HIGH",
    probability: 0.90,
  }];
  const notFast = evaluateP10MarketRisk({
    side: "LONG",
    observations: [thirtyMinuteOnly, observation(6)],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(notFast.action, "MARKET_RISK_PARTIAL");
});

Deno.test("P10 market risk applies symmetric structural thresholds to SHORT", () => {
  const rows = [
    observation(1, { regime: "BULL", score: 63 }),
    observation(6, { regime: "STRONG_BULL", score: 64 }),
  ];
  const decision = evaluateP10MarketRisk({
    side: "SHORT",
    observations: rows,
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "MARKET_RISK_PARTIAL");
});

Deno.test("P10 market risk fails open for stale or source-error data", () => {
  const stale = evaluateP10MarketRisk({
    side: "LONG",
    observations: [observation(13)],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(stale.action, "NONE");
  assertEquals(stale.audit.status, "STALE");

  const failed = evaluateP10MarketRisk({
    side: "LONG",
    observations: [],
    nowMs: NOW,
    partialAlreadyDone: false,
    sourceError: "database timeout",
  });
  assertEquals(failed.action, "NONE");
  assertEquals(failed.reason, "MARKET_RISK_SOURCE_ERROR");
});

Deno.test("existing P10 exits outrank market overlay", () => {
  const marketRisk = evaluateP10MarketRisk({
    side: "LONG",
    observations: [observation(1), observation(6), observation(11), observation(16)],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  const stop = {
    action: "STOP",
    reason: "STOP_FIRST",
    fraction: 1,
    nextStop: 98,
    policyBarTime: NOW,
  };
  assertEquals(applyP10MarketRiskOverlay(stop, marketRisk), stop);
});

Deno.test("market partial sizes from remaining quantity and preserves the P10 T1 basis", () => {
  assertEquals(
    p10RequestedExitQuantity({
      action: "MARKET_RISK_PARTIAL",
      initialQuantity: 100,
      remainingQuantity: 60,
      fraction: 0.5,
    }),
    30,
  );
  assertEquals(
    p10RequestedExitQuantity({
      action: "TARGET_1",
      initialQuantity: 100,
      remainingQuantity: 60,
      fraction: 0.4,
    }),
    40,
  );
  assertEquals(
    p10RequestedExitQuantity({
      action: "MARKET_RISK_EXIT",
      initialQuantity: 100,
      remainingQuantity: 60,
      fraction: 1,
    }),
    60,
  );
});
