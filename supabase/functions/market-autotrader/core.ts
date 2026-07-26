export type TradingMode = "PAUSED" | "PAPER" | "LIVE_LIMITED";
export type Exchange = "upbit" | "binance";

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
  const requested = mode === "FIXED" ? Math.max(0, finite(input.fixedAllocationQuote)) : usableEquity;
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

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

export function floorToStep(value: number, step: number): number {
  const s = finite(step);
  if (!(s > 0)) return value;
  return Math.floor((value + s * 1e-10) / s) * s;
}

export function calculatePositionSize(input: SizingInput): SizingResult {
  const equity = Math.max(0, finite(input.equityQuote));
  const available = Math.max(0, finite(input.availableQuote));
  const entry = finite(input.entryPrice);
  const stop = finite(input.stopPrice);
  if (!(entry > 0) || !(stop > 0) || stop >= entry) {
    return { allowed: false, notionalQuote: 0, quantity: 0, stopDistancePct: 0, riskBudgetQuote: 0, reason: "invalid entry/stop" };
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
  // v5.8: SCALP passes false. Holding time no longer closes anything — a position is sold
  // when the market says so (stop, target, trail, live edge, flow reversal, liquidity
  // event), never because a clock ran out.
  allowTimeExit = true,
): ExitDecision {
  const price = finite(currentPrice);
  if (!(price > 0) || finite(position.remaining_quantity) <= 0) {
    return { action: "NONE", fraction: 0, reason: "no executable quantity or price" };
  }
  if (emergency) return { action: "EMERGENCY", fraction: 1, reason: "emergency liquidation enabled" };
  const effectiveStop = position.t1_completed && finite(position.trailing_stop) > 0
    ? Math.max(finite(position.stop_price), finite(position.trailing_stop))
    : finite(position.stop_price);
  if (price <= effectiveStop) {
    return {
      action: position.t1_completed && finite(position.trailing_stop) >= finite(position.stop_price) ? "TRAIL" : "STOP",
      fraction: 1,
      reason: `price ${price} <= exit stop ${effectiveStop}`,
    };
  }
  const target2 = finite(position.target_2);
  if (target2 > 0 && price >= target2) return { action: "TARGET_2", fraction: 1, reason: "second target reached" };
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
  if (input.pauseNewEntries && !input.pausedByOperator && !input.withdrawalMode && !input.manualInterventionRequired) {
    reasons.push("new entries are paused");
  }
  if (input.emergencyLiquidation) reasons.push("emergency liquidation active");
  if (input.openPositionsGlobal >= input.settings.max_open_positions) reasons.push("global maximum open positions reached");
  if (input.openPositionsExchange >= input.settings.max_open_positions_per_exchange) reasons.push("exchange maximum open positions reached");
  if (input.entriesTodayGlobal >= input.settings.max_daily_entries) reasons.push("global maximum daily entries reached");
  if (input.entriesTodayExchange >= input.settings.max_daily_entries_per_exchange) reasons.push("exchange maximum daily entries reached");
  if (input.dailyBoughtQuote >= input.maxDailyBuyQuote) reasons.push("exchange daily buy notional limit reached");
  if (input.availableQuote < input.minOrderQuote) reasons.push("insufficient available quote balance");
  if (input.dailyPnlPct <= -Math.abs(input.settings.max_daily_loss_pct)) reasons.push("daily loss limit reached");
  if (input.weeklyPnlPct <= -Math.abs(input.settings.max_weekly_loss_pct)) reasons.push("weekly loss limit reached");
  if (input.consecutiveLosses >= input.settings.max_consecutive_losses) reasons.push("consecutive loss limit reached");
  return {
    allowNewEntry: reasons.length === 0 && input.mode !== "PAUSED",
    hardStop: input.emergencyLiquidation || input.dailyPnlPct <= -Math.abs(input.settings.max_daily_loss_pct) ||
      input.weeklyPnlPct <= -Math.abs(input.settings.max_weekly_loss_pct),
    reasons,
  };
}

export function adjustedPlanForFill(plannedEntry: number, fillEntry: number, stop: number, target1: number, target2: number | null) {
  if (!(plannedEntry > 0 && fillEntry > 0)) throw new Error("invalid entry prices");
  const stopPct = clamp((plannedEntry - stop) / plannedEntry, 0.001, 0.5);
  const t1Pct = clamp((target1 - plannedEntry) / plannedEntry, 0.001, 1);
  const t2Pct = target2 && target2 > plannedEntry ? clamp((target2 - plannedEntry) / plannedEntry, t1Pct, 2) : null;
  return {
    stopPrice: fillEntry * (1 - stopPct),
    target1: fillEntry * (1 + t1Pct),
    target2: t2Pct == null ? null : fillEntry * (1 + t2Pct),
  };
}

export function t1SellQuantity(initialQuantity: number, remainingQuantity: number, allocationPct: number): number {
  return Math.min(Math.max(0, remainingQuantity), Math.max(0, initialQuantity) * clamp(allocationPct, 1, 99) / 100);
}

export function nextTrailingStop(current: number | null | undefined, peak: number, distancePct: number, hardStop: number): number {
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

export function externalQuoteIntervention(exchange: Exchange, externalDelta: number, withdrawalMode: boolean) {
  const decrease = finite(externalDelta) < 0;
  const direction = decrease ? "decreased" : "increased";
  return {
    pauseNewEntries: true,
    manualInterventionRequired: !withdrawalMode,
    reason: withdrawalMode
      ? `WITHDRAWAL_MODE_BALANCE_${decrease ? "DECREASE" : "INCREASE"}`
      : `${exchange}: quote balance ${direction} outside bot orders`,
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
  return exchange === "upbit" ? normalized.split("-")[1] || normalized : normalized.endsWith("USDT") ? normalized.slice(0, -4) : normalized;
}

export function quoteCurrency(exchange: Exchange): "KRW" | "USDT" {
  return exchange === "upbit" ? "KRW" : "USDT";
}

export function normalizedOrderState(currentState: string | null | undefined, gatewayState: string | null | undefined): string {
  if (String(currentState || "").toUpperCase() === "APPLIED") return "APPLIED";
  const state = String(gatewayState || "UNKNOWN").toUpperCase();
  if (state === "FILLED") return "EXCHANGE_DONE";
  if (state === "CANCELED") return "EXCHANGE_CANCELLED";
  if (state === "PARTIALLY_FILLED_CANCELED") return "EXCHANGE_PARTIAL_CANCELLED";
  if (state === "PARTIALLY_FILLED") return "EXCHANGE_PARTIAL";
  if (state === "OPEN") return "EXCHANGE_OPEN";
  return "UNKNOWN";
}
