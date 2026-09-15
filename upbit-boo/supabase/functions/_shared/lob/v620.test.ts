import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assessLobTraps, midPathStatistics } from "./traps.ts";
import { NEUTRAL_FUNDING, perpSymbolFor, scoreFunding } from "./funding.ts";
import {
  buildLobLearningProfile,
  patternDeployment,
  patternMultiplier,
  unearnedVetoes,
  wilsonLowerBound,
} from "./learning.ts";
import type { LobOutcomeSample } from "./learning.ts";
import { calibrateMakerFillProbability, neutralWinRateOf } from "./entry.ts";
import { effectiveSlots, evaluateModelHealth, shouldConvertToTaker, surprisingStreak } from "./health.ts";

const cleanBook = {
  askAbsorptionScore: 0.05,
  askRefillRatio: 0.02,
  bidSpoofScore: 0.05,
  askSpoofScore: 0.05,
  pathEfficiency: 0.6,
  reversalRate: 0.3,
  noiseBandBps: 3,
  quoteFlickerRate: 10,
  tradeArrivalRate: 12,
  dataQuality: 0.9,
};

Deno.test("a clean book produces no vetoes and no confidence penalty", () => {
  const result = assessLobTraps(cleanBook, 20);
  assertEquals(result.vetoes, []);
  assertEquals(result.confidenceMultiplier, 1);
});

Deno.test("a refilling ask wall vetoes the entry", () => {
  // The mechanism: the target sits above a price the seller keeps reloading, so the target
  // is unreachable while every bullish feature still reads bullish.
  const result = assessLobTraps({ ...cleanBook, askAbsorptionScore: 0.8, askRefillRatio: 0.9 }, 20);
  assert(result.vetoes.includes("ASK_ICEBERG"), "refilling ask must veto");
});

Deno.test("bid spoof vetoes well below the old 0.97 threshold", () => {
  // v6.1 blocked only at >= 0.97 while the scanner's own SPOOF_LIKE_RISK label fires at
  // 0.65, so books the system had already flagged stayed buyable.
  const result = assessLobTraps({ ...cleanBook, bidSpoofScore: 0.7 }, 20);
  assert(result.vetoes.includes("BID_SPOOF"), "0.70 bid spoof must veto");
});

Deno.test("ask spoof alone penalises but does not veto", () => {
  const result = assessLobTraps({ ...cleanBook, askSpoofScore: 0.85 }, 20);
  assertEquals(result.vetoes, []);
  assert(result.confidenceMultiplier < 1, "one-sided spoof must cost confidence");
});

Deno.test("both sides spoofed vetoes", () => {
  const result = assessLobTraps({ ...cleanBook, askSpoofScore: 0.85, bidSpoofScore: 0.7 }, 20);
  assert(result.vetoes.includes("BID_SPOOF"));
  assert(result.vetoes.includes("ASK_SPOOF"));
});

Deno.test("chop widens the required stop instead of blocking the trade", () => {
  // Hot books are choppy by construction. Rejecting chop outright would reject the whole
  // universe this strategy targets, so the stop moves and the EV gate decides.
  const result = assessLobTraps(
    { ...cleanBook, pathEfficiency: 0.05, reversalRate: 0.9, noiseBandBps: 30 },
    10,
  );
  assertEquals(result.vetoes, []);
  assertAlmostEquals(result.requiredStopBps, 37.5, 1e-9);
});

Deno.test("noise wider than any scalp stop is a veto", () => {
  const result = assessLobTraps({ ...cleanBook, noiseBandBps: 400 }, 20);
  assert(result.vetoes.includes("CHOP_NO_VIABLE_STOP"));
});

Deno.test("an unreliable window never vetoes on absence of evidence", () => {
  const result = assessLobTraps(
    { ...cleanBook, bidSpoofScore: 0.9, askAbsorptionScore: 0.9, askRefillRatio: 0.9, dataQuality: 0.05 },
    20,
  );
  assertEquals(result.vetoes, []);
  assertEquals(result.unreliable, true);
});

Deno.test("path statistics separate a trend from chop", () => {
  const trend = midPathStatistics([100, 100.1, 100.2, 100.3, 100.4, 100.5]);
  const chop = midPathStatistics([100, 100.2, 100, 100.2, 100, 100.2, 100]);
  assert(trend.pathEfficiency > 0.9, "a monotonic path is efficient");
  assert(chop.pathEfficiency < 0.2, "an oscillating path is not");
  assert(chop.reversalRate > trend.reversalRate);
  assert(chop.noiseBandBps > trend.noiseBandBps, "chop has the wider adverse excursion");
});

