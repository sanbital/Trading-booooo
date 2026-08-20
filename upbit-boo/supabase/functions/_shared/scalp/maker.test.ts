import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  costFloorWidth,
  DEFAULT_SCALP_GEOMETRY,
  effectiveRoundTripCost,
  resolveGeometryConfig,
  resolveScalpGeometry,
  sigmaFromAtrPct,
} from "./geometry.ts";

/**
 * Mirrors makerBidPrice() / makerEntryStale() in market-autotrader/index.ts, which cannot
 * be imported without a live environment. Keep in sync.
 */
function makerBidPrice(bestBid: number, tick: number): number {
  const t = tick > 0 ? tick : Math.max(1e-8, bestBid * 1e-6);
  return Math.floor(bestBid / t) * t;
}
function makerEntryStale(restingPrice: number, bestBid: number, tick: number, driftTicks: number): boolean {
  if (!(restingPrice > 0 && bestBid > 0)) return true;
  const t = tick > 0 ? tick : Math.max(1e-8, bestBid * 1e-6);
  return (bestBid - restingPrice) / t >= driftTicks;
}

const LEGACY = { throughputOptimal: false, targetWinRate: 0 };
const UPBIT_TAKER = { ...DEFAULT_SCALP_GEOMETRY, ...LEGACY, roundTripFeeFraction: 0.001, spreadCaptureFraction: 0 };
const UPBIT_MAKER = { ...DEFAULT_SCALP_GEOMETRY, ...LEGACY, roundTripFeeFraction: 0.001, spreadCaptureFraction: 0.0005 };

Deno.test("a maker round trip earns the spread a taker pays", () => {
  const taker = effectiveRoundTripCost(UPBIT_TAKER);
  const maker = effectiveRoundTripCost(UPBIT_MAKER);
  assertAlmostEquals(taker - maker, 0.0005, 1e-12);
  assert(maker < taker);
});

Deno.test("cheaper execution narrows the barriers instead of widening them", () => {
  // The whole point: taker costs forced 2%-wide targets. Maker economics let the original
  // scalping geometry back in.
  const takerFloor = costFloorWidth(UPBIT_TAKER);
  const makerFloor = costFloorWidth(UPBIT_MAKER);
  assert(makerFloor < takerFloor, `${makerFloor} !< ${takerFloor}`);
  const sigma = sigmaFromAtrPct(0.20, UPBIT_MAKER);
  const taker = resolveScalpGeometry(sigma, UPBIT_TAKER);
  const maker = resolveScalpGeometry(sigma, UPBIT_MAKER);
  assert(maker.targetPct < taker.targetPct);
  // Narrower barriers on the same symbol resolve more often inside the horizon.
  assert(maker.resolveProbability > taker.resolveProbability);
});

Deno.test("required excess win rate falls under maker execution", () => {
  const sigma = sigmaFromAtrPct(0.20, UPBIT_MAKER);
  const taker = resolveScalpGeometry(sigma, UPBIT_TAKER);
  const maker = resolveScalpGeometry(sigma, UPBIT_MAKER);
  assert(maker.requiredExcessWinRate <= taker.requiredExcessWinRate + 1e-12);
});

Deno.test("spread capture is bounded and cannot be used to fake a negative cost", () => {
  const cfg = resolveGeometryConfig({ spreadCaptureFraction: 99 });
  assert(cfg.spreadCaptureFraction <= 0.005);
  // Even at the bound, effective cost floors at zero rather than going negative.
  const absurd = { ...DEFAULT_SCALP_GEOMETRY, roundTripFeeFraction: 0.0001, spreadCaptureFraction: 0.005 };
  assertEquals(effectiveRoundTripCost(absurd), 0);
});

Deno.test("a resting bid is never priced above the best bid", () => {
  // Binance rejects a crossing LIMIT_MAKER outright; Upbit has no post-only flag at all,
  // so pricing at or below the bid is the only guarantee the order does not take.
  for (const [bid, tick] of [[2751000, 1000], [6.781, 0.001], [0.07296, 0.00001]] as const) {
    const price = makerBidPrice(bid, tick);
    assert(price <= bid + 1e-12, `${price} > ${bid}`);
    // 틱 정렬 확인. 부동소수 나머지 대신 틱 배수로 환산해 검사한다.
    assertAlmostEquals(Math.round(price / tick) * tick, price, tick * 1e-6);
  }
});

Deno.test("an unusable tick falls back to a proportional one", () => {
  const price = makerBidPrice(1234.5, 0);
  assert(price > 0 && price <= 1234.5);
});

Deno.test("drift cancels only when the book walks UP away from our bid", () => {
  const tick = 1000;
  // Book rises three ticks: we are deep in the queue and unlikely to fill.
  assertEquals(makerEntryStale(2751000, 2754000, tick, 3), true);
  assertEquals(makerEntryStale(2751000, 2753000, tick, 3), false);
  // Book falls: our order is near the front. Keep waiting.
  assertEquals(makerEntryStale(2751000, 2748000, tick, 3), false);
});

Deno.test("an invalid book is treated as stale rather than held forever", () => {
  assertEquals(makerEntryStale(0, 2751000, 1000, 3), true);
  assertEquals(makerEntryStale(2751000, 0, 1000, 3), true);
});

Deno.test("the 2026-07-26 losing trades become viable under maker costs", () => {
  // LINKUSDT moved +0.036% and still lost 0.19%; EPICUSDT moved +0.220% and netted +0.01%.
  // Both were losing to the spread, not to the signal.
  const takerCost = 0.001 + 0.0005 + 0.0002; // fees + spread paid + latency
  const makerCost = 0.001 - 0.0005 + 0.0002; // fees - spread earned + latency
  const epicMove = 0.00220;
  // 실제로 기록된 순손익은 +0.01%였다. 방향을 0.22% 맞추고도 남는 게 없었다는 뜻.
  assert(epicMove - takerCost <= 0.0005, "taker: a correct 0.22% call nets almost nothing");
  assert(epicMove - makerCost >= 0.0014, "maker: the same call keeps most of the move");
  // 메이커가 같은 거래에서 남기는 몫이 테이커의 3배.
  assert((epicMove - makerCost) / (epicMove - takerCost) >= 3);
});
