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
//        -12% -> stop out HALF the position
//        +15% -> take profit on HALF the position
//   3. The remaining half:
//        - if it has been running at a NEGATIVE return, sell the whole remainder the
//          moment that return flips positive;
//        - otherwise take profit at +30% ROE.
//
// At 3x these ROE gates are exactly -4% / +5% / +10% on price, which is the same shape as
// the spot half-hold policy. The policy is written in ROE rather than price so changing
// the configured leverage moves the price gates with it instead of silently changing how
// much of the account each rule risks.

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
} as const;

export type FuturesSplitExitReason =
  | "FUTURES_HALF_TAKE_PROFIT_ROE_15"
  | "FUTURES_HALF_STOP_LOSS_ROE_12"
  | "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12"
  | "FUTURES_HALF_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_ACTIVE";

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

/**
 * Latch for rule 3. The residual enters recovery as soon as it is seen underwater, whether
 * that is because the first half stopped out at -12% ROE (the residual is underwater by
 * construction at that moment) or because a residual that had taken the +15% half profit
 * later fell back below its entry. Once latched it stays latched, so the position leaves
 * at the flip back to positive rather than at the next threshold.
 */
export function futuresRecoveryLatched(input: {
  residualStage: boolean;
  alreadyLatched: boolean;
  netReturnPct: number;
}): boolean {
  if (input.alreadyLatched) return true;
  return Boolean(input.residualStage) && finite(input.netReturnPct) < 0;
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
  if (roePct <= thresholds.firstStopLossRoePct) {
    return {
      ...base,
      action: "STOP",
      fraction: thresholds.hardStopFraction,
      reason: "FUTURES_HALF_STOP_LOSS_ROE_12",
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
  "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",
];
