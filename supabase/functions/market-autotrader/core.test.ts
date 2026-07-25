import {
  adjustedPlanForFill,
  baseAsset,
  calculatePositionSize,
  decideExit,
  evaluateCircuit,
  floorToStep,
  nextTrailingStop,
  normalizedOrderState,
  t1SellQuantity,
  type TradingSettings,
} from "./core.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function near(a: number, b: number, tolerance = 1e-8) { assert(Math.abs(a - b) <= tolerance, `${a} != ${b}`); }

const settings: TradingSettings = {
  configured: true, mode: "PAPER", pause_new_entries: false, emergency_liquidation: false,
  upbit_enabled: true, binance_enabled: true,
  max_open_positions: 4, max_open_positions_per_exchange: 2,
  max_daily_entries: 8, max_daily_entries_per_exchange: 4,
  max_position_pct: 5, risk_per_trade_pct: 0.5,
  max_order_krw: 100000, min_order_krw: 5000, max_daily_buy_krw: 300000,
  max_order_usdt: 100, min_order_usdt: 10, max_daily_buy_usdt: 300,
  max_daily_loss_pct: 1.5, max_weekly_loss_pct: 3, max_consecutive_losses: 3,
  entry_ttl_seconds: 180, full_scan_interval_seconds: 300, monitor_interval_seconds: 15,
  max_new_entries_per_scan: 2, suppress_cross_exchange_same_asset: true,
};

Deno.test("generic quote sizing works for KRW and USDT", () => {
  const krw = calculatePositionSize({
    equityQuote: 10_000_000, availableQuote: 3_000_000, entryPrice: 1000, stopPrice: 970,
    maxPositionPct: 5, riskPerTradePct: 0.5, maxOrderQuote: 100_000, minOrderQuote: 5000, quoteStep: 1000,
  });
  assert(krw.allowed); assert(krw.notionalQuote === 100_000);
  const usdt = calculatePositionSize({
    equityQuote: 2000, availableQuote: 500, entryPrice: 2, stopPrice: 1.94,
    maxPositionPct: 5, riskPerTradePct: 0.5, maxOrderQuote: 100, minOrderQuote: 10, quoteStep: 0.01,
  });
  assert(usdt.allowed); assert(usdt.notionalQuote <= 100 && usdt.notionalQuote >= 10);
});

Deno.test("invalid stop blocks sizing", () => {
  assert(!calculatePositionSize({ equityQuote: 1000, availableQuote: 1000, entryPrice: 10, stopPrice: 11,
    maxPositionPct: 5, riskPerTradePct: 0.5, maxOrderQuote: 100, minOrderQuote: 10 }).allowed);
});

Deno.test("floorToStep handles Binance precision", () => {
  near(floorToStep(1.234567, 0.001), 1.234);
});

Deno.test("exit priority is emergency then stop then targets then time", () => {
  const p = { remaining_quantity: 10, stop_price: 90, target_1: 110, target_2: 120, t1_completed: false, max_holding_at: new Date(Date.now() + 100000).toISOString() };
  assert(decideExit(p, 100, Date.now(), true).action === "EMERGENCY");
  assert(decideExit(p, 89).action === "STOP");
  assert(decideExit(p, 111).action === "TARGET_1");
  assert(decideExit({ ...p, t1_completed: true }, 121).action === "TARGET_2");
});

Deno.test("circuit enforces global and exchange limits", () => {
  const result = evaluateCircuit({
    mode: "LIVE_LIMITED", configured: true, exchangeEnabled: true, pauseNewEntries: false,
    emergencyLiquidation: false, availableQuote: 1000, minOrderQuote: 10,
    openPositionsGlobal: 2, openPositionsExchange: 2, entriesTodayGlobal: 2, entriesTodayExchange: 1,
    dailyBoughtQuote: 0, maxDailyBuyQuote: 300,
    dailyPnlPct: 0, weeklyPnlPct: 0, consecutiveLosses: 0, settings,
  });
  assert(!result.allowNewEntry); assert(result.reasons.some((x) => x.includes("exchange maximum")));
});

Deno.test("fill adjustment preserves percentage structure", () => {
  const p = adjustedPlanForFill(100, 102, 95, 110, 120);
  near(p.stopPrice, 96.9); near(p.target1, 112.2); near(p.target2 || 0, 122.4);
});

Deno.test("partial sell and trail are bounded", () => {
  near(t1SellQuantity(10, 8, 60), 6);
  assert(nextTrailingStop(100, 120, 10, 90) === 108);
});

Deno.test("market base normalization prevents cross-exchange duplicate exposure", () => {
  assert(baseAsset("upbit", "KRW-ETH") === "ETH");
  assert(baseAsset("binance", "ETHUSDT") === "ETH");
});

Deno.test("gateway order status mapping is idempotent", () => {
  assert(normalizedOrderState("REQUESTED", "FILLED") === "EXCHANGE_DONE");
  assert(normalizedOrderState("APPLIED", "OPEN") === "APPLIED");
  assert(normalizedOrderState("REQUESTED", "PARTIALLY_FILLED_CANCELED") === "EXCHANGE_PARTIAL_CANCELLED");
});
