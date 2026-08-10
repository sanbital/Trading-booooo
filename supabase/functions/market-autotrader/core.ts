export type TradingMode = "PAUSED" | "PAPER" | "LIVE_LIMITED";
/** `binance_futures` is the Binance USDⓈ-M perpetual venue; it quotes in USDT like spot. */
export type Exchange = "upbit" | "binance" | "binance_futures";

export function isBinanceFutures(exchange: unknown): boolean {
  return exchange === "binance_futures";
}
export const BINANCE_MIN_ORDER_USDT = 40;

export type TradingSettings = {
  configured: boolean;
  mode: TradingMode;
  pause_new_entries: boolean;
  emergency_liquidation: boolean;
  upbit_enabled: boolean;
  binance_enabled: boolean;
  max_open_positions: number;
  max_open_positions_per_exchange: number;
  max_daily_entries: number;
  max_daily_entries_per_exchange: number;
  max_position_pct: number;
  risk_per_trade_pct: number;
  max_order_krw: number;
  min_order_krw: number;
  max_daily_buy_krw: number;
  max_order_usdt: number;
  min_order_usdt: number;
  max_daily_buy_usdt: number;
  upbit_allocation_mode: "ALL" | "FIXED";
  upbit_allocation_krw: number;
  upbit_reserve_krw: number;
  binance_allocation_mode: "ALL" | "FIXED";
  binance_allocation_usdt: number;
  binance_reserve_usdt: number;
  withdrawal_mode: boolean;
  manual_intervention_required: boolean;
  max_daily_loss_pct: number;
  max_weekly_loss_pct: number;
  max_consecutive_losses: number;
  entry_ttl_seconds: number;
  full_scan_interval_seconds: number;
  monitor_interval_seconds: number;
  max_new_entries_per_scan: number;
  suppress_cross_exchange_same_asset: boolean;
};

export type ManagedCapitalInput = {
  totalEquityQuote?: number;
  capitalBaseQuote?: number;
  availableQuote: number;
  openCostQuote: number;
  allocationMode: "ALL" | "FIXED";
  fixedAllocationQuote: number;
  reserveQuote: number;
};

export type ManagedCapitalResult = {
  capitalBaseQuote: number;
  managedCapitalQuote: number;
  managedAvailableQuote: number;
  protectedReserveQuote: number;
  openCostQuote: number;
  allocationMode: "ALL" | "FIXED";
};

export function calculateManagedCapital(input: ManagedCapitalInput): ManagedCapitalResult {
  const capitalBase = Math.max(0, finite(input.capitalBaseQuote, finite(input.totalEquityQuote)));
  const available = Math.max(0, finite(input.availableQuote));
  const openCost = Math.max(0, finite(input.openCostQuote));
  const reserve = clamp(finite(input.reserveQuote), 0, capitalBase);
  const usableEquity = Math.max(0, capitalBase - reserve);
  const mode = input.allocationMode === "FIXED" ? "FIXED" : "ALL";
  const requested = mode === "FIXED"
    ? Math.max(0, finite(input.fixedAllocationQuote))
    : usableEquity;
  const managedCapital = Math.min(usableEquity, requested);
  const unallocatedWithinCap = Math.max(0, managedCapital - openCost);
  return {
    capitalBaseQuote: capitalBase,
    managedCapitalQuote: managedCapital,
    managedAvailableQuote: Math.min(available, unallocatedWithinCap),
    protectedReserveQuote: reserve,
    openCostQuote: openCost,
    allocationMode: mode,
  };
}

export type SizingInput = {
  equityQuote: number;
  availableQuote: number;
  entryPrice: number;
  stopPrice: number;
  maxPositionPct: number;
  riskPerTradePct: number;
  maxOrderQuote: number;
  minOrderQuote: number;
  quoteStep?: number;
  reservePct?: number;
  extraLossPct?: number;
};

export type SizingResult = {
  allowed: boolean;
  notionalQuote: number;
  quantity: number;
  stopDistancePct: number;
  riskBudgetQuote: number;
  reason: string | null;
};

