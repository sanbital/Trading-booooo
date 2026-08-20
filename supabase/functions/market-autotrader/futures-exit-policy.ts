// Trading-booooo — Binance USDⓈ-M futures split-exit policy.
//
// The entry side of the futures lane is deliberately identical to spot: same scanner,
// same LOB admission, same long-only direction. The futures SELL side is expressed in
// return on margin (ROE) so leverage changes do not silently change account risk.
//
// Operator specification:
//
//   1. Default leverage is 3x.
//   2. First-tranche NORMAL state:
//        -12% ROE -> hard stop 100% (last-resort loss cap)
//        +15% ROE -> take profit on 50%
//   3. Mission horizon is 180 seconds. If the first tranche has not completed and the
//      WHOLE position is still non-positive on a fees/slippage-adjusted executable basis
//      at the first observation at/after 180s, permanently latch RECOVERY.
//   4. RECOVERY ignores the +15% half take-profit. It exits 100% at the first genuinely
//      executable net profit > 0. If that never arrives, the -12% ROE hard stop remains.
//   5. Remaining 50% after a NORMAL +15% take-profit is a winner and is allowed to run;
//      protect it at max(+9% ROE, peak ROE - 4.5pp).
//   6. A separate 180-minute empirical giveback guard remains for NORMAL first-tranche
//      positions. It is tail-loss defense, not the RECOVERY activation clock.
//
// At 3x the first TP/stop are +5%/-4% price moves. The 180-second RECOVERY latch is based
// on executable net economics, not a mark-price approximation.

export const DEFAULT_FUTURES_LEVERAGE = 3;
export const MIN_FUTURES_LEVERAGE = 1;
export const MAX_FUTURES_LEVERAGE = 20;
/** Minimum capital actually posted for every new USDⓈ-M position. */
export const FUTURES_MIN_ENTRY_MARGIN_USDT = 50;

export const FUTURES_SPLIT_EXIT_THRESHOLDS = {
  /** Half take-profit, measured on margin (ROE). */
  firstTakeProfitRoePct: 15,
  /** Hard stop, measured on margin (ROE). */
  firstStopLossRoePct: -12,
  /** Residual minimum protected ROE after the first +15% take-profit. */
  residualProfitFloorRoePct: 9,
  /** Residual trailing drawdown from peak ROE. */
  residualTrailingDrawdownRoePct: 4.5,
  /** Fraction closed at the first take-profit. */
  firstTakeProfitFraction: 0.5,
  /** Fraction closed at the hard stop. */
  hardStopFraction: 1,
  /** Entry mission horizon: failed/non-positive first tranche becomes RECOVERY after 3m. */
  recoveryLatchAfterSeconds: 180,
  /** Independent empirical tail-defense clock for NORMAL first-tranche positions. */
  staleGivebackAfterSeconds: 180 * 60,
  /**
   * Empirical lower bound of the peak ROE among 180m+ losing LIVE futures trades in the
   * 2026-08-11..17 sample. EPIC peaked at 2.13815789473683% ROE and CVX at
   * 3.739167048640339%; the 180m+ winners OPEN/EDEN peaked only at
   * 0.84388185654009% / 0.682375000633698%. No interpolation is used here: the losing
   * sample's observed lower bound is preserved exactly.
   */
  staleGivebackMinPeakRoePct: 2.13815789473683,
} as const;

export type FuturesSplitExitReason =
  | "FUTURES_HALF_TAKE_PROFIT_ROE_15"
  | "FUTURES_HALF_STOP_LOSS_ROE_12"
  | "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT"
  | "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12"
  | "FUTURES_HALF_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
  | "FUTURES_RECOVERY_NET_POSITIVE_EXIT"
  | "FUTURES_RECOVERY_AWAITING_NET_POSITIVE"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_ACTIVE"
  | "FUTURES_STALE_GIVEBACK_EXIT_180M";

export type FuturesSplitExitInput = {
  /** True once the normal +15% first-tranche sale has left only the winning residual. */
  residualStage: boolean;
  /** Permanently latched failed-mission state for a pre-T1 whole position. */
  recoveryMode: boolean;
  /** Configured leverage for this position. */
  leverage: number;
  /** Price return from average entry to the executable exit price, before fees, in %. */
  grossReturnPct: number;
  /** Highest observed gross price return since entry, in %. */
  peakGrossReturnPct: number;
  /** Current executable return after entry/exit fees and slippage, in %. */
  netReturnPct: number;
  /** Whether the quantity owned by this state can genuinely be sold at positive net. */
  executableNetAllowed: boolean;
  /** Expected net profit of that executable sale, in quote currency. */
  expectedNetProfitQuote: number;
  /** Position age. RECOVERY latching is done separately; this is for 180m giveback only. */
  heldSeconds: number;
  /** True only when the engine has an earned above-entry protected stop and price hit it. */
  preT1ProfitProtectionHit?: boolean;
  /** A non-price safety request (reconciliation/risk) that the thresholds override. */
  safetyRequested?: boolean;
};

