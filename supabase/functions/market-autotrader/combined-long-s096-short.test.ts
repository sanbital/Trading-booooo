import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { P10_CONFIG, planP10Entry } from "../_shared/p10-policy.ts";
import {
  evaluateS37ShortExit,
  S37_SHORT_REVISION,
  S37_SHORT_STRATEGY_KEY,
} from "../_shared/s37-short-policy.ts";
import {
  evaluateS096ShortExit,
  planS096ShortEntry,
  S096_SHORT_CONFIG,
  S096_SHORT_REVISION,
  S096_SHORT_STRATEGY_KEY,
} from "../_shared/s096-short-policy.ts";

const ROOT = new URL("../../../", import.meta.url);

Deno.test("combined policy preserves LONG and gives S096 its exact SHORT geometry", () => {
  const long = planP10Entry("LONG", 100, 2, 100);
  const short = planS096ShortEntry(100, 2, 100);
  assertEquals(P10_CONFIG.stopAtr, 2);
  assertEquals(P10_CONFIG.targetR, 5);
  assertEquals(P10_CONFIG.partialAtR, 2);
  assertEquals(P10_CONFIG.partialFraction, 0.4);
  assertEquals(P10_CONFIG.breakEvenAtR, 1.5);
  assertEquals(P10_CONFIG.trailAtr, 2.5);
  assertEquals(long.stopPrice, 96);
  assertEquals(long.partialTarget, 108);
  assertEquals(long.finalTarget, 120);
  assertEquals(S096_SHORT_CONFIG.stopAtr, 1.25);
  assertEquals(S096_SHORT_CONFIG.targetR, 1.5);
  assertEquals(short.stopPrice, 102.5);
  assertEquals(short.partialTarget, 96.25);
  assertEquals(short.finalTarget, 96.25);
});

Deno.test("signal producer stamps only S096 shorts with frozen research identity", async () => {
  const source = await Deno.readTextFile(
    new URL("supabase/functions/market-v2-signal/index.ts", ROOT),
  );
  assert(source.includes("selectCombinedLongS096Candidate"));
  assert(source.includes("scenario_number: 96"));
  assert(source.includes('family: "RSI_MOMENTUM"'));
  assert(source.includes("entry_strategy_key: S096_SHORT_STRATEGY_KEY"));
  assert(source.includes("entry_strategy_revision: S096_SHORT_REVISION"));
  assert(source.includes("stopAtr: S096_SHORT_CONFIG.stopAtr"));
  assert(source.includes("targetR: S096_SHORT_CONFIG.targetR"));
  assert(source.includes("partialFraction: 0"));
});

Deno.test("executor accepts exact S096 only and retains both fixed SHORT exits", async () => {
  const source = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );
  assert(source.includes('if (row.side === "SHORT" && !isS096ShortSignal(row)) continue;'));
  assert(source.includes('reason: "market already tracked"'));
  assert(source.includes("positionSlots - active.length"));
  assert(source.includes("evaluateS096ShortExit"));
  assert(source.includes("evaluateS37ShortExit"));
  assert(source.includes("binance_futures_short_enabled === true"));
  assert(source.includes('if (left.side !== right.side) return left.side === "LONG" ? -1 : 1;'));
  assert(source.includes("directional_exit_policy: isS096ShortSignal(signal)"));
  assert(source.includes('? "S096_FIXED_1P5R"'));
  assert(source.includes("!s37Position && !s096Position && shouldLoadCompletedPolicyBar"));
  assert(source.includes("latest: null as ReturnType<typeof prepareP10Bars>[number] | null"));
  assert(source.includes("? resolveFixedShortCurrentStop(position.stop_price"));
});

Deno.test("P10 risk monitoring is concurrent and isolated from slow reconciliation", async () => {
  const source = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );
  assert(source.includes("mapConcurrentOrdered(open"));
  assert(source.includes('monitor_path: "P10_FAST_2S"'));
  assert(source.includes('action: "p10_quotes"'));
  assert(source.includes('action: "p10_portfolio"'));
  assert(source.includes("const p10SlowMaintenanceOwnedByScan = isP10Strategy"));
  assert(source.includes("if (!p10SlowMaintenanceOwnedByScan)"));
  assert(source.includes('owner: "P10_SCAN"'));
  assert(source.includes("P10_SLOW_MAINTENANCE_BATCH_FAILED"));
});

Deno.test("legacy S37 and new S096 exits remain separately executable", () => {
  const common = {
    entryPrice: 100,
    currentStop: 103,
    executablePrice: 97,
    openedAtMs: 0,
    nowMs: 1,
    lastPolicyBarTime: 0,
  };
  assertEquals(evaluateS37ShortExit({ ...common, initialRisk: 3 }).reason, "S37_FIXED_1R");
  assertEquals(
    evaluateS096ShortExit({ ...common, initialRisk: 2 }).reason,
    "S096_FIXED_1P5R",
  );
  assertEquals(S37_SHORT_STRATEGY_KEY, "S37_I46_FIXED_1R_BTC24_BEAR");
  assertEquals(S37_SHORT_REVISION, "S37-LIVE-1.0.0");
  assertEquals(S096_SHORT_STRATEGY_KEY, "S096_RSI_MOMENTUM_FAST");
  assertEquals(S096_SHORT_REVISION, "S096-LIVE-1.0.0");
});

Deno.test("gateway protocol version remains synchronized during strategy cutover", async () => {
  const [engine, scanner, gateway] = await Promise.all([
    Deno.readTextFile(new URL("supabase/functions/market-autotrader/index.ts", ROOT)),
    Deno.readTextFile(new URL("supabase/functions/market-scanner/engine.ts", ROOT)),
    Deno.readTextFile(new URL("gateway/server.mjs", ROOT)),
  ]);
  const engineVersion = engine.match(/const VERSION = "([^"]+)"/)?.[1];
  const scannerVersion = scanner.match(/ENGINE_VERSION = "([^"]+)"/)?.[1];
  const gatewayVersion = gateway.match(/const VERSION = "([^"]+)"/)?.[1];
  assertEquals(engineVersion, scannerVersion);
  assertEquals(engineVersion, gatewayVersion);
});
