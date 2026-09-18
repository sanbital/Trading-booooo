import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldFallbackPostOnlyMomentumToIoc } from "./maker-fallback.ts";

const valid = {
  exchange: "binance",
  pattern: "MOMENTUM_CONTINUATION",
  errorMessage: "gateway 400: Order would immediately match and take.",
  convertToTaker: true,
  attemptEvLowerBoundBps: 9.19,
  conditionalEvLowerBoundBps: 20.21,
  spreadBps: 1.55,
  maxSpreadBps: 8,
  candidateAgeMs: 2400,
  hardMaxAgeMs: 120000,
};

Deno.test("deterministic post-only momentum rejection may continue to IOC", () => {
  assertEquals(shouldFallbackPostOnlyMomentumToIoc(valid), true);
});

Deno.test("ambiguous transport or exchange errors never fall back", () => {
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, errorMessage: "gateway timeout" }), false);
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, errorMessage: "insufficient balance" }), false);
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, errorMessage: "order result unknown" }), false);
});

Deno.test("stale, negative-EV, wide-spread or ordinary patterns never fall back", () => {
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, attemptEvLowerBoundBps: 0 }), false);
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, conditionalEvLowerBoundBps: -1 }), false);
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, spreadBps: 9 }), false);
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, candidateAgeMs: 120001 }), false);
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, pattern: "OFI_CONTINUATION" }), false);
  assertEquals(shouldFallbackPostOnlyMomentumToIoc({ ...valid, convertToTaker: false }), false);
});
