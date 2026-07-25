import {
  adjustedPlanForFill,
  baseAsset,
  calculateManagedCapital,
  calculatePositionSize,
  decideExit,
  dangerousControlError,
  evaluateCircuit,
  externalQuoteIntervention,
  floorToStep,
  manualReconcileAccounting,
  nextTrailingStop,
  resumeSafetyError,
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
  upbit_allocation_mode: "ALL", upbit_allocation_krw: 0, upbit_reserve_krw: 0,
  binance_allocation_mode: "ALL", binance_allocation_usdt: 0, binance_reserve_usdt: 0,
  withdrawal_mode: false, manual_intervention_required: false,
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


Deno.test("managed capital supports full and fixed exchange allocation", () => {
  const all = calculateManagedCapital({ totalEquityQuote: 1_000_000, availableQuote: 600_000, openCostQuote: 200_000, allocationMode: "ALL", fixedAllocationQuote: 0, reserveQuote: 100_000 });
  assert(all.managedCapitalQuote === 900_000);
  assert(all.managedAvailableQuote === 600_000);
  const fixed = calculateManagedCapital({ totalEquityQuote: 1_000_000, availableQuote: 800_000, openCostQuote: 200_000, allocationMode: "FIXED", fixedAllocationQuote: 500_000, reserveQuote: 100_000 });
  assert(fixed.managedCapitalQuote === 500_000);
  assert(fixed.managedAvailableQuote === 300_000);
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


Deno.test("dangerous controls require server-side confirmations", () => {
  if (dangerousControlError({ mode: "LIVE_LIMITED" }) == null) throw new Error("LIVE confirmation must be required");
  if (dangerousControlError({ mode: "LIVE_LIMITED", confirmation: "ENABLE_LIVE" }) != null) throw new Error("valid LIVE confirmation rejected");
  if (dangerousControlError({ emergencyLiquidation: true }) == null) throw new Error("emergency confirmation must be required");
  if (dangerousControlError({ emergencyLiquidation: true, confirmation: "LIQUIDATE_NOW" }) != null) throw new Error("valid emergency confirmation rejected");
});

Deno.test("external quote increases and decreases both pause new entries", () => {
  const increase = externalQuoteIntervention("upbit", 10000, false);
  const decrease = externalQuoteIntervention("binance", -50, false);
  if (!increase.pauseNewEntries || !increase.manualInterventionRequired || !increase.reason.includes("increased")) throw new Error("external increase must pause");
  if (!decrease.pauseNewEntries || !decrease.manualInterventionRequired || !decrease.reason.includes("decreased")) throw new Error("external decrease must pause");
  const withdrawal = externalQuoteIntervention("upbit", 10000, true);
  if (!withdrawal.pauseNewEntries || withdrawal.manualInterventionRequired || !withdrawal.reason.startsWith("WITHDRAWAL_MODE")) throw new Error("withdrawal mode classification invalid");
});


Deno.test("quote-currency capital base excludes unrelated manual coin equity", () => {
  const result = calculateManagedCapital({
    totalEquityQuote: 11_000_000,
    capitalBaseQuote: 1_000_000,
    availableQuote: 1_000_000,
    openCostQuote: 0,
    allocationMode: "ALL",
    fixedAllocationQuote: 0,
    reserveQuote: 100_000,
  });
  if (result.capitalBaseQuote !== 1_000_000) throw new Error("quote capital base mismatch");
  if (result.managedCapitalQuote !== 900_000) throw new Error("manual coin equity must not inflate allocation");
});

Deno.test("manual reconciliation resets prior bot proceeds and keeps only remaining entry basis", () => {
  const accounting = manualReconcileAccounting({
    initialQuantity: 10,
    actualQuantity: 3,
    originalEntryCostQuote: 1_000,
    originalEntryFeeQuote: 1,
  });
  near(accounting.remainingRatio, 0.3);
  near(accounting.remainingCostQuote, 300);
  near(accounting.remainingEntryFeeQuote, 0.3);
  assert(accounting.realizedProceedsQuote === 0);
  assert(accounting.realizedPnlQuote === 0);
});

Deno.test("fixed allocation has no free capacity when current bot exposure exceeds the cap", () => {
  const managed = calculateManagedCapital({
    capitalBaseQuote: 800_000,
    availableQuote: 200_000,
    openCostQuote: 600_000,
    allocationMode: "FIXED",
    fixedAllocationQuote: 500_000,
    reserveQuote: 0,
  });
  assert(managed.managedCapitalQuote === 500_000);
  assert(managed.managedAvailableQuote === 0);
});

Deno.test("resume cannot cancel an unfinished emergency liquidation", () => {
  assert(resumeSafetyError({ emergencyLiquidation: true, activePositionCount: 1 }) !== null);
  assert(resumeSafetyError({ emergencyLiquidation: true, activePositionCount: 0 }) === null);
  assert(resumeSafetyError({ emergencyLiquidation: false, activePositionCount: 5 }) === null);
  assert(resumeSafetyError({ emergencyLiquidation: false, activePositionCount: 0, unresolvedManualCount: 1 }) !== null);
});
