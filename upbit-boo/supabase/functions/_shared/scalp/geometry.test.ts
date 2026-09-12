import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  barrierResolveProbability,
  costFloorWidth,
  DEFAULT_SCALP_GEOMETRY,
  resolveGeometryConfig,
  resolveScalpGeometry,
  sigmaFromAtrPct,
} from "./geometry.ts";
import { probabilityWeightedGross, provisionalNetEdge } from "./cost-model.ts";
import { DEFAULT_SCALP_SIGNAL, refreshPWinAtOrderTime } from "./signal.ts";

// v5.5: 이 파일은 배리어 산정 자체를 검증하므로 체결방식 변수를 제거하기 위해
// 스프레드 회수 0(테이커) 기준으로 고정한다. 메이커 경제성은 maker.test.ts 담당.
// v5.6: 이 파일은 레거시(break-even+margin) 배리어 산정을 검증한다.
// 처리량 최적 모드와 승률 기반 분할은 throughput.test.ts 담당.
const LEGACY = { spreadCaptureFraction: 0, throughputOptimal: false, targetWinRate: 0 };
const UPBIT = { ...DEFAULT_SCALP_GEOMETRY, ...LEGACY, roundTripFeeFraction: 0.001 };
const BINANCE = { ...DEFAULT_SCALP_GEOMETRY, ...LEGACY, roundTripFeeFraction: 0.002 };

Deno.test("v5.2.5 geometry required an unreachable win rate", () => {
  // The defect this module exists to fix: with T=0.60% / S=0.30% the neutral win rate
  // is 33.3%, and clearing Upbit cost plus the 0.10% minimum edge needs 65.6%.
  const T = 0.006, S = 0.003;
  const cost = 0.001 + 0.0009;
  const neutral = S / (T + S);
  const required = (cost + 0.001 + S) / (T + S);
  assertAlmostEquals(neutral, 0.3333, 1e-3);
  assert(required > 0.65, `required ${required}`);
  // The signal model tops out well below that in realistic conditions.
  assert(required > 0.62);
});

Deno.test("cost floor width scales inversely with the edge budget", () => {
  const wide = costFloorWidth({ ...UPBIT, edgeBudget: 0.05 });
  const narrow = costFloorWidth({ ...UPBIT, edgeBudget: 0.20 });
  assert(wide > narrow);
  // (fee + slippage + minimumEdge) / edgeBudget
  assertAlmostEquals(costFloorWidth({ ...UPBIT, edgeBudget: 0.10 }), 0.029, 1e-6);
});

Deno.test("required excess win rate never exceeds the configured edge budget", () => {
  for (const cfg of [UPBIT, BINANCE]) {
    for (const atrPct of [0.05, 0.15, 0.3, 0.8, 2.0]) {
      const g = resolveScalpGeometry(sigmaFromAtrPct(atrPct, cfg), cfg);
      assert(
        g.requiredExcessWinRate <= cfg.edgeBudget + 1e-9,
        `atr ${atrPct} fee ${cfg.roundTripFeeFraction} required ${g.requiredExcessWinRate}`,
      );
    }
  }
});

Deno.test("binance barriers are wider than upbit at the same volatility", () => {
  const sigma = sigmaFromAtrPct(0.2, UPBIT)!;
  const u = resolveScalpGeometry(sigma, UPBIT);
  const b = resolveScalpGeometry(sigma, BINANCE);
  assert(b.targetPct > u.targetPct, `${b.targetPct} vs ${u.targetPct}`);
});

Deno.test("quiet symbols are cost-floor bound, fast symbols are volatility bound", () => {
  const quiet = resolveScalpGeometry(sigmaFromAtrPct(0.12, UPBIT), UPBIT);
  const fast = resolveScalpGeometry(sigmaFromAtrPct(1.2, UPBIT), UPBIT);
  assertEquals(quiet.bindingConstraint, "COST_FLOOR");
  assert(fast.targetPct > quiet.targetPct);
  assertEquals(fast.bindingConstraint, "VOLATILITY");
  // A quiet symbol needs more time to travel the same distance.
  assert(quiet.horizonMinutes >= fast.horizonMinutes);
});

