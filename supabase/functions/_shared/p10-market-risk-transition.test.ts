import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyP10MarketRiskOverlay,
  evaluateP10MarketRisk,
  P10_MARKET_RISK_CONFIG,
  type P10MarketRiskObservation,
} from "./p10-market-risk.ts";

const NOW = Date.parse("2026-08-29T00:00:00.000Z");

function observation(
  minutesAgo: number,
  input: {
    regime: "RISK_OFF" | "NEUTRAL" | "BULL" | "STRONG_BULL";
    score: number;
    confidence?: number;
    phase?: string;
    direction120?: "UP" | "DOWN" | "NO_EDGE";
    probability120?: number;
  },
): P10MarketRiskObservation {
  const observedAt = new Date(NOW - minutesAgo * 60_000).toISOString();
  const direction = input.direction120 ?? "NO_EDGE";
  return {
    id: `transition-${minutesAgo}-${input.regime}`,
    observation_bucket: observedAt,
    observed_at: observedAt,
    model_revision: P10_MARKET_RISK_CONFIG.modelRevision,
    predicted_regime: input.regime,
    bull_score: input.score,
    confidence: input.confidence ?? 0.70,
    sample_size: 1297,
    trading_influence: true,
    features: {
      source: P10_MARKET_RISK_CONFIG.source,
      breadth_30m: {
        binance_spot: { sample_size: 485 },
        binance_futures: { sample_size: 524 },
        upbit_spot: { sample_size: 288 },
      },
      momentum_phase: { phase: input.phase ?? "NEUTRAL" },
      conditional_forecast: {
        horizons: [{
          horizon_minutes: 120,
          direction,
          confidence: direction === "NO_EDGE" ? "LOW" : "MEDIUM",
          probability: input.probability120 ?? null,
        }],
      },
    },
  };
}

Deno.test("BULL LONG transitions to RANGE: watch then 50% defense then persistent exit", () => {
  const watch = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      observation(1, { regime: "NEUTRAL", score: 50 }),
      observation(6, { regime: "BULL", score: 62 }),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(watch.action, "NONE");
  assertEquals(watch.reason, "REGIME_TRANSITION_BULL_TO_RANGE_WATCH");

  const defensive = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      observation(1, { regime: "NEUTRAL", score: 50 }),
      observation(6, { regime: "NEUTRAL", score: 49 }),
      observation(11, { regime: "BULL", score: 62 }),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(defensive.action, "MARKET_RISK_PARTIAL");
  assertEquals(defensive.fraction, 0.5);
  assertEquals(defensive.reason, "REGIME_TRANSITION_BULL_TO_RANGE_DEFENSIVE");

  const persistent = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      observation(1, { regime: "NEUTRAL", score: 49 }),
      observation(6, { regime: "NEUTRAL", score: 50 }),
      observation(11, { regime: "NEUTRAL", score: 50 }),
      observation(16, { regime: "NEUTRAL", score: 51 }),
      observation(21, { regime: "BULL", score: 62 }),
    ],
    nowMs: NOW,
    partialAlreadyDone: true,
  });
  assertEquals(persistent.action, "MARKET_RISK_EXIT");
  assertEquals(persistent.reason, "REGIME_TRANSITION_BULL_TO_RANGE_PERSIST_EXIT");
});

Deno.test("BULL LONG fast-exits on high-confidence BEAR transition with 2h downside confirmation", () => {
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      observation(1, {
        regime: "RISK_OFF",
        score: 35,
        confidence: 0.76,
        direction120: "DOWN",
        probability120: 0.62,
      }),
      observation(6, { regime: "BULL", score: 63 }),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "MARKET_RISK_EXIT");
  assertEquals(decision.reason, "REGIME_TRANSITION_BULL_TO_BEAR_FAST_EXIT");
});

Deno.test("BEAR SHORT transitions to RANGE with 50% defensive reduction", () => {
  const decision = evaluateP10MarketRisk({
    side: "SHORT",
    observations: [
      observation(1, { regime: "NEUTRAL", score: 49 }),
      observation(6, { regime: "NEUTRAL", score: 48 }),
      observation(11, { regime: "RISK_OFF", score: 37 }),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "MARKET_RISK_PARTIAL");
  assertEquals(decision.fraction, 0.5);
  assertEquals(decision.reason, "REGIME_TRANSITION_BEAR_TO_RANGE_DEFENSIVE");
});

Deno.test("RANGE defense recovers into favorable BULL after two fresh observations", () => {
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      observation(1, { regime: "BULL", score: 62 }),
      observation(6, { regime: "BULL", score: 61 }),
      observation(11, { regime: "NEUTRAL", score: 50 }),
    ],
    nowMs: NOW,
    partialAlreadyDone: true,
  });
  assertEquals(decision.action, "NONE");
  assertEquals(decision.audit.status, "RECOVERED");
  assertEquals(decision.reason, "REGIME_TRANSITION_RANGE_TO_BULL_RECOVERED");
});

Deno.test("structural full exit outranks a softer target but never a hard stop", () => {
  const marketRisk = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      observation(1, { regime: "RISK_OFF", score: 36 }),
      observation(6, { regime: "RISK_OFF", score: 37 }),
      observation(11, { regime: "BULL", score: 62 }),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  const target = {
    action: "TARGET_1",
    reason: "BASE_TARGET",
    fraction: 0.5,
    nextStop: 100,
    policyBarTime: NOW,
  };
  assertEquals(applyP10MarketRiskOverlay(target, marketRisk).action, "MARKET_RISK_EXIT");
  const stop = { ...target, action: "STOP", reason: "HARD_STOP" };
  assertEquals(applyP10MarketRiskOverlay(stop, marketRisk), stop);
});
