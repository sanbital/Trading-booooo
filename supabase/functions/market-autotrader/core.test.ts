import {
  adjustedPlanForFill,
  allocateExitFillToPosition,
  baseAsset,
  BINANCE_MIN_ORDER_USDT,
  binanceMinOrderUsdt,
  calculateManagedCapital,
  calculatePositionSize,
  dangerousControlError,
  decideExit,
  evaluateCircuit,
  externalQuoteIntervention,
  floorToStep,
  manualReconcileAccounting,
  mergeOrderExecutionProgress,
  nextTrailingStop,
  normalizedOrderState,
  pendingBotExitMayExplainBalanceReduction,
  reconcileAccount,
  resumeSafetyError,
  t1SellQuantity,
  type TradingSettings,
} from "./core.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function near(a: number, b: number, tolerance = 1e-8) {
  assert(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
}
/**
 * v6.5 repair: this file used `assertEquals` twenty-one times and never defined or
 * imported it. Every one of those calls is inside the seven reconciliation tests v6.4.0
 * added -- the guards covering the DUST_ALIGN path, the bot's own resting sell being
 * mistaken for a manual lock, and the "unreadable open orders blame nobody" rule. Those
 * are the tests for the two incidents that caused the 8h39m ETH hold and the LTC pause,
 * and they have never once executed: the file throws ReferenceError the moment the first
 * one runs, and `deno task test` -- which CI runs before every deploy -- has been unable
 * to run in the packaging environment since deno.land became unreachable.
 *
 * Defined locally rather than imported so the file keeps its existing zero-dependency
 * shape.
 */
function assertEquals<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(message || `assertEquals failed: ${a} !== ${b}`);
}

const settings: TradingSettings = {
  configured: true,
  mode: "PAPER",
  pause_new_entries: false,
  emergency_liquidation: false,
  upbit_enabled: true,
  binance_enabled: true,
  max_open_positions: 4,
  max_open_positions_per_exchange: 2,
  max_daily_entries: 8,
  max_daily_entries_per_exchange: 4,
  max_position_pct: 5,
  risk_per_trade_pct: 0.5,
  max_order_krw: 100000,
  min_order_krw: 5000,
  max_daily_buy_krw: 300000,
  max_order_usdt: 100,
  min_order_usdt: 10,
  max_daily_buy_usdt: 300,
  upbit_allocation_mode: "ALL",
  upbit_allocation_krw: 0,
  upbit_reserve_krw: 0,
  binance_allocation_mode: "ALL",
  binance_allocation_usdt: 0,
  binance_reserve_usdt: 0,
  withdrawal_mode: false,
  manual_intervention_required: false,
  max_daily_loss_pct: 1.5,
  max_weekly_loss_pct: 3,
  max_consecutive_losses: 3,
  entry_ttl_seconds: 180,
  full_scan_interval_seconds: 300,
  monitor_interval_seconds: 15,
  max_new_entries_per_scan: 2,
  suppress_cross_exchange_same_asset: true,
};

Deno.test("Binance operator minimum is fixed at 90 USDT", () => {
  assertEquals(BINANCE_MIN_ORDER_USDT, 90);
  assertEquals(binanceMinOrderUsdt(5), 90);
  assertEquals(binanceMinOrderUsdt(90), 90);
  assertEquals(binanceMinOrderUsdt(125), 125);
});

Deno.test("generic quote sizing works for KRW and USDT", () => {
  const krw = calculatePositionSize({
    equityQuote: 10_000_000,
    availableQuote: 3_000_000,
    entryPrice: 1000,
    stopPrice: 970,
    maxPositionPct: 5,
    riskPerTradePct: 0.5,
    maxOrderQuote: 100_000,
    minOrderQuote: 5000,
    quoteStep: 1000,
  });
  assert(krw.allowed);
  assert(krw.notionalQuote === 100_000);
  const usdt = calculatePositionSize({
    equityQuote: 2000,
    availableQuote: 500,
    entryPrice: 2,
    stopPrice: 1.94,
    maxPositionPct: 5,
    riskPerTradePct: 0.5,
    maxOrderQuote: 100,
    minOrderQuote: 10,
    quoteStep: 0.01,
  });
  assert(usdt.allowed);
  assert(usdt.notionalQuote <= 100 && usdt.notionalQuote >= 10);
});

