import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateP10MarketRisk,
  P10_MARKET_RISK_CONFIG,
  type P10MarketRiskObservation,
} from "./p10-market-risk.ts";

const NOW = Date.parse("2026-08-26T10:45:00.000Z");

function breadthObservation(
  minutesAgo: number,
  positiveFraction: number,
  clippedMeanPct: number,
  regime = "NEUTRAL",
  bullScore = 54,
): P10MarketRiskObservation {
  const observedAt = new Date(NOW - minutesAgo * 60_000).toISOString();
  return {
    id: `breadth-${minutesAgo}`,
    observation_bucket: observedAt,
    observed_at: observedAt,
    model_revision: P10_MARKET_RISK_CONFIG.modelRevision,
    predicted_regime: regime,
    bull_score: bullScore,
    confidence: 0.70,
    sample_size: 1294,
    trading_influence: true,
    features: {
      source: P10_MARKET_RISK_CONFIG.source,
      breadth_30m: {
        binance_spot: { sample_size: 480, positive_fraction: positiveFraction },
        binance_futures: {
          sample_size: 520,
          positive_fraction: positiveFraction,
          clipped_mean_pct: clippedMeanPct,
        },
        upbit_spot: { sample_size: 190, positive_fraction: positiveFraction },
      },
      momentum_phase: { phase: "OVEREXTENSION_ROLLOVER" },
      conditional_forecast: { horizons: [] },
    },
  };
}

Deno.test("P10 SHORT treats strong 30m futures breadth reversal as adverse even in NEUTRAL regime", () => {
  const decision = evaluateP10MarketRisk({
    side: "SHORT",
    observations: [
      breadthObservation(1, 0.84, 0.62),
      breadthObservation(6, 0.79, 0.48),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "MARKET_RISK_PARTIAL");
  assertEquals(decision.audit.status, "DEFENSIVE");
  assertEquals(decision.audit.confirmation_count, 2);
  assertEquals(decision.audit.latest?.futures_positive_fraction_30m, 0.84);
});

Deno.test("P10 SHORT exits after four persistent breadth-adverse observations", () => {
  const decision = evaluateP10MarketRisk({
    side: "SHORT",
    observations: [
      breadthObservation(1, 0.89, 0.71),
      breadthObservation(6, 0.84, 0.55),
      breadthObservation(11, 0.78, 0.42),
      breadthObservation(16, 0.74, 0.31),
    ],
    nowMs: NOW,
    partialAlreadyDone: true,
  });
  assertEquals(decision.action, "MARKET_RISK_EXIT");
  assertEquals(decision.audit.status, "CRITICAL_PERSIST");
});

Deno.test("P10 recovery cannot override still-adverse breadth", () => {
  const decision = evaluateP10MarketRisk({
    side: "SHORT",
    observations: [
      breadthObservation(1, 0.86, 0.60, "NEUTRAL", 53),
      breadthObservation(6, 0.82, 0.45, "NEUTRAL", 52),
    ],
    nowMs: NOW,
    partialAlreadyDone: true,
  });
  assertEquals(decision.action, "NONE");
  assertEquals(decision.audit.status, "DEFENSIVE");
});

Deno.test("P10 LONG applies the inverse breadth protection", () => {
  const decision = evaluateP10MarketRisk({
    side: "LONG",
    observations: [
      breadthObservation(1, 0.18, -0.58, "NEUTRAL", 48),
      breadthObservation(6, 0.25, -0.34, "NEUTRAL", 47),
    ],
    nowMs: NOW,
    partialAlreadyDone: false,
  });
  assertEquals(decision.action, "MARKET_RISK_PARTIAL");
  assertEquals(decision.audit.status, "DEFENSIVE");
});
