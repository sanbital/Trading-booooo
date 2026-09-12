import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { liveBlockedLobPatterns, preT1ProfitProtectionHit } from "./live-guards.ts";

Deno.test("spot blocks standalone OFI while futures keeps it available", () => {
  assertEquals(liveBlockedLobPatterns("binance"), [
    "MOMENTUM_CONTINUATION",
    "OFI_CONTINUATION",
  ]);
  assertEquals(liveBlockedLobPatterns("binance_futures"), ["MOMENTUM_CONTINUATION"]);
  assertEquals(liveBlockedLobPatterns("upbit"), ["MOMENTUM_CONTINUATION"]);
});

Deno.test("pre-T1 protection triggers only when the executable exit is net profitable", () => {
  assertEquals(
    preT1ProfitProtectionHit({
      hasTradableHalf: true,
      entryPrice: 100,
      executableExitPrice: 101.5,
      protectedStopPrice: 102,
      executableNetAllowed: true,
      executableNetProfitQuote: 0.25,
    }),
    true,
  );
});

Deno.test("pre-T1 protection cannot turn a historical peak into a loss exit", () => {
  assertEquals(
    preT1ProfitProtectionHit({
      hasTradableHalf: true,
      entryPrice: 100,
      executableExitPrice: 98,
      protectedStopPrice: 101,
      executableNetAllowed: false,
      executableNetProfitQuote: -1.25,
    }),
    false,
  );
  assertEquals(
    preT1ProfitProtectionHit({
      hasTradableHalf: true,
      entryPrice: 100,
      executableExitPrice: 100.05,
      protectedStopPrice: 101,
      executableNetAllowed: false,
      executableNetProfitQuote: -0.01,
    }),
    false,
  );
});

Deno.test("pre-T1 protection requires a tradable first half", () => {
  assertEquals(
    preT1ProfitProtectionHit({
      hasTradableHalf: false,
      entryPrice: 100,
      executableExitPrice: 101.5,
      protectedStopPrice: 102,
      executableNetAllowed: true,
      executableNetProfitQuote: 0.25,
    }),
    false,
  );
});