Deno.test("managed capital supports full and fixed exchange allocation", () => {
  const all = calculateManagedCapital({
    totalEquityQuote: 1_000_000,
    availableQuote: 600_000,
    openCostQuote: 200_000,
    allocationMode: "ALL",
    fixedAllocationQuote: 0,
    reserveQuote: 100_000,
  });
  assert(all.managedCapitalQuote === 900_000);
  assert(all.managedAvailableQuote === 600_000);
  const fixed = calculateManagedCapital({
    totalEquityQuote: 1_000_000,
    availableQuote: 800_000,
    openCostQuote: 200_000,
    allocationMode: "FIXED",
    fixedAllocationQuote: 500_000,
    reserveQuote: 100_000,
  });
  assert(fixed.managedCapitalQuote === 500_000);
  assert(fixed.managedAvailableQuote === 300_000);
});

Deno.test("invalid stop blocks sizing", () => {
  assert(
    !calculatePositionSize({
      equityQuote: 1000,
      availableQuote: 1000,
      entryPrice: 10,
      stopPrice: 11,
      maxPositionPct: 5,
      riskPerTradePct: 0.5,
      maxOrderQuote: 100,
      minOrderQuote: 10,
    }).allowed,
  );
});

Deno.test("floorToStep handles Binance precision", () => {
  near(floorToStep(1.234567, 0.001), 1.234);
});

Deno.test("exit priority is emergency then stop then targets then time", () => {
  const p = {
    remaining_quantity: 10,
    stop_price: 90,
    target_1: 110,
    target_2: 120,
    t1_completed: false,
    max_holding_at: new Date(Date.now() + 100000).toISOString(),
  };
  assert(decideExit(p, 100, Date.now(), true).action === "EMERGENCY");
  assert(decideExit(p, 89).action === "STOP");
  assert(decideExit(p, 111).action === "TARGET_1");
  assert(decideExit({ ...p, t1_completed: true }, 121).action === "TARGET_2");
});

Deno.test("pre-target profit protection trail is executable", () => {
  const p = {
    remaining_quantity: 10,
    stop_price: 90,
    target_1: 110,
    target_2: 120,
    t1_completed: false,
    trailing_stop: 102,
    max_holding_at: new Date(Date.now() + 100000).toISOString(),
  };
  const protectedExit = decideExit(p, 101);
  assert(protectedExit.action === "TRAIL");
  assert(protectedExit.reason.includes("102"));
  assert(decideExit({ ...p, trailing_stop: 89 }, 91).action === "NONE");
});

Deno.test("circuit enforces global and exchange limits", () => {
  const result = evaluateCircuit({
    mode: "LIVE_LIMITED",
    configured: true,
    exchangeEnabled: true,
    pauseNewEntries: false,
    emergencyLiquidation: false,
    availableQuote: 1000,
    minOrderQuote: 10,
    openPositionsGlobal: 2,
    openPositionsExchange: 2,
    entriesTodayGlobal: 2,
    entriesTodayExchange: 1,
    dailyBoughtQuote: 0,
    maxDailyBuyQuote: 300,
    dailyPnlPct: 0,
    weeklyPnlPct: 0,
    consecutiveLosses: 0,
    settings,
  });
  assert(!result.allowNewEntry);
  assert(result.reasons.some((x) => x.includes("exchange maximum")));
});

Deno.test("fill adjustment preserves percentage structure", () => {
  const p = adjustedPlanForFill(100, 102, 95, 110, 120);
  near(p.stopPrice, 96.9);
  near(p.target1, 112.2);
  near(p.target2 || 0, 122.4);
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
  assert(
    normalizedOrderState("REQUESTED", "PARTIALLY_FILLED_CANCELED") === "EXCHANGE_PARTIAL_CANCELLED",
  );
});

Deno.test("partial-fill cancellation cannot erase previously observed execution", () => {
  const merged = mergeOrderExecutionProgress(
    { executedVolume: 5.70176448, executedFunds: 13245.19888704, averagePrice: 2323 },
    { executedVolume: 5.70176448, executedFunds: 0, averagePrice: 0 },
  );
  near(merged.executedVolume, 5.70176448);
  near(merged.executedFunds, 13245.19888704);
  near(merged.averagePrice, 2323);
});

Deno.test("later cumulative volume uses the retained authoritative average", () => {
  const merged = mergeOrderExecutionProgress(
    { executedVolume: 2, executedFunds: 200, averagePrice: 100 },
    { executedVolume: 3, executedFunds: 0, averagePrice: null },
  );
  assertEquals(merged, { executedVolume: 3, executedFunds: 300, averagePrice: 100 });
});

Deno.test("unapplied resting sell defers manual balance reduction", () => {
  assert(
    pendingBotExitMayExplainBalanceReduction([
      { side: "SELL", state: "EXCHANGE_OPEN", executed_volume: 0 },
    ]),
  );
  assert(
    pendingBotExitMayExplainBalanceReduction([
      { side: "SELL", state: "EXCHANGE_PARTIAL", executed_volume: 8 },
    ]),
  );
  assert(
    pendingBotExitMayExplainBalanceReduction([
      { side: "SELL", state: "EXCHANGE_DONE", executed_volume: 8 },
    ]),
  );
  assert(
    !pendingBotExitMayExplainBalanceReduction([
      { side: "SELL", state: "APPLIED", executed_volume: 8 },
      { side: "SELL", state: "EXCHANGE_CANCELLED", executed_volume: 0 },
    ]),
  );
});

