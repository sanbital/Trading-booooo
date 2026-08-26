import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkS096ShortSignal,
  S096_LIVE_ENTRY_QUALITY_CONFIG,
  type S096PreparedBar,
} from "./s096-short-policy.ts";

function bars(): S096PreparedBar[] {
  const rows = Array.from({ length: 106 }, (): S096PreparedBar => ({
    open: 101,
    high: 102,
    low: 98,
    close: 100,
    atr14: 2,
    rsi14: 50,
    ret24Pct: -2,
    volumeRatio: 1.2,
    quoteVolumeMean20: 600_000,
    efficiency24: 0.2,
  }));
  rows[102].rsi14 = 43;
  rows[103].rsi14 = 42;
  rows[104].rsi14 = 41;
  rows[105].rsi14 = 40;
  return rows;
}

Deno.test("S096 live gate rejects a fresh signal after a >5% three-hour extension", () => {
  const rows = bars();
  rows[102].close = 106;
  assertEquals(checkS096ShortSignal(rows, -0.5), null);
});

Deno.test("S096 live anti-chase thresholds are explicit and research identity remains separate", () => {
  assertEquals(S096_LIVE_ENTRY_QUALITY_CONFIG.minRet3Pct, -5);
  assertEquals(S096_LIVE_ENTRY_QUALITY_CONFIG.minRet6Pct, -8);
  assertEquals(S096_LIVE_ENTRY_QUALITY_CONFIG.minRet12Pct, -12);
  assert(checkS096ShortSignal(bars(), -0.5));
});
