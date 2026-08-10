import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { baseAsset, isBinanceFutures, quoteCurrency } from "./core.ts";
import { validateSpotMarket } from "../_shared/spot-market.ts";
import { dustQuoteFor } from "../_shared/position-value.ts";
import { DEFAULT_FUTURES_LEVERAGE, FUTURES_EXIT_APPROVED_REASONS } from "./futures-exit-policy.ts";

const ROOT = new URL("../../../", import.meta.url);
const ENGINE = await Deno.readTextFile(
  new URL("supabase/functions/market-autotrader/index.ts", ROOT),
);
const GATEWAY = await Deno.readTextFile(new URL("gateway/server.mjs", ROOT));
const MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260810010000_binance_futures_lane_v760.sql", ROOT),
);

Deno.test("binance_futures routes like a USDT venue", () => {
  assert(isBinanceFutures("binance_futures"));
  assert(!isBinanceFutures("binance"));
  assertEquals(quoteCurrency("binance_futures"), "USDT");
  assertEquals(baseAsset("binance_futures", "BTCUSDT"), "BTC");
  assertEquals(dustQuoteFor("binance_futures"), 1);

  const route = validateSpotMarket("binance_futures", "BTCUSDT");
  assertEquals(route.ok, true);
  // The perpetual venue does not accept Upbit-shaped markets.
  assertEquals(validateSpotMarket("binance_futures", "KRW-BTC").ok, false);
});

Deno.test("every per-exchange loop walks all three venues", () => {
  // A loop that still hardcodes the two spot venues would silently never monitor,
  // reconcile or report a futures position.
  assertEquals(ENGINE.match(/\["upbit", "binance"\] as Exchange\[\]/g), null);
  assert(
    ENGINE.includes(
      'const ALL_EXCHANGES: readonly Exchange[] = ["upbit", "binance", "binance_futures"]',
    ),
  );
});

Deno.test("the futures lane ships disabled", () => {
  assert(ENGINE.includes("binance_futures_enabled: false"));
  assert(ENGINE.includes(`binance_futures_leverage: DEFAULT_FUTURES_LEVERAGE`));
  assertEquals(DEFAULT_FUTURES_LEVERAGE, 3);
  assert(
    MIGRATION.includes(
      "add column if not exists binance_futures_enabled boolean not null default false",
    ),
  );
});

Deno.test("entry sizing commits margin and the exchange sees margin x leverage", () => {
  assert(
    ENGINE.includes("const notionalQuote = floorToStep(marginQuote * leverage, limits.quoteStep)"),
  );
  // Leverage must be applied to the symbol before an opening order exists.
  assert(ENGINE.includes('leverage: exchange === "binance_futures" ? leverage : undefined'));
});

Deno.test("the exit thresholds are stated on the position's own leverage", () => {
  // Reading it back from settings would close a running position at a leverage it was
  // never opened with.
  assert(ENGINE.includes("const positionLeverageValue = positionLeverage(position)"));
  assert(ENGINE.includes("leverage: positionLeverageValue"));
  assert(ENGINE.includes("futuresSplitExitDecision({"));
  assert(ENGINE.includes("futuresRecoveryLatched({"));
});

Deno.test("every futures exit reason is authorized end to end", () => {
  for (const reason of FUTURES_EXIT_APPROVED_REASONS) {
    assert(
      ENGINE.includes(`decision.reason === "${reason}"`) ||
        ENGINE.includes(`decisionReason === "${reason}"`),
      `${reason} is not on an engine allow list`,
    );
  }
  // The two that liquidate the protected half must also clear the database guard.
  assert(MIGRATION.includes("FUTURES_RECOVERY_NET_POSITIVE_EXIT"));
  assert(MIGRATION.includes("FUTURES_RESIDUAL_ROE_NOT_REACHED"));
  assert(MIGRATION.includes("FUTURES_FIRST_TRANCHE_ROE_NOT_REACHED"));
});

Deno.test("the spot lane's own thresholds are untouched", () => {
  // The whole point of the futures work is that it is additive. If any of these moved,
  // the spot lane changed behaviour and this test is the tripwire.
  assert(ENGINE.includes("halfHoldRecoveryExitDecision({"));
  assert(MIGRATION.includes("v_net_return_pct < 9.999 and v_net_return_pct > -3.999"));
  assert(MIGRATION.includes("v_gross_return_pct < 4.999 and v_gross_return_pct > -3.999"));
  assert(MIGRATION.includes("RECOVERY_TOTAL_NET_NOT_POSITIVE"));
});

Deno.test("the gateway can close a futures long and can never open a short", () => {
  assert(GATEWAY.includes('if (dualPositionSide) order.positionSide = "LONG";'));
  assert(GATEWAY.includes('else if (side === "SELL") order.reduceOnly = "true";'));
  assert(
    GATEWAY.includes('throw new Error("Binance futures market orders are restricted to sells")'),
  );
  // No wallet movement routes were added with the futures venue.
  assert(!GATEWAY.includes("/sapi/v1/futures/transfer"));
  assert(!GATEWAY.includes("/sapi/v1/capital/withdraw"));
});

Deno.test("futures positions are quoted and monitored on the perpetual venue", () => {
  assert(GATEWAY.includes('publicBinanceFutures("/fapi/v1/depth"'));
  assert(GATEWAY.includes('publicBinanceFutures("/fapi/v1/ticker/bookTicker"'));
  const minuteMarket = Deno.readTextFileSync(
    new URL("supabase/functions/_shared/lob/minute-entry-market.ts", ROOT),
  );
  assert(minuteMarket.includes("BINANCE_FUTURES}/fapi/v1/klines"));
});