Deno.test("material TP overfill is rejected instead of creating fake profit", () => {
  let message = "";
  try {
    allocateExitFillToPosition({
      remainingQuantity: 336.0183,
      fillQuantity: 1344,
      fillFunds: 26.208,
      fillFeeQuote: 0.026208,
      fillPrice: 0.0195,
      quantityStep: 0.1,
      dustValueQuote: 1,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("materially exceeds remaining position"));
});

Deno.test("dust-sized overfill is prorated across quantity, funds and fee", () => {
  const allocation = allocateExitFillToPosition({
    remainingQuantity: 1595,
    fillQuantity: 1598,
    fillFunds: 25.6479,
    fillFeeQuote: 0.0256479,
    fillPrice: 0.01605,
    quantityStep: 1,
    dustValueQuote: 1,
  });
  near(allocation.positionQuantity, 1595);
  near(allocation.positionFunds, 25.59975);
  near(allocation.positionFeeQuote, 0.02559975);
  near(allocation.unallocatedQuantity, 3);
  near(allocation.unallocatedFunds, 0.04815);
});

Deno.test("dangerous controls require server-side confirmations", () => {
  if (dangerousControlError({ mode: "LIVE_LIMITED" }) == null) {
    throw new Error("LIVE confirmation must be required");
  }
  if (dangerousControlError({ mode: "LIVE_LIMITED", confirmation: "ENABLE_LIVE" }) != null) {
    throw new Error("valid LIVE confirmation rejected");
  }
  if (dangerousControlError({ emergencyLiquidation: true }) == null) {
    throw new Error("emergency confirmation must be required");
  }
  if (
    dangerousControlError({ emergencyLiquidation: true, confirmation: "LIQUIDATE_NOW" }) != null
  ) throw new Error("valid emergency confirmation rejected");
});

Deno.test("external quote changes are recorded without an automatic global pause", () => {
  const increase = externalQuoteIntervention("upbit", 10000, false);
  const decrease = externalQuoteIntervention("binance", -50, false);
  if (
    increase.pauseNewEntries || increase.manualInterventionRequired ||
    !increase.reason.includes("increased")
  ) throw new Error("external increase must remain telemetry only");
  if (
    decrease.pauseNewEntries || decrease.manualInterventionRequired ||
    !decrease.reason.includes("decreased")
  ) throw new Error("external decrease must remain telemetry only");
  const withdrawal = externalQuoteIntervention("upbit", 10000, true);
  if (
    withdrawal.pauseNewEntries || withdrawal.manualInterventionRequired ||
    !withdrawal.reason.startsWith("WITHDRAWAL_MODE")
  ) throw new Error("withdrawal mode classification invalid");
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
  if (result.managedCapitalQuote !== 900_000) {
    throw new Error("manual coin equity must not inflate allocation");
  }
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
  assert(
    resumeSafetyError({
      emergencyLiquidation: false,
      activePositionCount: 0,
      unresolvedManualCount: 1,
    }) !== null,
  );
});

Deno.test("a pause names which condition caused it", () => {
  // "new entries are paused" used to cover operator pause, withdrawal mode and an
  // unresolved account mismatch alike, so the log could not tell the operator which of
  // three different problems they were looking at.
  const base = {
    mode: "LIVE_LIMITED" as const,
    configured: true,
    exchangeEnabled: true,
    emergencyLiquidation: false,
    availableQuote: 1_000_000,
    minOrderQuote: 5000,
    openPositionsGlobal: 0,
    openPositionsExchange: 0,
    entriesTodayGlobal: 0,
    entriesTodayExchange: 0,
    dailyBoughtQuote: 0,
    maxDailyBuyQuote: 1_000_000_000,
    dailyPnlPct: 0,
    weeklyPnlPct: 0,
    consecutiveLosses: 0,
    settings: {
      max_open_positions: 10,
      max_open_positions_per_exchange: 10,
      max_daily_entries: 100,
      max_daily_entries_per_exchange: 100,
      max_daily_loss_pct: 20,
      max_weekly_loss_pct: 100,
      max_consecutive_losses: 100,
    } as any,
  };
  const operator = evaluateCircuit({ ...base, pauseNewEntries: true, pausedByOperator: true });
  assert(operator.reasons.some((r) => r.includes("operator")), operator.reasons.join(" / "));

  const withdrawal = evaluateCircuit({ ...base, pauseNewEntries: true, withdrawalMode: true });
  assert(withdrawal.reasons.some((r) => r.includes("withdrawal")), withdrawal.reasons.join(" / "));

  const manual = evaluateCircuit({
    ...base,
    pauseNewEntries: true,
    manualInterventionRequired: true,
  });
  assert(manual.reasons.some((r) => r.includes("manual account")), manual.reasons.join(" / "));

  // Nothing blocking: entries allowed.
  assert(
    evaluateCircuit({ ...base, pauseNewEntries: false }).allowNewEntry,
    "entries should be allowed",
  );
});

// v6.4 — the two false positives that stopped live trading.

Deno.test("fee dust never pauses an asset", () => {
  // Binance takes the buy commission out of the base asset, so the account holds ~0.1%
  // less than the matched quantity. This is the AVAX/LTC shape.
  const out = reconcileAccount({
    bookedQuantity: 38.55001,
    freeQuantity: 38.51275,
    lockedQuantity: 0,
    botLockedQuantity: 0,
    price: 6.77,
    dustToleranceQuote: 10,
    feePctPerSide: 0.1,
  });
  assertEquals(out.verdict, "DUST_ALIGN");
  assertEquals(out.blockNewEntries, false);
  assertEquals(out.allowExit, true);
});

Deno.test("a difference worth less than the dust threshold is never a manual trade", () => {
  const out = reconcileAccount({
    bookedQuantity: 1,
    freeQuantity: 0.94, // 0.06 missing = 6 USD, under the 10 USD floor
    lockedQuantity: 0,
    botLockedQuantity: 0,
    price: 100,
    dustToleranceQuote: 10,
    feePctPerSide: 0.1,
  });
  assertEquals(out.verdict, "DUST_ALIGN");
  assertEquals(out.blockNewEntries, false);
});

Deno.test("the absolute floor cannot swallow half a position", () => {
  // A 10 USD floor on a 12 USD position would otherwise let the whole thing disappear
  // without anyone noticing.
  const out = reconcileAccount({
    bookedQuantity: 1.2,
    freeQuantity: 0.2,
    lockedQuantity: 0,
    botLockedQuantity: 0,
    price: 10,
    dustToleranceQuote: 10,
    feePctPerSide: 0.1,
  });
  assertEquals(out.verdict, "VANISHED");
  assertEquals(out.blockNewEntries, true);
  assertEquals(out.allowExit, true);
});

Deno.test("the bot's own resting sell is not a manual lock", () => {
  const out = reconcileAccount({
    bookedQuantity: 10,
    freeQuantity: 0,
    lockedQuantity: 10,
    botLockedQuantity: 10, // our own take-profit
    price: 100,
    dustToleranceQuote: 10,
    feePctPerSide: 0.1,
  });
  assertEquals(out.verdict, "MATCH");
  assertEquals(out.blockNewEntries, false);
  assertEquals(out.sellableQuantity, 10);
});

Deno.test("unreadable open orders fail closed for entries but preserve exits", () => {
  const out = reconcileAccount({
    bookedQuantity: 10,
    freeQuantity: 0,
    lockedQuantity: 10,
    botLockedQuantity: null, // the open_orders call failed
    price: 100,
    dustToleranceQuote: 10,
    feePctPerSide: 0.1,
  });
  assertEquals(out.verdict, "UNKNOWN_LOCK");
  assertEquals(out.blockNewEntries, true);
  assertEquals(out.allowExit, true);
  assertEquals(out.sellableQuantity, 0);
});

Deno.test("a real manual sale blocks entries but never blocks the exit", () => {
  // This is the upbit:ETH shape. Entries stop; the remaining position stays exitable.
  const out = reconcileAccount({
    bookedQuantity: 0.0854,
    freeQuantity: 0.02,
    lockedQuantity: 0,
    botLockedQuantity: 0,
    price: 5_000_000,
    dustToleranceQuote: 14000,
    feePctPerSide: 0.05,
  });
  assertEquals(out.verdict, "VANISHED");
  assertEquals(out.blockNewEntries, true);
  assertEquals(out.allowExit, true);
  assertEquals(out.sellableQuantity, 0.02);
});

Deno.test("a user limit order on the coin blocks entries but leaves the free part exitable", () => {
  const out = reconcileAccount({
    bookedQuantity: 10,
    freeQuantity: 4,
    lockedQuantity: 6,
    botLockedQuantity: 0, // the lock is not ours
    price: 100,
    dustToleranceQuote: 10,
    feePctPerSide: 0.1,
  });
  assertEquals(out.verdict, "ASSET_REVIEW");
  assertEquals(out.blockNewEntries, true);
  assertEquals(out.allowExit, true);
  assertEquals(out.sellableQuantity, 4);
});