Deno.test("reward:risk ratio is honored", () => {
  const g = resolveScalpGeometry(sigmaFromAtrPct(0.5, UPBIT), { ...UPBIT, rewardRiskRatio: 2 });
  assertAlmostEquals(g.targetPct / g.stopPct, 2, 1e-6);
});

Deno.test("missing volatility blocks the trade rather than guessing", () => {
  const g = resolveScalpGeometry(sigmaFromAtrPct(null, UPBIT), UPBIT);
  assertEquals(g.resolveProbability, 0);
  assertEquals(g.horizonSufficient, false);
  // resolveProbability 0 drives the probability-weighted gross to 0, so the EV gate
  // rejects it once costs are subtracted.
  assert(provisionalNetEdge(0.8, g.targetPct, g.stopPct, 0.001, g.resolveProbability) < 0);
});

Deno.test("resolve probability rises with horizon and falls with barrier width", () => {
  const sigma = 0.002;
  const short = barrierResolveProbability(sigma, 6, 0.02, 0.01);
  const long = barrierResolveProbability(sigma, 48, 0.02, 0.01);
  assert(long > short);
  const wide = barrierResolveProbability(sigma, 24, 0.04, 0.02);
  const tight = barrierResolveProbability(sigma, 24, 0.01, 0.005);
  assert(tight > wide);
});

Deno.test("timeout branch lowers expected value versus the v5.2.5 formula", () => {
  const legacy = probabilityWeightedGross(0.6, 0.02, 0.01, 1);
  const withTimeout = probabilityWeightedGross(0.6, 0.02, 0.01, 0.5);
  assertAlmostEquals(withTimeout, legacy * 0.5, 1e-12);
  assert(withTimeout < legacy);
});

Deno.test("timeout branch is a no-op when resolveProbability is omitted", () => {
  // Backward compatibility: existing callers keep the v5.2.5 numbers exactly.
  assertAlmostEquals(
    probabilityWeightedGross(0.6, 0.006, 0.003),
    0.6 * 0.006 - 0.4 * 0.003,
    1e-12,
  );
});

Deno.test("order-time refresh decays stale alpha toward the base rate", () => {
  const cfg = { ...DEFAULT_SCALP_SIGNAL, alphaHalfLifeMs: 20_000 };
  const scanPWin = 0.68;
  const scanImbalance = 0.045;
  // Same book, no elapsed time -> unchanged.
  const fresh = refreshPWinAtOrderTime(scanPWin, scanImbalance, 0.25, 0, cfg);
  assertAlmostEquals(fresh, scanPWin, 1e-9);
  // Same book, one minute later -> most of the non-book alpha has decayed away.
  const stale = refreshPWinAtOrderTime(scanPWin, scanImbalance, 0.25, 60_000, cfg);
  assert(stale < fresh, `${stale} !< ${fresh}`);
  assert(stale > cfg.basePWin);
});

Deno.test("order-time refresh reprices a book that flipped since the scan", () => {
  const cfg = { ...DEFAULT_SCALP_SIGNAL, alphaHalfLifeMs: 20_000 };
  const bullish = refreshPWinAtOrderTime(0.68, 0.045, 0.25, 5_000, cfg);
  const flipped = refreshPWinAtOrderTime(0.68, 0.045, -0.30, 5_000, cfg);
  assert(flipped < bullish - 0.05, `${flipped} vs ${bullish}`);
});

Deno.test("geometry config clamps hostile overrides", () => {
  const cfg = resolveGeometryConfig({ edgeBudget: 5, rewardRiskRatio: 99, maxHorizonMinutes: -1 });
  assert(cfg.edgeBudget <= 0.30);
  assert(cfg.rewardRiskRatio <= 4);
  assert(cfg.maxHorizonMinutes >= cfg.minHorizonMinutes);
});
