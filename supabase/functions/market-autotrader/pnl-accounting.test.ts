import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  openPositionPnl,
  resolveMarkPrice,
  resolvePositionSide,
  sumOpenPositionPnl,
} from "./pnl-accounting.ts";

// The defect this file exists for: a position that had already taken its partial profit
// reported that profit again as unrealised, so the dashboard and the exchange disagreed by
// the whole realized amount.
Deno.test("partial take profit never leaks into pure unrealized PnL", () => {
  const pnl = openPositionPnl({
    positionSide: "LONG",
    averageEntryPrice: 100,
    remainingQuantity: 6,
    markPrice: 110,
    realizedPnlQuote: 40,
  });
  assertEquals(pnl.pureUnrealizedPnlQuote, 60);
  assertEquals(pnl.realizedPnlQuote, 40);
  // 140 is the number the old snapshot path could produce by adding realized proceeds to
  // the marked remainder. It is never the unrealised figure.
  assertEquals(pnl.pureUnrealizedPnlQuote === 140, false);
});

Deno.test("lifecycle PnL is the only place partial realized and unrealized are summed", () => {
  const pnl = openPositionPnl({
    positionSide: "LONG",
    averageEntryPrice: 100,
    remainingQuantity: 6,
    markPrice: 110,
    realizedPnlQuote: 40,
  });
  assertEquals(pnl.lifecyclePnlQuote, 100);
  assertEquals(pnl.lifecyclePnlQuote - pnl.realizedPnlQuote, pnl.pureUnrealizedPnlQuote);
});

Deno.test("SHORT unrealized is sign-corrected against the mark", () => {
  const short = openPositionPnl({
    positionSide: "SHORT",
    averageEntryPrice: 100,
    remainingQuantity: 5,
    markPrice: 90,
  });
  assertEquals(short.pureUnrealizedPnlQuote, 50);
  const losing = openPositionPnl({
    positionSide: "SHORT",
    averageEntryPrice: 100,
    remainingQuantity: 5,
    markPrice: 110,
  });
  assertEquals(losing.pureUnrealizedPnlQuote, -50);
});

Deno.test("unrealized is measured on remaining quantity, never on the initial size", () => {
  const pnl = openPositionPnl({
    positionSide: "LONG",
    averageEntryPrice: 36.06,
    remainingQuantity: 9.929,
    markPrice: 38.43,
    realizedPnlQuote: 18.7483506,
  });
  assertAlmostEquals(pnl.pureUnrealizedPnlQuote, 23.531730, 1e-6);
  assertAlmostEquals(pnl.lifecyclePnlQuote, 42.280081, 1e-6);
});

Deno.test("a missing mark reports flat rather than inventing a move", () => {
  const pnl = openPositionPnl({
    positionSide: "LONG",
    averageEntryPrice: 50,
    remainingQuantity: 3,
    markPrice: 0,
    realizedPnlQuote: 12,
  });
  assertEquals(pnl.markPrice, 50);
  assertEquals(pnl.pureUnrealizedPnlQuote, 0);
  assertEquals(pnl.lifecyclePnlQuote, 12);
});

Deno.test("mark price resolution prefers the freshest quote and falls back to entry", () => {
  assertEquals(resolveMarkPrice([12, 11], 10), 12);
  assertEquals(resolveMarkPrice([null, 11], 10), 11);
  assertEquals(resolveMarkPrice([0, undefined, NaN], 10), 10);
  assertEquals(resolvePositionSide("short"), "SHORT");
  assertEquals(resolvePositionSide(null), "LONG");
});

Deno.test("exit cost is reported separately from the unrealized figure", () => {
  const pnl = openPositionPnl({
    positionSide: "LONG",
    averageEntryPrice: 100,
    remainingQuantity: 6,
    markPrice: 110,
    estimatedExitCostPct: 0.0005,
  });
  assertEquals(pnl.pureUnrealizedPnlQuote, 60);
  assertAlmostEquals(pnl.estimatedExitCostQuote, 0.33, 1e-12);
  assertAlmostEquals(pnl.netUnrealizedPnlQuote, 59.67, 1e-12);
});

Deno.test("portfolio totals keep the three PnL meanings separated", () => {
  const totals = sumOpenPositionPnl([
    {
      positionSide: "LONG",
      averageEntryPrice: 36.06,
      remainingQuantity: 9.929,
      markPrice: 38.43,
      realizedPnlQuote: 18.7483506,
    },
    {
      positionSide: "LONG",
      averageEntryPrice: 5.190121716287214,
      remainingQuantity: 114.2,
      markPrice: 5.231,
      realizedPnlQuote: 0,
    },
  ]);
  assertEquals(totals.positions, 2);
  assertAlmostEquals(totals.pureUnrealizedPnlQuote, 28.20003, 1e-5);
  assertAlmostEquals(totals.realizedPnlQuote, 18.748351, 1e-6);
  assertAlmostEquals(
    totals.lifecyclePnlQuote,
    totals.pureUnrealizedPnlQuote + totals.realizedPnlQuote,
    1e-9,
  );
});