export type FuturesSplitExitDecision = {
  action: "STOP" | "NONE";
  fraction: number;
  reason: FuturesSplitExitReason;
  /** Leverage-applied gross return, for the audit record. */
  roePct: number;
  /** Leverage-applied return after executable costs. */
  netRoePct: number;
  /** Highest observed leverage-applied gross return. */
  peakRoePct: number;
  /** Active residual protection threshold when in residual stage. */
  residualProtectRoePct: number | null;
  leverage: number;
};

export type FuturesRecoveryState = {
  enabled: boolean;
  newlyLatched: boolean;
};

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Leverage actually used for policy arithmetic. An unset, zero or absurd value must never
 * silently disable the leverage term — that would turn the -12% margin stop into a -12%
 * price stop and risk three times what the operator authorised.
 */
export function normalizeFuturesLeverage(
  value: unknown,
  fallback: number = DEFAULT_FUTURES_LEVERAGE,
): number {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(MAX_FUTURES_LEVERAGE, Math.max(MIN_FUTURES_LEVERAGE, base));
}

/**
 * Entry floors use two different units on futures: the operator floor is margin while
 * Binance's symbol filter is contract notional. Resolve both once so neither can be
 * accidentally compared with a spot-order amount.
 */
export function futuresEntryMinimums(
  leverage: unknown,
  venueMinimumNotionalQuote: unknown = 0,
): { marginQuote: number; notionalQuote: number; leverage: number } {
  const normalizedLeverage = normalizeFuturesLeverage(leverage);
  const venueMinimum = Math.max(0, finite(venueMinimumNotionalQuote));
  const notionalQuote = Math.max(
    FUTURES_MIN_ENTRY_MARGIN_USDT * normalizedLeverage,
    venueMinimum,
  );
  return {
    marginQuote: notionalQuote / normalizedLeverage,
    notionalQuote,
    leverage: normalizedLeverage,
  };
}

export type FuturesAffordableEntryInput = {
  availableMarginQuote: number;
  requestedNotionalQuote: number;
  entryPrice: number;
  quantityStep: number;
  leverage: number;
  /** One-side entry commission in percentage units, e.g. 0.05 means 0.05%. */
  feePerSidePct: number;
};

export type FuturesAffordableEntry = {
  quantity: number;
  notionalQuote: number;
  marginQuote: number;
  entryFeeQuote: number;
  totalWalletDebitQuote: number;
};

/**
 * Bound a USDⓈ-M entry by the wallet amount that can fund both initial margin and
 * entry commission. Quantity is floored to the venue step, so affordability can
 * never be broken by the generic futures round-up path.
 */
export function futuresAffordableEntry(
  input: FuturesAffordableEntryInput,
): FuturesAffordableEntry {
  const available = Math.max(0, finite(input.availableMarginQuote));
  const requestedNotional = Math.max(0, finite(input.requestedNotionalQuote));
  const entryPrice = Math.max(0, finite(input.entryPrice));
  const quantityStep = Math.max(0, finite(input.quantityStep));
  const leverage = normalizeFuturesLeverage(input.leverage);
  const feeRate = Math.max(0, finite(input.feePerSidePct)) / 100;
  if (!(available > 0 && requestedNotional > 0 && entryPrice > 0)) {
    return {
      quantity: 0,
      notionalQuote: 0,
      marginQuote: 0,
      entryFeeQuote: 0,
      totalWalletDebitQuote: 0,
    };
  }

  // notional/leverage + notional*entryFeeRate <= free wallet
  const walletNotionalCap = available / (1 / leverage + feeRate);
  const targetNotional = Math.min(requestedNotional, walletNotionalCap);
  const rawQuantity = targetNotional / entryPrice;
  const quantity = quantityStep > 0
    ? Math.floor(rawQuantity / quantityStep) * quantityStep
    : rawQuantity;
  const notionalQuote = Math.max(0, quantity * entryPrice);
  const marginQuote = notionalQuote / leverage;
  const entryFeeQuote = notionalQuote * feeRate;
  return {
    quantity,
    notionalQuote,
    marginQuote,
    entryFeeQuote,
    totalWalletDebitQuote: marginQuote + entryFeeQuote,
  };
}

/** Return on margin: a 4% price move on 3x margin is a 12% move on the money posted. */
export function futuresRoePct(priceReturnPct: number, leverage: number): number {
  return finite(priceReturnPct) * normalizeFuturesLeverage(leverage);
}

/** Price move that reaches a given ROE at this leverage. Used for planned stop/target prices. */
export function futuresPriceReturnPctForRoe(roePct: number, leverage: number): number {
  return finite(roePct) / normalizeFuturesLeverage(leverage);
}

/**
 * Resolve the permanent pre-T1 RECOVERY latch from the position's own history.
 *
 * The latch is evaluated on the WHOLE position's executable net return. A position that is
 * already in the winning residual stage is never converted to RECOVERY, because it earned
 * T1 and should remain on protected trailing. Once RECOVERY is latched it cannot be cleared
 * by a later positive tick; only closing the position ends it.
 */
