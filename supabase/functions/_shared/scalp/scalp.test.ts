import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateEdge, simulateFill, DEFAULT_COST_MODEL, type EdgeInputs } from "./cost-model.ts";
import { evaluateEntryGate, applyClose, scalpOrderCap, DEFAULT_SCALP_SAFETY } from "./safety.ts";

const deepAsk = [
  { price: 100.0, size: 1000 },
  { price: 100.1, size: 1000 },
  { price: 100.2, size: 1000 },
];
const deepBid = [
  { price: 99.9, size: 1000 },
  { price: 99.8, size: 1000 },
  { price: 99.7, size: 1000 },
];

Deno.test("simulateFill: small order barely moves avg price", () => {
  const r = simulateFill(deepAsk, 1000); // ~10 units at 100
  assert(r.fillable);
  assertAlmostEquals(r.avgPrice, 100.0, 0.05);
  assert(r.consumedFraction < 0.01);
});

Deno.test("simulateFill: order exceeding total depth is not fillable", () => {
  const r = simulateFill(deepAsk, 10_000_000);
  assertEquals(r.fillable, false);
});

Deno.test("GPT example is correctly rejected: +0.4/-0.3, pWin 0.60 => negative EV", () => {
  const inputs: EdgeInputs = {
    pWin: 0.60, expectedProfit: 0.004, expectedLoss: 0.003,
    askLevels: deepAsk, bidLevels: deepBid, notional: 1000, bestAsk: 100.0, bestBid: 99.9,
  };
  const r = evaluateEdge(inputs, DEFAULT_COST_MODEL);
  // gross = 0.60*0.004 - 0.40*0.003 = 0.0012 ; minus ~0.001 fees minus slippage => below minimumEdge
  assertEquals(r.enter, false);
  assert(r.expectedNetEdge < DEFAULT_COST_MODEL.minimumEdge);
});

Deno.test("A genuinely strong edge passes", () => {
  const inputs: EdgeInputs = {
    pWin: 0.70, expectedProfit: 0.008, expectedLoss: 0.003,
    askLevels: deepAsk, bidLevels: deepBid, notional: 1000, bestAsk: 100.0, bestBid: 99.9,
  };
  const r = evaluateEdge(inputs, DEFAULT_COST_MODEL);
  // gross = 0.70*0.008 - 0.30*0.003 = 0.0047 ; comfortably clears fees+slippage+minEdge
  assertEquals(r.enter, true);
});

Deno.test("Thin ask depth forces a skip regardless of edge", () => {
  const thinAsk = [{ price: 100.0, size: 1 }];
  const inputs: EdgeInputs = {
    pWin: 0.9, expectedProfit: 0.02, expectedLoss: 0.003,
    askLevels: thinAsk, bidLevels: deepBid, notional: 100000, bestAsk: 100.0, bestBid: 99.9,
  };
  const r = evaluateEdge(inputs, DEFAULT_COST_MODEL);
  assertEquals(r.enter, false);
  assertEquals(r.skipReason, "thin_ask_depth");
});

Deno.test("scalpOrderCap follows the full operator allocation", () => {
  assertAlmostEquals(scalpOrderCap(1_000_000, DEFAULT_SCALP_SAFETY), 1_000_000, 1e-6);
});

Deno.test("entry gate adds no hidden cap inside the operator allocation", () => {
  const r = evaluateEntryGate(
    { capitalQuote: 1_000_000, requestedNotional: 500_000, day: { realizedPnlQuote: 0, consecutiveLosses: 0 } },
    DEFAULT_SCALP_SAFETY,
  );
  assert(r.allow);
  assertAlmostEquals(r.cappedNotional, 500_000, 1e-6);
});

Deno.test("daily loss limit halts entries", () => {
  const r = evaluateEntryGate(
    { capitalQuote: 1_000_000, requestedNotional: 50_000, day: { realizedPnlQuote: -200_000, consecutiveLosses: 0 } },
    DEFAULT_SCALP_SAFETY,
  );
  assertEquals(r.allow, false);
  assertEquals(r.haltReason, "daily_loss_limit");
});

Deno.test("consecutive losses halt entries", () => {
  const r = evaluateEntryGate(
    { capitalQuote: 1_000_000, requestedNotional: 50_000, day: { realizedPnlQuote: -1000, consecutiveLosses: 4 } },
    { ...DEFAULT_SCALP_SAFETY, maxConsecutiveLosses: 4 },
  );
  assertEquals(r.allow, false);
  assertEquals(r.haltReason, "consecutive_losses");
});

Deno.test("kill switch halts everything", () => {
  const r = evaluateEntryGate(
    { capitalQuote: 1_000_000, requestedNotional: 50_000, day: { realizedPnlQuote: 0, consecutiveLosses: 0 } },
    { ...DEFAULT_SCALP_SAFETY, killSwitch: true },
  );
  assertEquals(r.allow, false);
  assertEquals(r.haltReason, "kill_switch");
});

Deno.test("applyClose tracks streak and pnl", () => {
  let d = { realizedPnlQuote: 0, consecutiveLosses: 0 };
  d = applyClose(d, -100); assertEquals(d.consecutiveLosses, 1);
  d = applyClose(d, -50);  assertEquals(d.consecutiveLosses, 2);
  d = applyClose(d, 200);  assertEquals(d.consecutiveLosses, 0);
  assertAlmostEquals(d.realizedPnlQuote, 50, 1e-6);
});