Deno.test("neutral win rate is pure geometry", () => {
  // A 2:1 payoff cannot win more than a third of the time without an edge. This is the
  // arithmetic that v6.1's pTarget formula bypassed entirely.
  assertAlmostEquals(neutralWinRateOf(20, 10), 1 / 3, 1e-9);
  assertAlmostEquals(neutralWinRateOf(10, 10), 0.5, 1e-9);
});

Deno.test("perp symbols map from both venues", () => {
  assertEquals(perpSymbolFor("KRW-BTC"), "BTCUSDT");
  assertEquals(perpSymbolFor("ETHUSDT"), "ETHUSDT");
  assertEquals(perpSymbolFor("KRW-XYZNOPERP"), "XYZNOPERPUSDT");
  assertEquals(perpSymbolFor(""), null);
});

Deno.test("missing funding data is neutral, never negative", () => {
  const signal = scoreFunding(null, null);
  assertEquals(signal, NEUTRAL_FUNDING);
  assertEquals(signal.edge, 0);
});

Deno.test("rising premium supports a long, crowded premium does not", () => {
  const rising = scoreFunding(
    { symbol: "BTCUSDT", lastFundingRate: 0.00002, markPrice: 100.08, indexPrice: 100, timestampMs: 2 },
    { symbol: "BTCUSDT", lastFundingRate: 0.00002, markPrice: 100.0, indexPrice: 100, timestampMs: 1 },
  );
  assert(rising.edge > 0, "fresh perp buying is supportive");

  const crowded = scoreFunding(
    { symbol: "BTCUSDT", lastFundingRate: 0.0030, markPrice: 100.5, indexPrice: 100, timestampMs: 2 },
    { symbol: "BTCUSDT", lastFundingRate: 0.0030, markPrice: 100.5, indexPrice: 100, timestampMs: 1 },
  );
  assert(crowded.edge < 0, "premium already paid for through funding is crowding");
});

Deno.test("the funding edge stays inside its bound whatever the input", () => {
  const extreme = scoreFunding(
    { symbol: "BTCUSDT", lastFundingRate: 1, markPrice: 500, indexPrice: 100, timestampMs: 2 },
    { symbol: "BTCUSDT", lastFundingRate: 0, markPrice: 100, indexPrice: 100, timestampMs: 1 },
  );
  assert(Math.abs(extreme.edge) <= 0.03 + 1e-12, "funding cannot dominate the signal edge");
});

function sample(overrides: Partial<LobOutcomeSample> = {}): LobOutcomeSample {
  return {
    pattern: "OFI_CONTINUATION",
    predicted: 0.50,
    neutral: 0.40,
    outcome: 1,
    netBps: 5,
    heldSeconds: 60,
    traps: [],
    exploration: false,
    closedAtMs: Date.now(),
    ...overrides,
  };
}

Deno.test("learning corrects the signal edge, not the geometric term", () => {
  // Predicted edge is 0.10 over neutral. Realized hit rate is exactly neutral, so the
  // measured edge is zero and the correction should pull the multiplier below 1 — but only
  // partway, because 60 samples is not yet strong evidence.
  const rows = [
    ...Array.from({ length: 24 }, () => sample({ outcome: 1 })),
    ...Array.from({ length: 36 }, () => sample({ outcome: 0 })),
  ];
  const profile = buildLobLearningProfile(rows);
  const row = profile.patterns.find((p) => p.pattern === "OFI_CONTINUATION")!;
  assertEquals(row.samples, 60);
  assertAlmostEquals(row.realizedHitRate, 0.4, 1e-9);
  assertAlmostEquals(row.measuredEdge, 0, 1e-9);
  assert(row.probabilityMultiplier < 1, "a delivered edge of zero must shrink the multiplier");
  assert(row.probabilityMultiplier > 0.6, "60 samples must not swing the model wholesale");
});

Deno.test("an unmeasured pattern is left alone rather than penalised", () => {
  const profile = buildLobLearningProfile([sample(), sample()]);
  assertEquals(profile.patterns.length, 0);
  assertEquals(patternMultiplier(profile, "SWEEP_RECLAIM"), 1);
  assertEquals(patternMultiplier(null, "SWEEP_RECLAIM"), 1);
});

