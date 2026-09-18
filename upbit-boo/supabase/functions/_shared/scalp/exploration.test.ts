import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_EXPLORATION,
  estimateExplorationCost,
  evaluateExploration,
  OVERRIDABLE_BLOCK_REASON,
  resolveExplorationConfig,
} from "./exploration.ts";

const cfg = { ...DEFAULT_EXPLORATION, maxPerDay: 40, maxPerScan: 1, sizeFraction: 0.33 };
const base = {
  blockReason: OVERRIDABLE_BLOCK_REASON,
  expectedNetEdge: 0.0002,
  roundTripCost: 0.0008,
  usedToday: 0,
  usedThisScan: 0,
};

Deno.test("a marginal expected value is what the budget is for", () => {
  const d = evaluateExploration(base, cfg);
  assertEquals(d.explore, true);
  assertAlmostEquals(d.sizeFraction, 0.33, 1e-9);
});

Deno.test("only the EV threshold may be overridden", () => {
  // Thin depth, a halted account and a kill switch are facts about the market or the
  // operator's instructions. Only the threshold rests on unmeasured coefficients.
  for (const reason of ["thin_ask_depth", "thin_bid_depth", "kill_switch", "daily_loss_limit", "consecutive_losses"]) {
    const d = evaluateExploration({ ...base, blockReason: reason }, cfg);
    assertEquals(d.explore, false, `${reason} must not be overridable`);
    assertEquals(d.sizeFraction, 1);
  }
});

Deno.test("budgets are respected in both dimensions", () => {
  assertEquals(evaluateExploration({ ...base, usedToday: 40 }, cfg).reason, "daily_budget_spent");
  assertEquals(evaluateExploration({ ...base, usedThisScan: 1 }, cfg).reason, "scan_budget_spent");
  assertEquals(evaluateExploration({ ...base, usedToday: 39 }, cfg).explore, true);
});

Deno.test("exploration buys information, not lottery tickets", () => {
  // A candidate far below zero is not an uncertain read, it is a bad one; paying to
  // confirm it teaches nothing the model does not already claim.
  const floor = cfg.minEdgeCostMultiple * base.roundTripCost;
  assertEquals(evaluateExploration({ ...base, expectedNetEdge: floor - 1e-6 }, cfg).reason, "edge_below_exploration_floor");
  assertEquals(evaluateExploration({ ...base, expectedNetEdge: floor + 1e-6 }, cfg).explore, true);
});

Deno.test("a missing edge is never explored", () => {
  assertEquals(evaluateExploration({ ...base, expectedNetEdge: null }, cfg).reason, "edge_unknown");
  assertEquals(evaluateExploration({ ...base, expectedNetEdge: Number.NaN }, cfg).reason, "edge_unknown");
});

Deno.test("the budget can be switched off entirely", () => {
  assertEquals(evaluateExploration(base, { ...cfg, maxPerDay: 0 }).reason, "exploration_disabled");
  assertEquals(evaluateExploration(base, { ...cfg, maxPerScan: 0 }).reason, "exploration_disabled");
});

Deno.test("the tuition is bounded and knowable in advance", () => {
  // "Trade in order to learn" is only defensible when the worst case is stated up front.
  const est = estimateExplorationCost(cfg, 0.0008, 6);
  assertEquals(est.tradesPerDay, 40);
  assertEquals(est.samplesPerDay, 40);
  // 40 trades x 0.08% cost x 1/3 size / 6 slots — well under 0.3% of capital per day.
  assert(est.worstCaseDailyLossFraction < 0.003, `${est.worstCaseDailyLossFraction}`);
  // Smaller size, smaller tuition.
  assert(estimateExplorationCost({ ...cfg, sizeFraction: 0.1 }, 0.0008, 6).worstCaseDailyLossFraction <
    est.worstCaseDailyLossFraction);
});

Deno.test("config clamps hostile overrides", () => {
  const c = resolveExplorationConfig({ maxPerDay: 99999, sizeFraction: 5, minEdgeCostMultiple: 10 });
  assert(c.maxPerDay <= 500);
  assert(c.sizeFraction <= 1);
  assert(c.minEdgeCostMultiple <= 0);
});

// ── v5.10.1: gateway signature expiry ─────────────────────────────────────────
// Mirrors the retry predicate in market-autotrader/index.ts, which cannot be imported
// without a live environment. Keep in sync with RETRYABLE_GATEWAY_ERROR.
const RETRYABLE_GATEWAY_ERROR = /expired gateway request/i;
const AVAILABILITY_FAILURE =
  /gateway\s+(?:5\d\d)|expired gateway request|fetch failed|network|timeout|timed out|abort|econn|enotfound|socket|502|503|504/i;

Deno.test("an expired signature is retried, a replayed nonce is not", () => {
  // A 401 for expiry is rejected at the auth layer before any exchange call, so resending
  // cannot duplicate an order. A replayed nonce means the FIRST attempt got through, so
  // resending it could.
  assert(RETRYABLE_GATEWAY_ERROR.test("gateway 401: expired gateway request"));
  assert(!RETRYABLE_GATEWAY_ERROR.test("gateway 401: nonce already used"));
  assert(!RETRYABLE_GATEWAY_ERROR.test("gateway 401: invalid gateway signature"));
  assert(!RETRYABLE_GATEWAY_ERROR.test("gateway 400: Binance quantity is below LOT_SIZE minimum"));
});

Deno.test("a persistently expiring signature counts as an availability fault", () => {
  // Previously "gateway 401" matched no 5xx pattern, so the cycle threw, logged
  // ENGINE_ERROR_NO_PAUSE and produced nothing — silently, every time.
  assert(AVAILABILITY_FAILURE.test("gateway 401: expired gateway request"));
  assert(AVAILABILITY_FAILURE.test("gateway 503: upstream unavailable"));
  // Genuine rejections must stay out of the connectivity path.
  assert(!AVAILABILITY_FAILURE.test("gateway 400: insufficient balance"));
});
