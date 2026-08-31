import {
  V10_LANE_EXIT_POLICY,
  V10_LANE_EXIT_REVISION,
  V10_LANE_EXIT_SPEC_SHA256,
} from "./v10_lane_exit_config.ts";

export type ExitLane = "BULL" | "RANGE" | "BEAR";
export type ExitActionKind =
  | "HOLD"
  | "PARTIAL_AT_TRIGGER"
  | "FULL_AT_TRIGGER"
  | "PARTIAL_NEXT_OPEN"
  | "FULL_NEXT_OPEN"
  | "RISK_CIRCUIT";

export interface ExitPolicy {
  key: string;
  lane: ExitLane;
  family: string;
  stop_roe: number | null;
  t1_roe: number | null;
  t1_fraction: number | null;
  residual_floor_roe: number | null;
  residual_giveback_roe: number | null;
  target: string | null;
  invalidation: string;
  max_hold_h: number;
}

export interface ExitPositionState {
  lane: ExitLane;
  entryPrice: number;
  entryAt: number;
  originalQuantity: number;
  remainingQuantity: number;
  t1Done: boolean;
  peakPrice: number;
  invalidationCount: number;
  pendingFraction: number;
  pendingReason: string | null;
}

export interface CompletedExitBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bbPos: number;
  btc72: number;
  priorFourHourLow: number;
  continuityOk: boolean;
  dataFresh: boolean;
}

export interface ExitDecision {
  action: ExitActionKind;
  fraction: number;
  triggerPrice: number | null;
  reason: string;
  policyRevision: string;
  policySpecSha256: string;
  nextState: ExitPositionState;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function failClosedPolicy(value: unknown, lane: ExitLane): ExitPolicy | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.lane !== lane || typeof row.key !== "string" || typeof row.family !== "string") {
    return null;
  }
  const numericOrNull = (key: string): number | null | undefined => {
    const raw = row[key];
    if (raw === null) return null;
    return typeof raw === "number" && finite(raw) ? raw : undefined;
  };
  const stop = numericOrNull("stop_roe");
  const t1 = numericOrNull("t1_roe");
  const fraction = numericOrNull("t1_fraction");
  const floor = numericOrNull("residual_floor_roe");
  const giveback = numericOrNull("residual_giveback_roe");
  const maxHold = row.max_hold_h;
  if (
    stop === undefined || t1 === undefined || fraction === undefined || floor === undefined ||
    giveback === undefined || typeof maxHold !== "number" || !Number.isInteger(maxHold) || maxHold <= 0 ||
    typeof row.invalidation !== "string"
  ) return null;
  return {
    key: row.key,
    lane,
    family: row.family,
    stop_roe: stop,
    t1_roe: t1,
    t1_fraction: fraction,
    residual_floor_roe: floor,
    residual_giveback_roe: giveback,
    target: typeof row.target === "string" ? row.target : null,
    invalidation: row.invalidation,
    max_hold_h: maxHold,
  };
}

export function selectedExitPolicy(lane: ExitLane): ExitPolicy | null {
  return failClosedPolicy((V10_LANE_EXIT_POLICY as Record<string, unknown>)[lane], lane);
}

export function initialExitState(
  lane: ExitLane,
  entryPrice: number,
  entryAt: number,
  quantity: number,
): ExitPositionState {
  if (!(entryPrice > 0) || !(quantity > 0) || !Number.isInteger(entryAt)) {
    throw new Error("V10_EXIT_INVALID_INITIAL_STATE");
  }
  return {
    lane,
    entryPrice,
    entryAt,
    originalQuantity: quantity,
    remainingQuantity: quantity,
    t1Done: false,
    peakPrice: entryPrice,
    invalidationCount: 0,
    pendingFraction: 0,
    pendingReason: null,
  };
}

function priceForRoe(entry: number, roePct: number, leverage = 3): number {
  return entry * (1 + roePct / (100 * leverage));
}

function fractionOfRemaining(state: ExitPositionState, originalFraction: number): number {
  const originalQty = state.originalQuantity * clamp(originalFraction, 0, 1);
  return clamp(originalQty / state.remainingQuantity, 0, 1);
}