export type ExitPosition = {
  remaining_quantity: number;
  stop_price: number;
  target_1: number;
  target_2?: number | null;
  t1_completed: boolean;
  trailing_stop?: number | null;
  max_holding_at: string;
};

export type ExitDecision = {
  action: "NONE" | "TARGET_1" | "TARGET_2" | "STOP" | "TRAIL" | "TIME_EXIT" | "EMERGENCY";
  fraction: number;
  reason: string;
};

export type CircuitInput = {
  /** v5.8.2: split out so the log names the actual cause. All optional for compatibility. */
  pausedByOperator?: boolean;
  withdrawalMode?: boolean;
  manualInterventionRequired?: boolean;
  mode: TradingMode;
  configured: boolean;
  exchangeEnabled: boolean;
  pauseNewEntries: boolean;
  emergencyLiquidation: boolean;
  availableQuote: number;
  minOrderQuote: number;
  openPositionsGlobal: number;
  openPositionsExchange: number;
  entriesTodayGlobal: number;
  entriesTodayExchange: number;
  dailyBoughtQuote: number;
  maxDailyBuyQuote: number;
  dailyPnlPct: number;
  weeklyPnlPct: number;
  consecutiveLosses: number;
  settings: TradingSettings;
};

export type CircuitResult = {
  allowNewEntry: boolean;
  hardStop: boolean;
  reasons: string[];
};

export function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export type OrderExecutionProgress = {
  executedVolume?: unknown;
  executedFunds?: unknown;
  averagePrice?: unknown;
};

export type ResolvedOrderExecutionProgress = {
  executedVolume: number;
  executedFunds: number;
  averagePrice: number;
};

export type BotExitOrderSnapshot = {
  side?: unknown;
  purpose?: unknown;
  state?: unknown;
  executedVolume?: unknown;
  executed_volume?: unknown;
};

/**
 * True when an unapplied bot SELL can account for a base-balance reduction.
 *
 * Exchange order state and position accounting are deliberately separate. A FILLED or
 * partially-filled order removes base asset before the position RPC books the fill. During
 * that interval the balance difference is order settlement in progress, never evidence of
 * a manual sale.
 */
export function pendingBotExitMayExplainBalanceReduction(
  orders: BotExitOrderSnapshot[],
): boolean {
  const definitelySettled = new Set([
    "APPLIED",
    "REJECTED",
    "NOT_FOUND",
    "EXCHANGE_CANCELLED",
    "CANCELLED",
  ]);
  return (orders || []).some((order) => {
    const side = String(order?.side || "SELL").toUpperCase();
    if (side !== "SELL" && side !== "ASK") return false;
    const state = String(order?.state || "UNKNOWN").toUpperCase();
    const executed = Math.max(
      0,
      finite(order?.executedVolume, finite(order?.executed_volume)),
    );
    if (state !== "APPLIED" && executed > 0) return true;
    if (definitelySettled.has(state)) return false;
    // REQUESTED/UNKNOWN may already have reached the exchange while the response or ledger
    // update is in flight. EXCHANGE_DONE and partial-cancelled have definitely reduced the
    // balance but have not yet been applied to the position.
    return true;
  });
}

export type ExitFillAllocationInput = {
  remainingQuantity: number;
  fillQuantity: number;
  fillFunds?: number;
  fillFeeQuote?: number;
  fillPrice: number;
  quantityStep?: number;
  dustValueQuote?: number;
};

export type ExitFillAllocationResult = {
  positionQuantity: number;
  positionFunds: number;
  positionFeeQuote: number;
  unallocatedQuantity: number;
  unallocatedFunds: number;
  unallocatedFeeQuote: number;
  allocationRatio: number;
  allowedExcessQuantity: number;
};

/**
 * Allocate one exchange SELL fill to the position without ever pairing full proceeds with
 * a smaller quantity/cost basis.
 *
 * A few exchange quantity steps (or less than the operational dust value) can legitimately
 * come from pre-existing account residue. Material overfills indicate stale position state
 * and must fail closed for reconciliation instead of fabricating profit.
 */
