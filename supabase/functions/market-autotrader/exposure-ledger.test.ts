import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateExposureLedger, reservationAfterFill } from "./exposure-ledger.ts";

Deno.test("pending maker reservation consumes exposure before it fills", () => {
  const out = calculateExposureLedger({
    state: "ENTRY_PENDING",
    reservedQuote: 100,
    reservedQuantity: 1,
    plannedEntryPrice: 100,
    currentPrice: 101,
  });
  assertEquals(out.filledExposureQuote, 0);
  assertEquals(out.reservedExposureQuote, 101);
  assertEquals(out.totalExposureQuote, 101);
});

Deno.test("winning open position cannot manufacture free allocation", () => {
  const out = calculateExposureLedger({
    state: "OPEN",
    remainingQuantity: 2,
    averageEntryPrice: 100,
    currentPrice: 120,
    realizedCostQuote: 200,
    paidFeesQuote: 0.2,
    estimatedExitCostPct: 0.001,
  });
  assertEquals(out.filledExposureQuote, 240);
  assertAlmostEquals(out.markedNetPnlQuote, 39.56, 1e-12);
});

Deno.test("partial fill releases only the executed reservation", () => {
  assertEquals(reservationAfterFill(100, 10, 40, 4), {
    reservedQuote: 60,
    reservedQuantity: 6,
  });
});