function next(
  state: ExitPositionState,
  patch: Partial<ExitPositionState>,
): ExitPositionState {
  return { ...state, ...patch };
}

function decision(
  action: ExitActionKind,
  fraction: number,
  triggerPrice: number | null,
  reason: string,
  nextState: ExitPositionState,
): ExitDecision {
  return {
    action,
    fraction: clamp(fraction, 0, 1),
    triggerPrice,
    reason,
    policyRevision: V10_LANE_EXIT_REVISION,
    policySpecSha256: V10_LANE_EXIT_SPEC_SHA256,
    nextState,
  };
}

/**
 * Apply a completed-bar decision. Intrabar stop/price target collisions are
 * deliberately stop-first. Completed-bar targets and invalidations schedule an
 * order for the next bar open and never use the current close as an executable
 * fill. The fixed maximum hold is a final backstop, not the primary exit.
 */
export function evaluateRegimeExit(
  state: ExitPositionState,
  bar: CompletedExitBar,
  policyOverride?: ExitPolicy,
): ExitDecision {
  const policy = policyOverride ?? selectedExitPolicy(state.lane);
  if (!policy || policy.lane !== state.lane) {
    return decision("RISK_CIRCUIT", 0, null, "EXIT_POLICY_UNSELECTED_FAIL_CLOSED", state);
  }
  if (
    !bar.continuityOk || !bar.dataFresh ||
    ![bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.bbPos, bar.btc72].every(finite) ||
    !(bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0) ||
    bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close, bar.high)
  ) {
    return decision("RISK_CIRCUIT", 0, null, "EXIT_DATA_FAIL_CLOSED", state);
  }
  if (state.remainingQuantity <= 0) {
    return decision("HOLD", 0, null, "POSITION_ALREADY_FLAT", state);
  }

  if (state.pendingFraction > 0) {
    const fraction = clamp(state.pendingFraction, 0, 1);
    const remaining = state.remainingQuantity * (1 - fraction);
    const action = fraction >= 0.999999 ? "FULL_AT_TRIGGER" : "PARTIAL_AT_TRIGGER";
    return decision(
      action,
      fraction,
      bar.open,
      state.pendingReason ?? "COMPLETED_BAR_EXIT_NEXT_OPEN",
      next(state, {
        remainingQuantity: remaining,
        t1Done: state.t1Done || fraction < 0.999999,
        pendingFraction: 0,
        pendingReason: null,
      }),
    );
  }

  const hardStop = policy.stop_roe === null ? null : priceForRoe(state.entryPrice, policy.stop_roe);
  let activeStop = hardStop;
  if (
    state.t1Done && policy.residual_floor_roe !== null &&
    policy.residual_giveback_roe !== null
  ) {
    const floor = priceForRoe(state.entryPrice, policy.residual_floor_roe);
    const trail = state.peakPrice * (1 - policy.residual_giveback_roe / 300);
    activeStop = Math.max(activeStop ?? 0, floor, trail);
  }

  // Stop-first is the conservative same-bar ordering assumption.
  if (activeStop !== null && activeStop > 0 && bar.low <= activeStop) {
    return decision(
      "FULL_AT_TRIGGER",
      1,
      activeStop,
      state.t1Done ? "RESIDUAL_PROTECTED_TRAIL" : "LANE_HARD_STOP",
      next(state, { remainingQuantity: 0 }),
    );
  }

  if (!state.t1Done && policy.t1_roe !== null) {
    const target = priceForRoe(state.entryPrice, policy.t1_roe);
    if (bar.high >= target) {
      const configured = policy.t1_fraction ?? 1;
      const fraction = fractionOfRemaining(state, configured);
      const remaining = state.remainingQuantity * (1 - fraction);
      return decision(
        fraction >= 0.999999 ? "FULL_AT_TRIGGER" : "PARTIAL_AT_TRIGGER",
        fraction,
        target,
        fraction >= 0.999999 ? "LANE_FULL_PRICE_TARGET" : "LANE_FIRST_TAKE_PROFIT",
        next(state, {
          remainingQuantity: remaining,
          t1Done: remaining > 0,
          peakPrice: Math.max(state.peakPrice, bar.high),
        }),
      );
    }
  }

  const peakPrice = Math.max(state.peakPrice, bar.high);
  const closeRoe = (bar.close / state.entryPrice - 1) * 300;
  let invalid = false;
  let required = 0;
  if (policy.invalidation === "FOUR_BAR_NON_BULL_AND_LOWER_BAND_LOSS") {
    const routeIsBull = bar.btc72 > 0.05;
    invalid = !routeIsBull && bar.bbPos <= -1 && closeRoe < 0;
    required = 4;
  } else if (policy.invalidation === "FOUR_BAR_BEAR_BREAK_AND_DEEPER_BAND") {
    invalid = bar.btc72 < -0.05 && bar.bbPos <= -1.5 && closeRoe < 0;
    required = 4;
  } else if (
    policy.invalidation === "FOUR_BAR_FAILED_RECOVERY_NEW_LOW" ||
    policy.invalidation === "EIGHT_BAR_FAILED_RECOVERY_NEW_LOW"
  ) {
    invalid = bar.bbPos <= -0.9 && closeRoe < 0 && bar.close < bar.priorFourHourLow;
    required = policy.invalidation.startsWith("FOUR") ? 4 : 8;
  }
  const invalidationCount = invalid ? state.invalidationCount + 1 : 0;

  let pendingFraction = 0;
  let pendingReason: string | null = null;
  if (state.lane === "RANGE") {
    if (policy.target === "FULL_BB_NEG_025" && bar.bbPos >= -0.25) {
      pendingFraction = 1; pendingReason = "RANGE_MEAN_REVERSION_NEG_025";
    } else if (policy.target === "FULL_BB_ZERO" && bar.bbPos >= 0) {
      pendingFraction = 1; pendingReason = "RANGE_MEAN_REVERSION_CENTER";
    } else if (policy.target === "SPLIT_BB_NEG_050_TO_ZERO") {
      if (!state.t1Done && bar.bbPos >= -0.5) {
        pendingFraction = fractionOfRemaining(state, 0.5);
        pendingReason = "RANGE_MEAN_REVERSION_FIRST_TRANCHE";
      } else if (state.t1Done && bar.bbPos >= 0) {
        pendingFraction = 1;
        pendingReason = "RANGE_MEAN_REVERSION_RESIDUAL_CENTER";
      }
    }
  } else if (state.lane === "BEAR") {
    if (policy.target === "FULL_BB_NEG_025" && bar.bbPos >= -0.25) {
      pendingFraction = 1; pendingReason = "BEAR_REBOUND_NEG_025";
    } else if (policy.target === "SPLIT_BB_NEG_050_TO_ZERO") {
      if (!state.t1Done && bar.bbPos >= -0.5) {
        pendingFraction = fractionOfRemaining(state, 0.5);
        pendingReason = "BEAR_REBOUND_FIRST_TRANCHE";
      } else if (state.t1Done && bar.bbPos >= 0) {
        pendingFraction = 1;
        pendingReason = "BEAR_REBOUND_RESIDUAL_CENTER";
      }
    }
  }
  if (required > 0 && invalidationCount >= required) {
    pendingFraction = 1;
    pendingReason = "LANE_SPECIFIC_INVALIDATION";
  }

  const heldMs = bar.openTime - state.entryAt + 15 * 60 * 1000;
  if (heldMs >= policy.max_hold_h * 60 * 60 * 1000) {
    return decision(
      "FULL_AT_TRIGGER",
      1,
      bar.close,
      "MAX_HOLD_RISK_BACKSTOP",
      next(state, { remainingQuantity: 0, peakPrice, invalidationCount }),
    );
  }

  if (pendingFraction > 0) {
    return decision(
      pendingFraction >= 0.999999 ? "FULL_NEXT_OPEN" : "PARTIAL_NEXT_OPEN",
      pendingFraction,
      null,
      pendingReason ?? "COMPLETED_BAR_EXIT",
      next(state, { peakPrice, invalidationCount, pendingFraction, pendingReason }),
    );
  }
  return decision(
    "HOLD",
    0,
    null,
    "LANE_EXIT_HOLD",
    next(state, { peakPrice, invalidationCount }),
  );
}
