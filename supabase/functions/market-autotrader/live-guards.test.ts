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

Deno.test("pre-T1 protection only triggers on an earned positive floor", () => {
  assertEquals(
    preT1ProfitProtectionHit({
      hasTradableHalf: true,
      entryPrice: 100,
      executableExitPrice: 101.5,
      protectedStopPrice: 102,
    }),
    true,
  );
  assertEquals(
    preT1ProfitProtectionHit({
      hasTradableHalf: true,
      entryPrice: 100,
      executableExitPrice: 98,
      protectedStopPrice: 99,
    }),
    false,
  );
  assertEquals(
    preT1ProfitProtectionHit({
      hasTradableHalf: false,
      entryPrice: 100,
      executableExitPrice: 101.5,
      protectedStopPrice: 102,
    }),
    false,
  );
});