Deno.test("same-day live evidence can correct a pattern below the old 0.65 floor", () => {
  const rows = [
    ...Array.from({ length: 2 }, () =>
      sample({
        pattern: "ABSORPTION_REVERSAL",
        predicted: 0.51,
        neutral: 0.40,
        outcome: 1,
      })),
    ...Array.from({ length: 27 }, () =>
      sample({
        pattern: "ABSORPTION_REVERSAL",
        predicted: 0.51,
        neutral: 0.40,
        outcome: 0,
      })),
  ];
  const profile = buildLobLearningProfile(rows);
  const multiplier = patternMultiplier(profile, "ABSORPTION_REVERSAL");
  assert(multiplier < 0.65, "adverse live evidence must not be discarded by the old floor");
  assert(multiplier >= 0.30, "the conservative correction floor still applies");
});

Deno.test("same-day evidence ranks immediately but cannot zero the hard gate", () => {
  const rows = [
    ...Array.from({ length: 2 }, () =>
      sample({
        pattern: "ABSORPTION_REVERSAL",
        predicted: 0.51,
        neutral: 0.40,
        outcome: 1,
        netBps: 8,
        heldSeconds: 40,
      })),
    ...Array.from({ length: 27 }, () =>
      sample({
        pattern: "ABSORPTION_REVERSAL",
        predicted: 0.51,
        neutral: 0.40,
        outcome: 0,
        netBps: -20,
        heldSeconds: 80,
      })),
  ];
  const profile = buildLobLearningProfile(rows);
  const deployment = patternDeployment(profile, "ABSORPTION_REVERSAL");
  assert(deployment.observedMultiplier < 0.65);
  assertEquals(deployment.gateWeight, 0);
  assertEquals(deployment.gateMultiplier, 1);
  assert(deployment.rankingQuality < 1, "bad same-day evidence must still lower priority");
  assertAlmostEquals(deployment.profitableRate!, 2 / 29, 1e-12);
  assertEquals(deployment.medianHoldSeconds, 80);
});

Deno.test("mature adverse evidence remains ranking-only and cannot delete turnover", () => {
  const profile = buildLobLearningProfile(
    Array.from({ length: 360 }, (_, index) =>
      sample({
        outcome: index < 36 ? 1 : 0,
        netBps: index < 36 ? 10 : -10,
      })
    ),
  );
  const row = profile.patterns[0];
  const atStart = patternDeployment(
    { ...profile, patterns: [{ ...row, samples: 120 }] },
    "OFI_CONTINUATION",
  );
  const halfway = patternDeployment(
    { ...profile, patterns: [{ ...row, samples: 240 }] },
    "OFI_CONTINUATION",
  );
  const mature = patternDeployment(profile, "OFI_CONTINUATION");
  assertEquals(atStart.gateMultiplier, 1);
  assertAlmostEquals(halfway.gateWeight, 0.5, 1e-12);
  assertEquals(halfway.gateMultiplier, 1);
  assertEquals(mature.gateMultiplier, 1);
});

Deno.test("mature positive evidence may lift EV without adverse evidence deleting trades", () => {
  const profile = buildLobLearningProfile(
    Array.from({ length: 360 }, () =>
      sample({
        predicted: 0.48,
        neutral: 0.40,
        outcome: 1,
        netBps: 15,
      })
    ),
  );
  const deployment = patternDeployment(profile, "OFI_CONTINUATION");
  assert(deployment.observedMultiplier > 1);
  assertAlmostEquals(deployment.gateMultiplier, deployment.observedMultiplier, 1e-12);
});

Deno.test("a trap that marks no worse trades loses its veto", () => {
  // Both arms hit at the same rate, so the flag is separating nothing. Leaving it as a hard
  // block would cost throughput permanently and could never be disproved, because vetoed
  // trades generate no outcomes.
  const rows = [
    ...Array.from({ length: 15 }, () => sample({ traps: ["QUOTE_FLICKER"], outcome: 1 })),
    ...Array.from({ length: 15 }, () => sample({ traps: ["QUOTE_FLICKER"], outcome: 0 })),
    ...Array.from({ length: 15 }, () => sample({ outcome: 1 })),
    ...Array.from({ length: 15 }, () => sample({ outcome: 0 })),
  ];
  const profile = buildLobLearningProfile(rows);
  const flicker = profile.traps.find((t) => t.trap === "QUOTE_FLICKER")!;
  assertEquals(flicker.verdict, "NEUTRAL");
  assert(unearnedVetoes(profile).includes("QUOTE_FLICKER"));
});

