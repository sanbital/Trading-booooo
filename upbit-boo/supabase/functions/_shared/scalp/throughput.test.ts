import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  costFloorWidth,
  resolveMinimumEdge,
  DEFAULT_SCALP_GEOMETRY,
  effectiveRoundTripCost,
  resolveGeometryConfig,
  resolveRewardRisk,
  resolveScalpGeometry,
  scalpableAtrPct,
  sigmaFromAtrPct,
} from "./geometry.ts";

/**
 * v5.6 — the scalping constraint is not negotiable.
 *
 * v5.4 answered "the costs eat the edge" by widening targets to 2-4% and holding for up to
 * six hours. That is not a fix; it is a different strategy. The correct objective is
 * profit per unit TIME, not per trade:
 *
 *     profit rate ∝ (δW − C) / W²      (barrier hit time scales with W² )
 *     d/dW = 0    ⇒  W* = 2C/δ
 *
 * The optimum is a POINT with an upper bound, which is exactly what the break-even-plus-
 * margin sizing lacked.
 */

const MAKER = {
  ...DEFAULT_SCALP_GEOMETRY,
  roundTripFeeFraction: 0.001,
  slippageAllowance: 0.0003,
  spreadCaptureFraction: 0.0005,
  maxHorizonMinutes: 45,
  minHorizonMinutes: 5,
};

Deno.test("throughput-optimal width is 2C/edgeBudget", () => {
  for (const eb of [0.08, 0.10, 0.15, 0.20]) {
    const cfg = resolveGeometryConfig({ ...MAKER, edgeBudget: eb });
    assertAlmostEquals(costFloorWidth(cfg), 2 * effectiveRoundTripCost(cfg) / eb, 1e-12);
  }
});

Deno.test("widening past the optimum lowers profit per unit time", () => {
  const cfg = resolveGeometryConfig({ ...MAKER, edgeBudget: 0.10 });
  const C = effectiveRoundTripCost(cfg);
  const rate = (W: number) => (cfg.edgeBudget * W - C) / (W * W);
  const optimum = costFloorWidth(cfg);
  for (const factor of [0.5, 0.75, 1.5, 2, 4]) {
    assert(rate(optimum) > rate(optimum * factor), `factor ${factor} beat the optimum`);
  }
});

Deno.test("the v5.4 swing width is far past the optimum", () => {
  const cfg = resolveGeometryConfig({ ...MAKER, edgeBudget: 0.10 });
  const optimum = costFloorWidth(cfg);
  // v5.4 produced roughly 2% target + 1% stop.
  assert(optimum < 0.02, `optimum ${optimum} should be well inside a scalp width`);
  const C = effectiveRoundTripCost(cfg);
  const rate = (W: number) => (cfg.edgeBudget * W - C) / (W * W);
  // 3% 폭(v5.4의 2%+1%)은 최적 대비 약 22% 손해, 4배 폭이면 절반 이상을 잃는다.
  assert(rate(optimum) > rate(0.03));
  assert(rate(0.03) / rate(optimum) < 0.85);
  assert(rate(optimum * 4) / rate(optimum) < 0.5);
});

Deno.test("a >50% win rate requires the stop to be no tighter than the target", () => {
  // Neutral win rate IS S/(T+S). A 2:1 reward:risk caps it at 33% before any edge, so
  // asking for 50%+ is asking for S >= T. This is arithmetic, not preference.
  const cfg = resolveGeometryConfig({ ...MAKER, targetWinRate: 0.60, edgeBudget: 0.10 });
  const g = resolveScalpGeometry(sigmaFromAtrPct(0.8, cfg), cfg);
  assertAlmostEquals(g.neutralWinRate, 0.50, 1e-9);
  assert(g.stopPct >= g.targetPct - 1e-12, `stop ${g.stopPct} < target ${g.targetPct}`);
});

Deno.test("the realized win rate lands on the configured target", () => {
  for (const wr of [0.52, 0.55, 0.58, 0.62]) {
    const cfg = resolveGeometryConfig({ ...MAKER, targetWinRate: wr, edgeBudget: 0.10 });
    const g = resolveScalpGeometry(sigmaFromAtrPct(0.8, cfg), cfg);
    assertAlmostEquals(g.neutralWinRate + cfg.edgeBudget, wr, 1e-6);
  }
});

Deno.test("expected value per trade stays positive at every win-rate setting", () => {
  for (const wr of [0.52, 0.55, 0.58, 0.62]) {
    const cfg = resolveGeometryConfig({ ...MAKER, targetWinRate: wr, edgeBudget: 0.10 });
    const g = resolveScalpGeometry(sigmaFromAtrPct(0.8, cfg), cfg);
    const W = g.targetPct + g.stopPct;
    const ev = cfg.edgeBudget * W - effectiveRoundTripCost(cfg);
    assert(ev > 0, `win rate ${wr} gave EV ${ev}`);
    // At the optimum W = 2C/δ the per-trade edge equals the round-trip cost exactly.
    assertAlmostEquals(ev, effectiveRoundTripCost(cfg), 1e-9);
  }
});

Deno.test("reward:risk is derived from the win rate, not the other way round", () => {
  assertAlmostEquals(resolveRewardRisk({ ...MAKER, targetWinRate: 0.60, edgeBudget: 0.10 }), 1.0, 1e-9);
  assert(resolveRewardRisk({ ...MAKER, targetWinRate: 0.55, edgeBudget: 0.10 }) > 1.0);
  assert(resolveRewardRisk({ ...MAKER, targetWinRate: 0.65, edgeBudget: 0.10 }) < 1.0);
  // Explicitly disabling the win-rate target restores the fixed ratio.
  assertAlmostEquals(resolveRewardRisk({ ...MAKER, targetWinRate: 0, rewardRiskRatio: 2 }), 2, 1e-12);
});