export function allocateExitFillToPosition(
  input: ExitFillAllocationInput,
): ExitFillAllocationResult {
  const remaining = Math.max(0, finite(input.remainingQuantity));
  const fillQuantity = Math.max(0, finite(input.fillQuantity));
  const fillPrice = Math.max(0, finite(input.fillPrice));
  if (!(remaining > 0 && fillQuantity > 0 && fillPrice > 0)) {
    throw new Error("exit fill allocation requires positive position, quantity and price");
  }
  const positionQuantity = Math.min(remaining, fillQuantity);
  const excessQuantity = Math.max(0, fillQuantity - remaining);
  const stepAllowance = Math.max(0, finite(input.quantityStep)) * 5;
  const dustAllowance = Math.max(0, finite(input.dustValueQuote)) / fillPrice;
  const allowedExcessQuantity = Math.max(1e-12, stepAllowance, dustAllowance);
  if (excessQuantity > allowedExcessQuantity + 1e-12) {
    throw new Error(
      `exit fill quantity ${fillQuantity} materially exceeds remaining position ${remaining}`,
    );
  }
  const allocationRatio = positionQuantity / fillQuantity;
  const fillFunds = Math.max(0, finite(input.fillFunds, fillQuantity * fillPrice));
  const fillFee = Math.max(0, finite(input.fillFeeQuote));
  const positionFunds = fillFunds * allocationRatio;
  const positionFeeQuote = fillFee * allocationRatio;
  return {
    positionQuantity,
    positionFunds,
    positionFeeQuote,
    unallocatedQuantity: excessQuantity,
    unallocatedFunds: Math.max(0, fillFunds - positionFunds),
    unallocatedFeeQuote: Math.max(0, fillFee - positionFeeQuote),
    allocationRatio,
    allowedExcessQuantity,
  };
}

/**
 * Exchange order snapshots are not guaranteed to be cumulative-complete.
 *
 * Upbit can return a partial-fill cancellation with the cumulative volume present while
 * `executed_funds` and `trades` are empty. A later snapshot must therefore never erase
 * execution progress already recorded from an earlier poll. The average price is retained
 * independently so the final partial fill remains executable even when quote funds are
 * omitted by the cancellation response.
 */
