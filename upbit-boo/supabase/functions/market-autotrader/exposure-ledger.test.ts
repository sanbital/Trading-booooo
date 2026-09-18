import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateExposureLedger, reservationAfterFill } from "./exposure-ledger.ts";

// Legacy regression coverage retained from the original exposure ledger tests.
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
    initialQuantity: 2,
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

Deno.test("open futures mark uses live price and full entry basis when persisted cost is zero", () => {
  const result = calculateExposureLedger({
    state: "OPEN",
    initialQuantity: 704,
    remainingQuantity: 704,
    averageEntryPrice: 0.2133,
    markPrice: 0.212142755,
    realizedCostQuote: 0,
    realizedProceedsQuote: 0,
    paidFeesQuote: 0,
    estimatedExitCostPct: 0.0005,
  });

  assertAlmostEquals(result.markedCostBasisQuote, 150.1632, 1e-9);
  assertAlmostEquals(result.liquidationValueQuote, 149.34849952, 1e-9);
  assertAlmostEquals(result.markedNetPnlQuote, -0.88937472976, 1e-9);
});

Deno.test("partial futures position keeps original principal in economic PnL", () => {
  const result = calculateExposureLedger({
    state: "OPEN",
    initialQuantity: 100,
    remainingQuantity: 50,
    averageEntryPrice: 1,
    currentPrice: 1.10,
    // Defensive case: a ledger implementation reports only a 50 quote partial basis.
    realizedCostQuote: 50,
    realizedProceedsQuote: 55,
    paidFeesQuote: 0.10,
    estimatedExitCostPct: 0,
  });
  assertEquals(result.markedCostBasisQuote, 100);
  assertAlmostEquals(result.markedNetPnlQuote, 9.9, 1e-12);
});

Deno.test("spot persisted cost basis remains canonical", () => {
  const result = calculateExposureLedger({
    state: "OPEN",
    initialQuantity: 1,
    remainingQuantity: 1,
    averageEntryPrice: 40,
    currentPrice: 41,
    realizedCostQuote: 40,
    realizedProceedsQuote: 0,
    paidFeesQuote: 0.03,
    estimatedExitCostPct: 0.001,
  });
  assertEquals(result.markedCostBasisQuote, 40);
  assertAlmostEquals(result.markedNetPnlQuote, 0.929, 1e-12);
});

Deno.test("currentPrice remains preferred over markPrice for existing callers", () => {
  const result = calculateExposureLedger({
    initialQuantity: 2,
    remainingQuantity: 2,
    averageEntryPrice: 10,
    currentPrice: 11,
    markPrice: 99,
    realizedCostQuote: 20,
  });
  assertEquals(result.liquidationValueQuote, 22);
  assertEquals(result.markedNetPnlQuote, 2);
});