Deno.test("high volatility buys speed, not a wider target", () => {
  // The optimum width does not depend on volatility. A faster symbol should be traded
  // more often at the same width; widening it trades away the turnover that produces
  // the profit in the first place.
  const cfg = resolveGeometryConfig({ ...MAKER, edgeBudget: 0.10 });
  const calm = resolveScalpGeometry(sigmaFromAtrPct(0.5, cfg), cfg);
  const fast = resolveScalpGeometry(sigmaFromAtrPct(1.5, cfg), cfg);
  assertAlmostEquals(fast.targetPct, calm.targetPct, 1e-12);
  assert(fast.horizonMinutes < calm.horizonMinutes);
  assert(fast.resolveProbability > calm.resolveProbability);
});

Deno.test("holding times stay inside a scalp horizon", () => {
  const cfg = resolveGeometryConfig({ ...MAKER, edgeBudget: 0.10, maxHorizonMinutes: 45 });
  const g = resolveScalpGeometry(sigmaFromAtrPct(0.8, cfg), cfg);
  assert(g.horizonMinutes <= 45, `${g.horizonMinutes} minutes is not a scalp`);
});

Deno.test("the required volatility is stated rather than assumed away", () => {
  const cfg = resolveGeometryConfig({ ...MAKER, edgeBudget: 0.10 });
  const g = resolveScalpGeometry(sigmaFromAtrPct(0.8, cfg), cfg);
  const needed30 = scalpableAtrPct(g.targetPct, 30, cfg);
  const needed45 = scalpableAtrPct(g.targetPct, 45, cfg);
  assert(needed45 < needed30, "a longer horizon needs less volatility");
  // The symbols the live book actually traded were nowhere near scalpable.
  for (const atr of [0.06, 0.05, 0.14, 0.20, 0.27]) {
    assert(atr < needed30, `ATR ${atr}% should not qualify for a 30-minute scalp`);
  }
  // A genuinely moving coin does.
  assert(1.0 > needed30);
});

Deno.test("legacy sizing is still reachable for taker configurations", () => {
  const legacy = resolveGeometryConfig({
    ...MAKER,
    throughputOptimal: false,
    targetWinRate: 0,
    rewardRiskRatio: 2,
    spreadCaptureFraction: 0,
  });
  assertAlmostEquals(
    costFloorWidth(legacy),
    (effectiveRoundTripCost(legacy) + legacy.minimumEdge) / legacy.edgeBudget,
    1e-12,
  );
  const g = resolveScalpGeometry(sigmaFromAtrPct(0.8, legacy), legacy);
  assertAlmostEquals(g.targetPct / g.stopPct, 2, 1e-9);
});

Deno.test("the EV threshold cannot exceed what the optimum produces", () => {
  // The v5.6 regression: at W* = 2C/δ the expected value per trade is exactly C, but the
  // gate kept an absolute 0.10% while C under maker execution is 0.08%. A signal
  // delivering precisely the assumed edge was rejected — the design refused its own
  // optimum, and live entries collapsed.
  for (const fee of [0.001, 0.0015, 0.002]) {
    const cfg = resolveGeometryConfig({ ...MAKER, roundTripFeeFraction: fee });
    const C = effectiveRoundTripCost(cfg);
    const designEv = cfg.edgeBudget * costFloorWidth(cfg) - C;
    assertAlmostEquals(designEv, C, 1e-12);
    assert(
      resolveMinimumEdge(cfg) < designEv,
      `threshold ${resolveMinimumEdge(cfg)} blocks the design's own output ${designEv}`,
    );
  }
});

Deno.test("the threshold scales with cost rather than sitting at an absolute level", () => {
  const cheap = resolveGeometryConfig({ ...MAKER, roundTripFeeFraction: 0.001 });
  const dear = resolveGeometryConfig({ ...MAKER, roundTripFeeFraction: 0.002 });
  assert(resolveMinimumEdge(dear) > resolveMinimumEdge(cheap));
  assertAlmostEquals(
    resolveMinimumEdge(cheap) / effectiveRoundTripCost(cheap),
    resolveMinimumEdge(dear) / effectiveRoundTripCost(dear),
    1e-12,
  );
});

Deno.test("legacy mode keeps the absolute threshold", () => {
  const legacy = resolveGeometryConfig({ ...MAKER, throughputOptimal: false, minimumEdge: 0.001 });
  assertAlmostEquals(resolveMinimumEdge(legacy), 0.001, 1e-12);
});

Deno.test("a signal at exactly the assumed edge can pass", () => {
  const cfg = resolveGeometryConfig({ ...MAKER, targetWinRate: 0.58, edgeBudget: 0.10 });
  const g = resolveScalpGeometry(sigmaFromAtrPct(0.8, cfg), cfg);
  const p = g.neutralWinRate + cfg.edgeBudget;
  const gross = p * g.targetPct - (1 - p) * g.stopPct;
  const requiredResolve = (resolveMinimumEdge(cfg) + effectiveRoundTripCost(cfg)) / gross;
  assert(requiredResolve < 1, `needs ${requiredResolve} resolution probability — unreachable`);
});