export function mergeOrderExecutionProgress(
  existing: OrderExecutionProgress,
  incoming: OrderExecutionProgress,
): ResolvedOrderExecutionProgress {
  const existingVolume = Math.max(0, finite(existing.executedVolume));
  const incomingVolume = Math.max(0, finite(incoming.executedVolume));
  const executedVolume = Math.max(existingVolume, incomingVolume);
  const existingFunds = Math.max(0, finite(existing.executedFunds));
  const incomingFunds = Math.max(0, finite(incoming.executedFunds));
  let executedFunds = Math.max(existingFunds, incomingFunds);
  const incomingAverage = Math.max(0, finite(incoming.averagePrice));
  const existingAverage = Math.max(0, finite(existing.averagePrice));
  const averagePrice = incomingAverage > 0
    ? incomingAverage
    : existingAverage > 0
    ? existingAverage
    : executedVolume > 0 && executedFunds > 0
    ? executedFunds / executedVolume
    : 0;
  // If the venue advanced the cumulative volume but omitted cumulative quote funds, retain
  // the last authoritative average rather than manufacturing a zero-notional fill.
  if (executedVolume > 0 && averagePrice > 0) {
    executedFunds = Math.max(executedFunds, executedVolume * averagePrice);
  }
  return { executedVolume, executedFunds, averagePrice };
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

export function binanceMinOrderUsdt(value: unknown): number {
  return clamp(finite(value, BINANCE_MIN_ORDER_USDT), BINANCE_MIN_ORDER_USDT, 1000);
}

export function floorToStep(value: number, step: number): number {
  const s = finite(step);
  if (!(s > 0)) return value;
  return Math.floor((value + s * 1e-10) / s) * s;
}

export function ceilToStep(value: number, step: number): number {
  const s = finite(step);
  if (!(s > 0)) return value;
  return Math.ceil((value - s * 1e-10) / s) * s;
}

/**
 * Convert quote notional into an exchange-valid entry quantity.
 *
 * Spot keeps the long-standing floor semantics so it never spends above its quote
 * allocation. Futures has a separate minimum MARGIN contract: its leveraged notional
 * must not slip below that floor merely because the quantity filter removed a fraction
 * of one step. The extra futures exposure is bounded by one quantity step and is funded
 * by the wallet balance outside the operator-managed allocation.
 */
export function entryQuantityForNotional(
  exchange: Exchange,
  notionalQuote: number,
  price: number,
  quantityStep: number,
): number {
  if (!(finite(price) > 0)) return 0;
  const rawQuantity = Math.max(0, finite(notionalQuote)) / finite(price);
  return isBinanceFutures(exchange)
    ? ceilToStep(rawQuantity, quantityStep)
    : floorToStep(rawQuantity, quantityStep);
}

export type ExitResidualAccountingInput = {
  remainingQuantity: number;
  soldQuantity: number;
  baseFeeQuantity?: number;
  markPrice: number;
  dustValueQuote: number;
};

export type ExitResidualAccountingResult = {
  soldQuantity: number;
  baseFeeQuantity: number;
  physicalRemainingQuantity: number;
  closeAsDust: boolean;
  nextRemainingQuantity: number;
  residualQuantity: number;
  residualValueQuote: number;
};

/**
 * Economic close accounting for exchange quantity-step dust.
 *
 * A market sell can be rounded down by one quantity step and a sell commission may also
 * be paid in the base asset. The unmarketable remainder is still an account asset. When
 * it is small enough to close operationally, value it at the exit mark instead of
 * treating the whole remainder as a trading loss.
 */
export function calculateExitResidualAccounting(
  input: ExitResidualAccountingInput,
): ExitResidualAccountingResult {
  const remaining = Math.max(0, finite(input.remainingQuantity));
  const sold = Math.min(remaining, Math.max(0, finite(input.soldQuantity)));
  const afterSale = Math.max(0, remaining - sold);
  const baseFee = Math.min(afterSale, Math.max(0, finite(input.baseFeeQuantity)));
  const physicalRemaining = Math.max(0, afterSale - baseFee);
  const markPrice = Math.max(0, finite(input.markPrice));
  const residualValue = physicalRemaining * markPrice;
  const dustThreshold = Math.max(0, finite(input.dustValueQuote));
  const closeAsDust = physicalRemaining <= 1e-12 || residualValue < dustThreshold;
  return {
    soldQuantity: sold,
    baseFeeQuantity: baseFee,
    physicalRemainingQuantity: physicalRemaining,
    closeAsDust,
    nextRemainingQuantity: closeAsDust ? 0 : physicalRemaining,
    residualQuantity: closeAsDust ? physicalRemaining : 0,
    residualValueQuote: closeAsDust ? residualValue : 0,
  };
}

export function calculatePositionSize(input: SizingInput): SizingResult {
  const equity = Math.max(0, finite(input.equityQuote));
  const available = Math.max(0, finite(input.availableQuote));
  const entry = finite(input.entryPrice);
  const stop = finite(input.stopPrice);
  if (!(entry > 0) || !(stop > 0) || stop >= entry) {
    return {
      allowed: false,
      notionalQuote: 0,
      quantity: 0,
      stopDistancePct: 0,
      riskBudgetQuote: 0,
      reason: "invalid entry/stop",
    };
  }
  const stopDistance = (entry - stop) / entry;
  const extraLoss = clamp(finite(input.extraLossPct, 0.002), 0, 0.03);
  const effectiveLoss = stopDistance + extraLoss;
  const riskBudget = equity * clamp(input.riskPerTradePct, 0.05, 5) / 100;
  const byRisk = effectiveLoss > 0 ? riskBudget / effectiveLoss : 0;
  const byPosition = equity * clamp(input.maxPositionPct, 0.1, 100) / 100;
  const byCash = available * (1 - clamp(finite(input.reservePct, 0.03), 0, 0.5));
  const raw = Math.min(byRisk, byPosition, byCash, Math.max(0, finite(input.maxOrderQuote)));
  const step = Math.max(0.00000001, finite(input.quoteStep, 0.01));
  const notional = floorToStep(raw, step);
  const minOrder = Math.max(step, finite(input.minOrderQuote));
  if (notional + step * 1e-6 < minOrder) {
    return {
      allowed: false,
      notionalQuote: 0,
      quantity: 0,
      stopDistancePct: stopDistance * 100,
      riskBudgetQuote: riskBudget,
      reason: `sized order ${notional} below minimum ${minOrder}`,
    };
  }
  return {
    allowed: true,
    notionalQuote: notional,
    quantity: notional / entry,
    stopDistancePct: stopDistance * 100,
    riskBudgetQuote: riskBudget,
    reason: null,
  };
}

export function decideExit(
  position: ExitPosition,
  currentPrice: number,
  nowMs = Date.now(),
  emergency = false,
  // v7.1.1: LOB_SCALP passes allowTimeExit=false. The 180-second value is a
  // review horizon, never a forced liquidation deadline.
  allowTimeExit = true,
): ExitDecision {
  const price = finite(currentPrice);
  if (!(price > 0) || finite(position.remaining_quantity) <= 0) {
    return { action: "NONE", fraction: 0, reason: "no executable quantity or price" };
  }
  if (emergency) {
    return { action: "EMERGENCY", fraction: 1, reason: "emergency liquidation enabled" };
  }
  // Profit protection can raise trailing_stop before TARGET_1. Restricting the trail to
  // t1_completed made the database record a protected profit floor that the exit engine
  // silently ignored, allowing TIMEOUT/LOB exits to give the entire MFE back.
  const trailActive = finite(position.trailing_stop) > finite(position.stop_price);
  const effectiveStop = trailActive
    ? Math.max(finite(position.stop_price), finite(position.trailing_stop))
    : finite(position.stop_price);
  if (price <= effectiveStop) {
    return {
      action: trailActive ? "TRAIL" : "STOP",
      fraction: 1,
      reason: `price ${price} <= exit stop ${effectiveStop}`,
    };
  }
  const target2 = finite(position.target_2);
  if (target2 > 0 && price >= target2) {
    return { action: "TARGET_2", fraction: 1, reason: "second target reached" };
  }
  if (!position.t1_completed && price >= finite(position.target_1)) {
    return { action: "TARGET_1", fraction: 0, reason: "first target reached" };
  }
  if (allowTimeExit) {
    const maxHolding = new Date(position.max_holding_at).getTime();
    if (Number.isFinite(maxHolding) && nowMs >= maxHolding) {
      return { action: "TIME_EXIT", fraction: 1, reason: "maximum holding time reached" };
    }
  }
  return { action: "NONE", fraction: 0, reason: "hold" };
}

export function evaluateCircuit(input: CircuitInput): CircuitResult {
  const reasons: string[] = [];
  if (!input.configured) reasons.push("trading settings are not configured");
  if (!input.exchangeEnabled) reasons.push("exchange is disabled");
  if (input.mode === "PAUSED") reasons.push("trading mode is PAUSED");
  // v5.8.2: three unrelated conditions used to collapse into one indistinguishable
  // message. An operator reading "new entries are paused" could not tell whether they had
  // pressed pause, whether withdrawal mode was on, or whether the account reconciliation
  // had flagged something — which are three completely different problems with three
  // different fixes. Name whichever one is actually true.
  if (input.pausedByOperator) reasons.push("new entries paused by operator");
  if (input.withdrawalMode) reasons.push("withdrawal mode is active");
  if (input.manualInterventionRequired) reasons.push("manual account intervention is unresolved");
  if (
    input.pauseNewEntries && !input.pausedByOperator && !input.withdrawalMode &&
    !input.manualInterventionRequired
  ) {
    reasons.push("new entries are paused");
  }
  if (input.emergencyLiquidation) reasons.push("emergency liquidation active");
  if (input.openPositionsGlobal >= input.settings.max_open_positions) {
    reasons.push("global maximum open positions reached");
  }
  if (input.openPositionsExchange >= input.settings.max_open_positions_per_exchange) {
    reasons.push("exchange maximum open positions reached");
  }
  if (input.entriesTodayGlobal >= input.settings.max_daily_entries) {
    reasons.push("global maximum daily entries reached");
  }
  if (input.entriesTodayExchange >= input.settings.max_daily_entries_per_exchange) {
    reasons.push("exchange maximum daily entries reached");
  }
  if (input.dailyBoughtQuote >= input.maxDailyBuyQuote) {
    reasons.push("exchange daily buy notional limit reached");
  }
  if (input.availableQuote < input.minOrderQuote) {
    reasons.push("insufficient available quote balance");
  }
  if (input.dailyPnlPct <= -Math.abs(input.settings.max_daily_loss_pct)) {
    reasons.push("daily loss limit reached");
  }
  if (input.weeklyPnlPct <= -Math.abs(input.settings.max_weekly_loss_pct)) {
    reasons.push("weekly loss limit reached");
  }
  if (input.consecutiveLosses >= input.settings.max_consecutive_losses) {
    reasons.push("consecutive loss limit reached");
  }
  return {
    allowNewEntry: reasons.length === 0 && input.mode !== "PAUSED",
    hardStop: input.emergencyLiquidation ||
      input.dailyPnlPct <= -Math.abs(input.settings.max_daily_loss_pct) ||
      input.weeklyPnlPct <= -Math.abs(input.settings.max_weekly_loss_pct),
    reasons,
  };
}

export function adjustedPlanForFill(
  plannedEntry: number,
  fillEntry: number,
  stop: number,
  target1: number,
  target2: number | null,
) {
  if (!(plannedEntry > 0 && fillEntry > 0)) throw new Error("invalid entry prices");
  const stopPct = clamp((plannedEntry - stop) / plannedEntry, 0.001, 0.5);
  const t1Pct = clamp((target1 - plannedEntry) / plannedEntry, 0.001, 1);
  const t2Pct = target2 && target2 > plannedEntry
    ? clamp((target2 - plannedEntry) / plannedEntry, t1Pct, 2)
    : null;
  return {
    stopPrice: fillEntry * (1 - stopPct),
    target1: fillEntry * (1 + t1Pct),
    target2: t2Pct == null ? null : fillEntry * (1 + t2Pct),
  };
}

export function t1SellQuantity(
  initialQuantity: number,
  remainingQuantity: number,
  allocationPct: number,
): number {
  return Math.min(
    Math.max(0, remainingQuantity),
    Math.max(0, initialQuantity) * clamp(allocationPct, 1, 99) / 100,
  );
}

export function nextTrailingStop(
  current: number | null | undefined,
  peak: number,
  distancePct: number,
  hardStop: number,
): number {
  const candidate = peak * (1 - clamp(distancePct, 0.1, 20) / 100);
  return Math.max(finite(current), finite(hardStop), candidate);
}

export function dangerousControlError(input: {
  mode?: unknown;
  emergencyLiquidation?: unknown;
  confirmation?: unknown;
}): string | null {
  const mode = String(input.mode || "").toUpperCase();
  const confirmation = String(input.confirmation || "");
  if (mode === "LIVE_LIMITED" && confirmation !== "ENABLE_LIVE") {
    return "LIVE_LIMITED requires confirmation ENABLE_LIVE";
  }
  if (input.emergencyLiquidation === true && confirmation !== "LIQUIDATE_NOW") {
    return "emergency liquidation requires confirmation LIQUIDATE_NOW";
  }
  return null;
}

export function resumeSafetyError(input: {
  emergencyLiquidation: boolean;
  activePositionCount: number;
  unresolvedManualCount?: number;
}): string | null {
  if (Math.max(0, finite(input.unresolvedManualCount)) > 0) {
    return "manual account intervention is still unresolved; resume is blocked";
  }
  if (input.emergencyLiquidation && Math.max(0, finite(input.activePositionCount)) > 0) {
    return "emergency liquidation still has active positions; resume is blocked";
  }
  return null;
}

export function externalQuoteIntervention(
  exchange: Exchange,
  externalDelta: number,
  withdrawalMode: boolean,
) {
  const decrease = finite(externalDelta) < 0;
  const direction = decrease ? "decreased" : "increased";
  return {
    pauseNewEntries: false,
    manualInterventionRequired: false,
    reason: withdrawalMode
      ? `WITHDRAWAL_MODE_BALANCE_${decrease ? "DECREASE" : "INCREASE"}`
      : `${exchange}: quote balance ${direction} outside bot orders; recorded without global pause`,
  };
}

export type ManualReconcileAccountingInput = {
  initialQuantity: number;
  actualQuantity: number;
  originalEntryCostQuote: number;
  originalEntryFeeQuote: number;
};

export function manualReconcileAccounting(input: ManualReconcileAccountingInput) {
  const initial = Math.max(0, finite(input.initialQuantity));
  const actual = clamp(finite(input.actualQuantity), 0, initial);
  const remainingRatio = initial > 0 ? actual / initial : 0;
  return {
    remainingRatio,
    remainingCostQuote: Math.max(0, finite(input.originalEntryCostQuote)) * remainingRatio,
    remainingEntryFeeQuote: Math.max(0, finite(input.originalEntryFeeQuote)) * remainingRatio,
    realizedProceedsQuote: 0,
    realizedPnlQuote: 0,
  };
}

export function baseAsset(exchange: Exchange, market: string): string {
  const normalized = String(market || "").toUpperCase();
  return exchange === "upbit"
    ? normalized.split("-")[1] || normalized
    : normalized.endsWith("USDT")
    ? normalized.slice(0, -4)
    : normalized;
}

export function quoteCurrency(exchange: Exchange): "KRW" | "USDT" {
  return exchange === "upbit" ? "KRW" : "USDT";
}

export function normalizedOrderState(
  currentState: string | null | undefined,
  gatewayState: string | null | undefined,
): string {
  if (String(currentState || "").toUpperCase() === "APPLIED") return "APPLIED";
  const state = String(gatewayState || "UNKNOWN").toUpperCase();
  if (state === "FILLED") return "EXCHANGE_DONE";
  if (state === "CANCELED") return "EXCHANGE_CANCELLED";
  if (state === "PARTIALLY_FILLED_CANCELED") return "EXCHANGE_PARTIAL_CANCELLED";
  if (state === "PARTIALLY_FILLED") return "EXCHANGE_PARTIAL";
  if (state === "OPEN") return "EXCHANGE_OPEN";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// v6.4: account reconciliation verdict.
//
// Two incidents produced this function.
//
//   2026-07-26  binance:LTC — a resting take-profit the bot itself had placed locked the
//               base asset. The comparison treated the locked quantity as missing and
//               paused the asset.
//   2026-07-27  upbit:ETH   — a position flagged by that comparison was skipped by the
//               monitor loop for 8h39m. It was never priced, never evaluated and never
//               sold; a human closed it by hand.
//
// The verdict therefore answers two separate questions, and the second one is the
// important one: a mismatch decides whether we may BUY this asset, never whether we may
// SELL what we already hold.
// ---------------------------------------------------------------------------

const DUST_MAX_FRACTION = 0.5;

export type ReconcileVerdict =
  | "MATCH"
  | "DUST_ALIGN"
  | "UNKNOWN_LOCK"
  | "ASSET_REVIEW"
  | "VANISHED";

export interface ReconcileInput {
  /** Quantity the ledger says we hold. */
  bookedQuantity: number;
  /** Exchange free balance. */
  freeQuantity: number;
  /** Exchange locked balance. */
  lockedQuantity: number;
  /** Quantity locked by the bot's OWN open orders, or null when unreadable. */
  botLockedQuantity: number | null;
  /** Reference price in the quote currency. */
  price: number;
  /** Differences below this quote value are noise, never a manual trade. */
  dustToleranceQuote: number;
  /** Per-side fee rate as a percentage, e.g. 0.1 for Binance. */
  feePctPerSide: number;
  /** Exchange quantity step, if known. */
  quantityStep?: number;
}

export interface ReconcileOutput {
  verdict: ReconcileVerdict;
  /** Ledger quantity after alignment. */
  alignedQuantity: number;
  /** What can actually be delivered to a sell order right now. */
  sellableQuantity: number;
  /** New entries on this asset are blocked. */
  blockNewEntries: boolean;
  /**
   * Exits are ALWAYS permitted. The field exists so the intent is explicit in the type
   * rather than implied by the absence of a check.
   */
  allowExit: true;
  shortfallQuantity: number;
  shortfallQuote: number;
  toleranceQuantity: number;
  reason: string;
}

export function reconcileAccount(input: ReconcileInput): ReconcileOutput {
  const booked = Math.max(0, finite(input.bookedQuantity));
  const free = Math.max(0, finite(input.freeQuantity));
  const locked = Math.max(0, finite(input.lockedQuantity));
  const total = free + locked;
  const price = Math.max(0, finite(input.price));

  const botLockedKnown = input.botLockedQuantity !== null && input.botLockedQuantity !== undefined;
  const botLocked = botLockedKnown
    ? Math.min(Math.max(0, finite(input.botLockedQuantity)), locked)
    : 0;
  // Our own resting order has not left the account and we can cancel it at will, so it
  // counts as deliverable.
  const effectiveFree = free + botLocked;

  // The dust threshold is absolute, which is what the operator asked for: a difference
  // worth a few dollars is noise regardless of what caused it. It carries one guard —
  // losing half a position is information no matter how little the half is worth, so the
  // absolute floor never swallows more than DUST_MAX_FRACTION of the holding. On a
  // normally sized position the guard never binds; it only stops a very small position
  // from being able to vanish silently.
  const dustQuantityRaw = price > 0 ? Math.max(0, finite(input.dustToleranceQuote)) / price : 0;
  const dustQuantity = Math.min(dustQuantityRaw, booked * DUST_MAX_FRACTION);
  const tolerance = Math.max(
    Math.max(0, finite(input.quantityStep)) * 2,
    booked * Math.max(0, finite(input.feePctPerSide)) / 100 * 3,
    dustQuantity,
  );

  const shortfall = Math.max(0, booked - total);
  const base = {
    shortfallQuantity: shortfall,
    shortfallQuote: shortfall * price,
    toleranceQuantity: tolerance,
    allowExit: true as const,
  };

  if (booked <= total + 1e-12 && booked <= effectiveFree + 1e-12) {
    return {
      ...base,
      verdict: "MATCH",
      alignedQuantity: booked,
      sellableQuantity: effectiveFree,
      blockNewEntries: false,
      reason: "ledger agrees with the account",
    };
  }

  if (shortfall > 0 && shortfall <= tolerance) {
    const aligned = Math.max(0, booked - shortfall);
    return {
      ...base,
      verdict: "DUST_ALIGN",
      alignedQuantity: aligned,
      sellableQuantity: Math.min(aligned, Math.max(effectiveFree, total)),
      blockNewEntries: false,
      reason:
        `shortfall ${shortfall} within tolerance ${tolerance}; ledger aligned, trading unaffected`,
    };
  }

  if (shortfall > tolerance) {
    return {
      ...base,
      verdict: "VANISHED",
      alignedQuantity: total,
      sellableQuantity: effectiveFree,
      blockNewEntries: true,
      reason:
        `quantity left the account beyond tolerance; entries blocked, remaining ${effectiveFree} still exitable`,
    };
  }

  // Present but locked. Whether that is our doing decides everything.
  if (!botLockedKnown) {
    return {
      ...base,
      verdict: "UNKNOWN_LOCK",
      alignedQuantity: booked,
      sellableQuantity: free,
      blockNewEntries: true,
      reason:
        "open orders unreadable; entries blocked fail-closed, existing holdings remain exitable",
    };
  }

  return {
    ...base,
    verdict: "ASSET_REVIEW",
    alignedQuantity: booked,
    sellableQuantity: effectiveFree,
    blockNewEntries: true,
    reason:
      `balance locked by an order that is not ours; entries blocked on this asset, ${effectiveFree} still exitable`,
  };
}
