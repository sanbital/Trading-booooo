import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateExitResidualAccounting } from "./core.ts";

Deno.test("BNB one-step exit dust is closed but retained as economic value", () => {
  const out = calculateExitResidualAccounting({
    remainingQuantity: 0.071,
    soldQuantity: 0.07,
    baseFeeQuantity: 0.0000525,
    markPrice: 573.2,
    dustValueQuote: 1,
  });
  assertEquals(out.closeAsDust, true);
  assertAlmostEquals(out.residualQuantity, 0.0009475, 1e-12);
  assertAlmostEquals(out.residualValueQuote, 0.543107, 1e-6);
  assertEquals(out.nextRemainingQuantity, 0);
});

Deno.test("ETH quote-fee exit keeps one step as marked residual", () => {
  const out = calculateExitResidualAccounting({
    remainingQuantity: 0.0209,
    soldQuantity: 0.0208,
    baseFeeQuantity: 0,
    markPrice: 1958.19,
    dustValueQuote: 1,
  });
  assertEquals(out.closeAsDust, true);
  assertAlmostEquals(out.residualQuantity, 0.0001, 1e-12);
  assertAlmostEquals(out.residualValueQuote, 0.195819, 1e-9);
});

Deno.test("a material remainder stays open and is not booked as residual", () => {
  const out = calculateExitResidualAccounting({
    remainingQuantity: 1,
    soldQuantity: 0.5,
    baseFeeQuantity: 0,
    markPrice: 100,
    dustValueQuote: 1,
  });
  assertEquals(out.closeAsDust, false);
  assertAlmostEquals(out.nextRemainingQuantity, 0.5, 1e-12);
  assertEquals(out.residualQuantity, 0);
  assertEquals(out.residualValueQuote, 0);
});

Deno.test("base fee cannot consume more than the post-sale remainder", () => {
  const out = calculateExitResidualAccounting({
    remainingQuantity: 0.001,
    soldQuantity: 0.0009,
    baseFeeQuantity: 0.01,
    markPrice: 500,
    dustValueQuote: 1,
  });
  assertAlmostEquals(out.baseFeeQuantity, 0.0001, 1e-12);
  assertEquals(out.physicalRemainingQuantity, 0);
  assertEquals(out.residualValueQuote, 0);
});
