import { futuresShortEntryBlockReason, futuresShortLiveEnabled } from "./futures-short-safety.ts";
import { assert, assertEquals } from "../../../test-support/assert.ts";

Deno.test("futures SHORT live entry is default-off and exact-opt-in only", () => {
  for (const value of [undefined, null, "", "false", "1", "yes", true]) {
    assert(!futuresShortLiveEnabled(value));
    assertEquals(
      futuresShortEntryBlockReason("binance_futures", "SHORT", value),
      "BINANCE_FUTURES_SHORT_LIVE_DISABLED",
    );
  }
  assert(futuresShortLiveEnabled(" true "));
  assertEquals(futuresShortEntryBlockReason("binance_futures", "SHORT", "true"), null);
});

Deno.test("default-off SHORT gate never blocks LONG or spot", () => {
  assertEquals(futuresShortEntryBlockReason("binance_futures", "LONG", undefined), null);
  assertEquals(futuresShortEntryBlockReason("binance", "SHORT", undefined), null);
  assertEquals(futuresShortEntryBlockReason("upbit", "SHORT", undefined), null);
});