export function futuresRecoveryState(input: {
  residualStage: boolean;
  alreadyLatched: boolean;
  heldSeconds: number;
  netReturnPct: number;
}): FuturesRecoveryState {
  if (input.residualStage) return { enabled: false, newlyLatched: false };
  if (input.alreadyLatched) return { enabled: true, newlyLatched: false };
  const newlyLatched =
    finite(input.heldSeconds) >= FUTURES_SPLIT_EXIT_THRESHOLDS.recoveryLatchAfterSeconds &&
    finite(input.netReturnPct) <= 0;
  return { enabled: newlyLatched, newlyLatched };
}

export function futuresSplitExitDecision(
  input: FuturesSplitExitInput,
): FuturesSplitExitDecision {
  const thresholds = FUTURES_SPLIT_EXIT_THRESHOLDS;
  const leverage = normalizeFuturesLeverage(input.leverage);
  const roePct = futuresRoePct(input.grossReturnPct, leverage);
  const netRoePct = futuresRoePct(input.netReturnPct, leverage);
  const peakGrossReturnPct = Math.max(input.grossReturnPct, finite(input.peakGrossReturnPct));
  const peakRoePct = futuresRoePct(peakGrossReturnPct, leverage);
  const residualProtectRoePct = input.residualStage
    ? Math.max(
      thresholds.residualProfitFloorRoePct,
      peakRoePct - thresholds.residualTrailingDrawdownRoePct,
    )
    : null;
  const base = { roePct, netRoePct, peakRoePct, residualProtectRoePct, leverage };

  // A NORMAL position that already earned T1 is a winner: the residual has its own
  // protected-trailing owner and must never be demoted into RECOVERY.
  if (input.residualStage) {
    if (roePct <= finite(residualProtectRoePct, thresholds.residualProfitFloorRoePct)) {
      return {
        ...base,
        action: "STOP",
        fraction: 1,
        reason: "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",
      };
    }
    return {
      ...base,
      action: "NONE",
      fraction: 0,
      reason: "FUTURES_RESIDUAL_PROTECTED_TRAIL_ACTIVE",
    };
  }

  // The hard stop is the final safety boundary in every pre-T1 state, including RECOVERY.
  if (roePct <= thresholds.firstStopLossRoePct) {
    return {
      ...base,
      action: "STOP",
      fraction: thresholds.hardStopFraction,
      reason: "FUTURES_HALF_STOP_LOSS_ROE_12",
    };
  }

  // RECOVERY owns the whole position once the 3-minute mission failed. It intentionally
  // takes precedence over the +15% half-TP: even a gap straight from negative to +15% is
  // closed whole, because the position already changed mission from profit-running to
  // capital recovery.
  if (input.recoveryMode) {
    if (input.executableNetAllowed && finite(input.expectedNetProfitQuote) > 0) {
      return {
        ...base,
        action: "STOP",
        fraction: 1,
        reason: "FUTURES_RECOVERY_NET_POSITIVE_EXIT",
      };
    }
    return {
      ...base,
      action: "NONE",
      fraction: 0,
      reason: "FUTURES_RECOVERY_AWAITING_NET_POSITIVE",
    };
  }

  if (roePct >= thresholds.firstTakeProfitRoePct) {
    return {
      ...base,
      action: "STOP",
      fraction: thresholds.firstTakeProfitFraction,
      reason: "FUTURES_HALF_TAKE_PROFIT_ROE_15",
    };
  }
  if (input.preT1ProfitProtectionHit === true) {
    return {
      ...base,
      action: "STOP",
      fraction: 1,
      reason: "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT",
    };
  }

  // Independent 180m tail defense for NORMAL positions only. This is not RECOVERY and it
  // does not exit every stale positive trade. It acts only on the empirically observed
  // loser class after that class has surrendered executable breakeven.
  if (finite(input.heldSeconds) >= thresholds.staleGivebackAfterSeconds) {
    if (
      peakRoePct >= thresholds.staleGivebackMinPeakRoePct &&
      netRoePct <= 0
    ) {
      return {
        ...base,
        action: "STOP",
        fraction: 1,
        reason: "FUTURES_STALE_GIVEBACK_EXIT_180M",
      };
    }
  }
  return {
    ...base,
    action: "NONE",
    fraction: 0,
    reason: input.safetyRequested
      ? "FUTURES_HALF_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
      : "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12",
  };
}

/** Every reason this policy can approve an exit with, for the order-time allow list. */
export const FUTURES_EXIT_APPROVED_REASONS: readonly FuturesSplitExitReason[] = [
  "FUTURES_HALF_TAKE_PROFIT_ROE_15",
  "FUTURES_HALF_STOP_LOSS_ROE_12",
  "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT",
  "FUTURES_RECOVERY_NET_POSITIVE_EXIT",
  "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",
  "FUTURES_STALE_GIVEBACK_EXIT_180M",
];
