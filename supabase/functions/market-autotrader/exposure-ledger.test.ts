import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateExposureLedger } from "./exposure-ledger.ts";

Deno.test("open futures mark uses markPrice and filled entry basis when realized cost is zero", () => {
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
