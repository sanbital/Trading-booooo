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

export type ReconcileVerdict = "MATCH" | "DUST_ALIGN" | "UNKNOWN_LOCK" | "ASSET_REVIEW" | "VANISHED";

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
  const botLocked = botLockedKnown ? Math.min(Math.max(0, finite(input.botLockedQuantity)), locked) : 0;
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
    return { ...base, verdict: "MATCH", alignedQuantity: booked, sellableQuantity: effectiveFree, blockNewEntries: false, reason: "ledger agrees with the account" };
  }

  if (shortfall > 0 && shortfall <= tolerance) {
    const aligned = Math.max(0, booked - shortfall);
    return {
      ...base,
      verdict: "DUST_ALIGN",
      alignedQuantity: aligned,
      sellableQuantity: Math.min(aligned, Math.max(effectiveFree, total)),
      blockNewEntries: false,
      reason: `shortfall ${shortfall} within tolerance ${tolerance}; ledger aligned, trading unaffected`,
    };
  }

  if (shortfall > tolerance) {
    return {
      ...base,
      verdict: "VANISHED",
      alignedQuantity: total,
      sellableQuantity: effectiveFree,
      blockNewEntries: true,
      reason: `quantity left the account beyond tolerance; entries blocked, remaining ${effectiveFree} still exitable`,
    };
  }

  // Present but locked. Whether that is our doing decides everything.
  if (!botLockedKnown) {
    return {
      ...base,
      verdict: "UNKNOWN_LOCK",
      alignedQuantity: booked,
      sellableQuantity: free,
      blockNewEntries: false,
      reason: "open orders unreadable; a lock cannot be attributed to anyone this cycle",
    };
  }

  return {
    ...base,
    verdict: "ASSET_REVIEW",
    alignedQuantity: booked,
    sellableQuantity: effectiveFree,
    blockNewEntries: true,
    reason: `balance locked by an order that is not ours; entries blocked on this asset, ${effectiveFree} still exitable`,
  };
}