Deno.test("a trap that does mark worse trades keeps its veto", () => {
  const rows = [
    ...Array.from({ length: 25 }, () => sample({ traps: ["ASK_ICEBERG"], outcome: 0 })),
    ...Array.from({ length: 20 }, () => sample({ outcome: 1 })),
    ...Array.from({ length: 10 }, () => sample({ outcome: 0 })),
  ];
  const profile = buildLobLearningProfile(rows);
  const iceberg = profile.traps.find((t) => t.trap === "ASK_ICEBERG")!;
  assertEquals(iceberg.verdict, "HARMFUL");
  assertEquals(unearnedVetoes(profile).includes("ASK_ICEBERG"), false);
});

Deno.test("wilson lower bound is conservative at small samples", () => {
  assert(wilsonLowerBound(3, 3) < 1, "three wins is not certainty");
  assert(wilsonLowerBound(300, 300) > wilsonLowerBound(3, 3));
  assertEquals(wilsonLowerBound(0, 0), 0);
});

Deno.test("a losing streak threshold has to move with the win rate", () => {
  // Four losses in a row is routine at 55% and alarming at 80%. A fixed count means
  // something different at every win rate, which is why it carries no information.
  const at55 = surprisingStreak(0.55, 200, 3, 25);
  const at80 = surprisingStreak(0.80, 200, 3, 25);
  assert(at55 > at80, "a lower win rate must tolerate longer streaks");
  assertEquals(at55, 7);
  assertEquals(at80, 4);
});

Deno.test("model health is judged against prediction, not against losses", () => {
  const asPredicted = evaluateModelHealth(
    Array.from({ length: 100 }, (_, i) => ({ predicted: 0.55, outcome: (i % 100 < 55 ? 1 : 0) as 0 | 1 })),
  );
  assertEquals(asPredicted.healthy, true);

  const broken = evaluateModelHealth(
    Array.from({ length: 100 }, (_, i) => ({ predicted: 0.55, outcome: (i % 100 < 25 ? 1 : 0) as 0 | 1 })),
  );
  assertEquals(broken.healthy, false);
  assertEquals(broken.reason, "MODEL_UNDERPERFORMING");
});

Deno.test("health stays silent until it has samples", () => {
  const thin = evaluateModelHealth([{ predicted: 0.55, outcome: 0 }]);
  assertEquals(thin.healthy, true);
  assertEquals(thin.reason, "UNMEASURED");
});

Deno.test("taker conversion needs a measured low fill rate AND surviving economics", () => {
  assertEquals(shouldConvertToTaker({ rested: 5, filled: 0 }, 10).convertToTaker, false);
  assertEquals(shouldConvertToTaker({ rested: 100, filled: 80 }, 10).convertToTaker, false);
  // Low fill rate but the edge only existed because of the spread capture.
  assertEquals(shouldConvertToTaker({ rested: 100, filled: 10 }, -2).convertToTaker, false);
  assertEquals(shouldConvertToTaker({ rested: 100, filled: 10 }, 4).convertToTaker, true);
});

Deno.test("maker pFill is shrunk toward the exchange's realized fill rate", () => {
  const unmeasured = calibrateMakerFillProbability(0.78, 0.39, 0);
  assertAlmostEquals(unmeasured.probability, 0.78, 1e-12);
  assertEquals(unmeasured.weight, 0);

  const measured = calibrateMakerFillProbability(0.78, 0.39, 171, 60);
  assert(measured.probability < 0.78);
  assert(measured.probability > 0.39);
  assertAlmostEquals(measured.weight, 171 / 231, 1e-12);
});

Deno.test("LOB calibration reads only verified closed LIVE outcomes", async () => {
  const source = await Deno.readTextFile(
    new URL("../../lob-calibration/index.ts", import.meta.url),
  );
  assert(source.includes("lob_online_outcomes?closed_at=gte."));
  assert(source.includes("verifiedOutcomeToSample"));
  assert(source.includes("fee_accounting_quality=in.(EXACT,AGGREGATE_EXACT"));
  assert(source.includes("prediction_basis=eq.FILL_CONDITIONAL"));
});

Deno.test("slots never exceed the configured ceiling and never strand capital", () => {
  assertEquals(effectiveSlots(6, 2, 0), 2);
  assertEquals(effectiveSlots(6, 2, 3), 5);
  assertEquals(effectiveSlots(6, 20, 0), 6);
  assertEquals(effectiveSlots(6, 0, 0), 6);
});
