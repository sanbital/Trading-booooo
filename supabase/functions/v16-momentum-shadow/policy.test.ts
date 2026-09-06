import { exitProfile, microDecision, regimeModifier, summarizeTemporalBooks } from "./policy.ts";

Deno.test("regime never gates opportunity discovery", () => {
  if (regimeModifier("BULL") !== "WIDE") throw new Error("BULL modifier");
  if (regimeModifier("NEUTRAL") !== "MEDIUM") throw new Error("NEUTRAL modifier");
  if (regimeModifier("RISK_OFF") !== "TIGHT") throw new Error("RISK_OFF modifier");
  if (!(exitProfile("WIDE").giveback > exitProfile("MEDIUM").giveback)) throw new Error("wide trail");
  if (!(exitProfile("TIGHT").giveback < exitProfile("MEDIUM").giveback)) throw new Error("tight trail");
});

Deno.test("primary pullback breakout can become entry ready", () => {
  const books = [
    { bids:[[100,10],[99.99,20]], asks:[[100.01,5],[100.02,20]] },
    { bids:[[100,12],[99.99,20]], asks:[[100.01,4],[100.02,18]] },
    { bids:[[100,15],[99.99,20]], asks:[[100.01,3],[100.02,15]] },
  ];
  const book = summarizeTemporalBooks(books, 120);
  const stage = { state:"BREAKOUT_RECLAIM", score:70, metrics:{ takerBuyShare:.60, qvRatio:2, upperWick:.1, closeLocation:.8, absorptionRisk:false, antiChaseAtr:.5 } };
  const d = microDecision(stage, .02, book, .03, 62, 8, 8);
  if (!d.entryReady) throw new Error("expected primary entry");
  const direct = microDecision({ ...stage, state:"DIRECT_BREAKOUT" }, .02, book, .03, 62, 8, 8);
  if (direct.entryReady) throw new Error("direct breakout must remain secondary");
});