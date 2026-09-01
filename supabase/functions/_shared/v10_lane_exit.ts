import {
  getV10ExitPolicy,
  type V10ExitPolicy,
  V10_EXIT_BAR_INTERVAL_MS,
  V10_EXIT_DEFAULT_LEVERAGE,
  V10_EXIT_STOP_FILL_HAIRCUT,
  type V10Lane,
} from "./v10_lane_exit_config.ts";

export interface V10RawBar {
  readonly openTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface V10PreparedExitBar extends V10RawBar {
  readonly bbPos: number;
}

export interface V10ExitState {
  readonly entryBbPos: number;
  readonly remainingFraction: number;
  readonly t1Completed: boolean;
  readonly t1AtMs: number | null;
  readonly trailArmed: boolean;
  readonly trailArmedAtMs: number | null;
  readonly peakPrice: number;
  readonly failureChecked: boolean;
  readonly terminal: boolean;
  readonly lastEvaluatedBarOpenMs: number | null;
}

export interface V10ExitPositionInput {
  readonly lane: V10Lane;
  readonly entryPrice: number;
  readonly openedAtMs: number;
  readonly leverage?: number;
  readonly state: V10ExitState;
}

export type V10ExitAction =
  | "HOLD"
  | "PARTIAL_AT_TRIGGER"
  | "FULL_AT_TRIGGER"
  | "FULL_NEXT_OPEN"
  | "RISK_CIRCUIT";

export type V10ExitReason =
  | "NO_EXIT"
  | "MAX_HOLD_BACKSTOP"
  | "T1_FIXED"
  | "RESIDUAL_PROTECTION"
  | "FULL_PROFIT_TRAIL"
  | "FULL_STATE_TARGET"
  | "STATE_RECOVERY_FAILED"
  | "UNVALIDATED_LANE_LIVE_BLOCK"
  | "INVALID_INPUT"
  | "DUPLICATE_OR_STALE_BAR";

export interface V10ExitDecision {
  readonly action: V10ExitAction;
  readonly reason: V10ExitReason;
  readonly fraction: number;
  readonly triggerPrice: number | null;
  readonly executeAtNextOpen: boolean;
  readonly policyKey: string;
  readonly policyValidated: boolean;
  readonly nextState: V10ExitState;
  readonly diagnostics: Readonly<Record<string, number | string | boolean | null>>;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sampleStandardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  const sd = Math.sqrt(variance);
  return Number.isFinite(sd) && sd > 0 ? sd : null;
}

/** Research parity: bb_pos=(close-SMA20)/(2*stddev_samp20). */
export function calculateV10BbPosition(closes: readonly number[]): number | null {
  if (closes.length < 20) return null;
  const window = closes.slice(-20);
  if (!window.every(finitePositive)) return null;
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
  const sd = sampleStandardDeviation(window);
  if (sd === null) return null;
  const value = (window[window.length - 1] - mean) / (2 * sd);
  return Number.isFinite(value) ? value : null;
}

export function prepareV10ExitBars(rawBars: readonly V10RawBar[]): V10PreparedExitBar[] {
  const ordered = [...rawBars].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const closes: number[] = [];
  const output: V10PreparedExitBar[] = [];
  for (const bar of ordered) {
    closes.push(bar.close);
    const bbPos = calculateV10BbPosition(closes);
    if (bbPos === null) continue;
    output.push({ ...bar, bbPos });
  }
  return output;
}

export function initialV10ExitState(entryPrice: number, entryBbPos: number): V10ExitState {
  if (!finitePositive(entryPrice) || !Number.isFinite(entryBbPos)) {
    throw new Error("invalid V10 exit state seed");
  }
  return {
    entryBbPos,
    remainingFraction: 1,
    t1Completed: false,
    t1AtMs: null,
    trailArmed: false,
    trailArmedAtMs: null,
    peakPrice: entryPrice,
    failureChecked: false,
    terminal: false,
    lastEvaluatedBarOpenMs: null,
  };
}

function roePrice(entryPrice: number, roePct: number, leverage: number): number {
  return entryPrice * (1 + roePct / (100 * leverage));
}

function stopFill(barOpen: number, stopPrice: number): number {
  return Math.min(barOpen, stopPrice * (1 - V10_EXIT_STOP_FILL_HAIRCUT));
}

function holdDecision(
  policy: V10ExitPolicy,
  state: V10ExitState,
  diagnostics: V10ExitDecision["diagnostics"] = {},
  reason: V10ExitReason = "NO_EXIT",
): V10ExitDecision {
  return {
    action: "HOLD",
    reason,
    fraction: 0,
    triggerPrice: null,
    executeAtNextOpen: false,
    policyKey: policy.key,
    policyValidated: policy.validated,
    nextState: state,
    diagnostics,
  };
}

function terminalState(state: V10ExitState, barOpenMs: number): V10ExitState {
  return {
    ...state,
    remainingFraction: 0,
    terminal: true,
    lastEvaluatedBarOpenMs: barOpenMs,
  };
}

function decision(
  policy: V10ExitPolicy,
  state: V10ExitState,
  bar: V10PreparedExitBar,
  action: V10ExitAction,
  reason: V10ExitReason,
  fraction: number,
  triggerPrice: number | null,
  executeAtNextOpen: boolean,
  diagnostics: V10ExitDecision["diagnostics"] = {},
): V10ExitDecision {
  return {
    action,
    reason,
    fraction: clamp01(fraction),
    triggerPrice,
    executeAtNextOpen,
    policyKey: policy.key,
    policyValidated: policy.validated,
    nextState: action === "PARTIAL_AT_TRIGGER"
      ? state
      : terminalState(state, bar.openTimeMs),
    diagnostics,
  };
}

export function evaluateV10ExitBar(
  position: V10ExitPositionInput,
  bar: V10PreparedExitBar,
  options: { readonly liveMode?: boolean } = {},
): V10ExitDecision {
  const policy = getV10ExitPolicy(position.lane);
  const leverage = position.leverage ?? V10_EXIT_DEFAULT_LEVERAGE;
  const state = position.state;

  if (
    !finitePositive(position.entryPrice) || !finitePositive(leverage) ||
    !finitePositive(bar.open) || !finitePositive(bar.high) ||
    !finitePositive(bar.low) || !finitePositive(bar.close) ||
    !Number.isFinite(bar.bbPos) || !Number.isFinite(position.openedAtMs)
  ) {
    return {
      action: "RISK_CIRCUIT",
      reason: "INVALID_INPUT",
      fraction: 0,
      triggerPrice: null,
      executeAtNextOpen: false,
      policyKey: policy.key,
      policyValidated: policy.validated,
      nextState: state,
      diagnostics: { lane: position.lane },
    };
  }

  if (options.liveMode && (!policy.validated || !policy.liveEligible || policy.shadowOnly)) {
    return {
      action: "RISK_CIRCUIT",
      reason: "UNVALIDATED_LANE_LIVE_BLOCK",
      fraction: 0,
      triggerPrice: null,
      executeAtNextOpen: false,
      policyKey: policy.key,
      policyValidated: policy.validated,
      nextState: state,
      diagnostics: { lane: position.lane, finalEligible: policy.researchMetrics.finalEligible },
    };
  }

  if (
    state.terminal || state.remainingFraction <= 0 ||
    (state.lastEvaluatedBarOpenMs !== null && bar.openTimeMs <= state.lastEvaluatedBarOpenMs)
  ) {
    return holdDecision(policy, state, {}, "DUPLICATE_OR_STALE_BAR");
  }

  const completedAtMs = bar.openTimeMs + V10_EXIT_BAR_INTERVAL_MS;
  const maxHoldAtMs = position.openedAtMs + policy.maxHoldHours * 3_600_000;
  const bbImprovement = bar.bbPos - state.entryBbPos;
  const closeReturn = bar.close / position.entryPrice - 1;

  if (bar.openTimeMs >= maxHoldAtMs) {
    return decision(policy, state, bar, "FULL_AT_TRIGGER", "MAX_HOLD_BACKSTOP",
      state.remainingFraction, bar.open, false,
      { maxHoldAtMs, completedAtMs, bbImprovement, closeReturn });
  }

  if (
    position.lane === "BULL" && state.t1Completed && state.t1AtMs !== null &&
    bar.openTimeMs >= state.t1AtMs
  ) {
    const floorPrice = roePrice(position.entryPrice, policy.residualFloorRoe ?? 0, leverage);
    const trailPrice = state.peakPrice *
      (1 - (policy.trailGivebackRoe ?? 0) / (100 * leverage));
    const protectiveStop = Math.max(floorPrice, trailPrice);
    if (bar.low <= protectiveStop) {
      return decision(policy, state, bar, "FULL_AT_TRIGGER", "RESIDUAL_PROTECTION",
        state.remainingFraction, stopFill(bar.open, protectiveStop), false,
        { protectiveStop, floorPrice, trailPrice, bbImprovement, closeReturn });
    }
  }

  if (
    position.lane === "RANGE" && state.trailArmed &&
    state.trailArmedAtMs !== null && bar.openTimeMs > state.trailArmedAtMs
  ) {
    const trailPrice = state.peakPrice *
      (1 - (policy.trailGivebackRoe ?? 0) / (100 * leverage));
    const protectiveStop = Math.max(position.entryPrice, trailPrice);
    if (bar.low <= protectiveStop) {
      return decision(policy, state, bar, "FULL_AT_TRIGGER", "FULL_PROFIT_TRAIL",
        state.remainingFraction, stopFill(bar.open, protectiveStop), false,
        { protectiveStop, trailPrice, bbImprovement, closeReturn });
    }
  }

  if (position.lane === "BULL" && !state.t1Completed) {
    const t1Price = roePrice(position.entryPrice, policy.t1Roe ?? 0, leverage);
    if (bar.high >= t1Price) {
      const fraction = Math.min(policy.t1Fraction ?? 0.5, state.remainingFraction);
      const nextState: V10ExitState = {
        ...state,
        remainingFraction: clamp01(state.remainingFraction - fraction),
        t1Completed: true,
        t1AtMs: completedAtMs,
        peakPrice: t1Price,
        lastEvaluatedBarOpenMs: bar.openTimeMs,
      };
      return {
        action: "PARTIAL_AT_TRIGGER",
        reason: "T1_FIXED",
        fraction,
        triggerPrice: t1Price,
        executeAtNextOpen: false,
        policyKey: policy.key,
        policyValidated: policy.validated,
        nextState,
        diagnostics: { t1Price, bbImprovement, closeReturn },
      };
    }
  }

  if (
    (position.lane === "RANGE" || position.lane === "BEAR") &&
    policy.targetBbImprovement !== undefined &&
    bbImprovement >= policy.targetBbImprovement
  ) {
    return decision(policy, state, bar, "FULL_NEXT_OPEN", "FULL_STATE_TARGET",
      state.remainingFraction, null, true,
      { bbImprovement, targetBbImprovement: policy.targetBbImprovement, closeReturn });
  }

  if (position.lane === "RANGE" && !state.trailArmed) {
    const armPrice = roePrice(position.entryPrice, policy.trailArmRoe ?? 0, leverage);
    if (bar.high >= armPrice) {
      const nextState: V10ExitState = {
        ...state,
        trailArmed: true,
        trailArmedAtMs: bar.openTimeMs,
        peakPrice: armPrice,
        lastEvaluatedBarOpenMs: bar.openTimeMs,
      };
      return holdDecision(policy, nextState, { armPrice, bbImprovement, closeReturn });
    }
  }

  let nextState = state;
  if (
    position.lane === "BEAR" && !state.failureChecked &&
    policy.failureAfterHours !== undefined &&
    completedAtMs >= position.openedAtMs + policy.failureAfterHours * 3_600_000
  ) {
    nextState = { ...state, failureChecked: true };
    if (
      closeReturn <= (policy.failureMaxReturn ?? 0) &&
      bbImprovement <= (policy.failureMaxBbImprovement ?? 0)
    ) {
      return decision(policy, nextState, bar, "FULL_NEXT_OPEN", "STATE_RECOVERY_FAILED",
        state.remainingFraction, null, true,
        { bbImprovement, failureMaxBbImprovement: policy.failureMaxBbImprovement ?? null,
          closeReturn, failureMaxReturn: policy.failureMaxReturn ?? null });
    }
  }

  let peakPrice = nextState.peakPrice;
  if (
    position.lane === "BULL" && nextState.t1Completed && nextState.t1AtMs !== null &&
    bar.openTimeMs >= nextState.t1AtMs
  ) peakPrice = Math.max(peakPrice, bar.high);
  if (
    position.lane === "RANGE" && nextState.trailArmed &&
    nextState.trailArmedAtMs !== null && bar.openTimeMs > nextState.trailArmedAtMs
  ) peakPrice = Math.max(peakPrice, bar.high);

  nextState = { ...nextState, peakPrice, lastEvaluatedBarOpenMs: bar.openTimeMs };
  return holdDecision(policy, nextState,
    { bbImprovement, closeReturn, completedAtMs, maxHoldAtMs });
}

export function evaluateV10ExitSeries(
  position: Omit<V10ExitPositionInput, "state"> & { readonly state: V10ExitState },
  bars: readonly V10PreparedExitBar[],
  options: { readonly liveMode?: boolean } = {},
): V10ExitDecision[] {
  const decisions: V10ExitDecision[] = [];
  let state = position.state;
  for (const bar of [...bars].sort((a, b) => a.openTimeMs - b.openTimeMs)) {
    const result = evaluateV10ExitBar({ ...position, state }, bar, options);
    decisions.push(result);
    state = result.nextState;
    if (state.terminal || result.action === "RISK_CIRCUIT") break;
  }
  return decisions;
}
