// Trading-booooo — Binance USDⓈ-M futures split-exit policy.
//
// The entry side of the futures lane is deliberately identical to spot: same scanner,
// same LOB admission, same long-only direction. Only the SELL side changes, and it
// changes because a leveraged position measures its return on the margin it posted, not
// on the notional it controls.
//
// Operator specification:
//
//   1. Default leverage is 3x.
//   2. Measured on margin (ROE, i.e. leverage-applied return):
//        -12% -> hard stop 100%
//        +15% -> take profit on 50%
//   3. Remaining 50% after TP: protect at max(+9% ROE, peak ROE - 4.5pp).
//   4. If the +15% ROE first TP has not happened within 180 minutes, keep the -12% ROE
//      hard stop but exit 100% on the first fees/slippage-adjusted executable net profit > 0.
//
// At 3x the first TP/stop are +5%/-4% price moves. The policy is written in ROE so changing
// leverage preserves the margin-risk thresholds rather than silently changing account risk.

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
  /** First-tranche recovery mode starts after three hours without the +15% ROE TP. */
  staleRecoveryAfterSeconds: 180 * 60,
} as const;

export type FuturesSplitExitReason =
  | "FUTURES_HALF_TAKE_PROFIT_ROE_15"
  | "FUTURES_HALF_STOP_LOSS_ROE_12"
  | "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT"
  | "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12"
  | "FUTURES_HALF_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_ACTIVE"
  | "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M"
  | "FUTURES_STALE_RECOVERY_AWAITING_POSITIVE_NET_180M";

export type FuturesSplitExitInput = {
  /** True once the tradable first half has been sold and only the residual is left. */
  residualStage: boolean;
  /**
   * True once the residual has been observed at a negative return. It is latched by the
   * engine and never cleared, so "계속 음의 수익률이었으면" is answered by the position's
   * own history rather than by the current tick.
   */
  recoveryMode: boolean;
  /** Configured leverage for this position. */
  leverage: number;
  /** Price return from average entry to the executable exit price, before fees, in %. */
  grossReturnPct: number;
  /** Highest observed gross price return since entry, in %. */
  peakGrossReturnPct: number;
  /** The residual's return after both entry and exit fees, in %. */
  netReturnPct: number;
  /**
   * Whether the whole remainder can actually be sold right now against visible bid depth
   * at strictly positive net proceeds for the RESIDUAL leg (principal = remaining
   * quantity valued at average entry, plus its share of the entry fee).
   */
  executableNetAllowed: boolean;
  /** Expected net profit of that residual sale, in quote currency. */
  expectedNetProfitQuote: number;
  /** Position age used only for the first-tranche 180-minute recovery rule. */
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
  /** Leverage-applied return after the sell fee. */
  netRoePct: number;
  /** Highest observed leverage-applied gross return. */
  peakRoePct: number;
  /** Active residual protection threshold when in residual stage. */
  residualProtectRoePct: number | null;
  leverage: number;
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

/** Return on margin: a 4% price move on 3x margin is a 12% move on the money posted. */
export function futuresRoePct(priceReturnPct: number, leverage: number): number {
  return finite(priceReturnPct) * normalizeFuturesLeverage(leverage);
}

/** Price move that reaches a given ROE at this leverage. Used for planned stop/target prices. */
export function futuresPriceReturnPctForRoe(roePct: number, leverage: number): number {
  return finite(roePct) / normalizeFuturesLeverage(leverage);
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
  if (roePct <= thresholds.firstStopLossRoePct) {
    return {
      ...base,
      action: "STOP",
      fraction: thresholds.hardStopFraction,
      reason: "FUTURES_HALF_STOP_LOSS_ROE_12",
    };
  }
  if (finite(input.heldSeconds) >= thresholds.staleRecoveryAfterSeconds) {
    if (input.executableNetAllowed && finite(input.expectedNetProfitQuote) > 0) {
      return {
        ...base,
        action: "STOP",
        fraction: 1,
        reason: "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M",
      };
    }
    return {
      ...base,
      action: "NONE",
      fraction: 0,
      reason: "FUTURES_STALE_RECOVERY_AWAITING_POSITIVE_NET_180M",
    };
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
  "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",
  "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M",
];
