import {
  CompletedExitBar,
  evaluateRegimeExit,
  ExitPolicy,
  initialExitState,
} from "./v10_lane_exit.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const baseBar: CompletedExitBar = {
  openTime: 15 * 60 * 1000,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  bbPos: -0.5,
  btc72: 0.06,
  priorFourHourLow: 98,
  continuityOk: true,
  dataFresh: true,
};

const bull: ExitPolicy = {
  key: "BULL_TEST",
  lane: "BULL",
  family: "TREND_SCALE",
  stop_roe: -12,
  t1_roe: 15,
  t1_fraction: 0.5,
  residual_floor_roe: 9,
  residual_giveback_roe: 4.5,
  target: null,
  invalidation: "FOUR_BAR_NON_BULL_AND_LOWER_BAND_LOSS",
  max_hold_h: 36,
};

Deno.test("V10 exit uses conservative stop-first ordering", () => {
  const state = initialExitState("BULL", 100, 0, 1);
  const result = evaluateRegimeExit(state, {
    ...baseBar,
    high: 106,
    low: 95,
  }, bull);
  assert(result.action === "FULL_AT_TRIGGER", "expected full stop");
  assert(result.reason === "LANE_HARD_STOP", "stop must win same-bar collision");
  assert(Math.abs((result.triggerPrice ?? 0) - 96) < 1e-9, "-12% ROE at 3x is 96 price");
});

Deno.test("BULL takes a first tranche and protects the residual", () => {
  let state = initialExitState("BULL", 100, 0, 1);
  const first = evaluateRegimeExit(state, { ...baseBar, high: 106, low: 99 }, bull);
  assert(first.action === "PARTIAL_AT_TRIGGER", "expected half take profit");
  assert(first.nextState.t1Done, "T1 must be latched");
  assert(Math.abs(first.nextState.remainingQuantity - 0.5) < 1e-9, "half should remain");
  state = first.nextState;
  const residual = evaluateRegimeExit(state, { ...baseBar, openTime: 30 * 60 * 1000, high: 107, low: 103.5, close: 104 }, bull);
  assert(residual.action === "FULL_AT_TRIGGER", "residual trail should close");
  assert(residual.reason === "RESIDUAL_PROTECTED_TRAIL", "wrong residual reason");
});

Deno.test("RANGE mean-reversion target executes at next bar open", () => {
  const range: ExitPolicy = {
    key: "RANGE_TEST",
    lane: "RANGE",
    family: "MEAN_EXIT",
    stop_roe: -12,
    t1_roe: null,
    t1_fraction: 1,
    residual_floor_roe: null,
    residual_giveback_roe: null,
    target: "FULL_BB_NEG_025",
    invalidation: "FOUR_BAR_BEAR_BREAK_AND_DEEPER_BAND",
    max_hold_h: 18,
  };
  let state = initialExitState("RANGE", 100, 0, 1);
  const signal = evaluateRegimeExit(state, { ...baseBar, bbPos: -0.2, high: 102, low: 99 }, range);
  assert(signal.action === "FULL_NEXT_OPEN", "completed bar should schedule next-open exit");
  assert(signal.triggerPrice === null, "current close is not an executable fill");
  state = signal.nextState;
  const fill = evaluateRegimeExit(state, { ...baseBar, openTime: 30 * 60 * 1000, open: 101.25 }, range);
  assert(fill.action === "FULL_AT_TRIGGER", "pending exit should fill at open");
  assert(fill.triggerPrice === 101.25, "pending exit fill price mismatch");
});

Deno.test("BEAR failed-recovery invalidation requires persistence", () => {
  const bear: ExitPolicy = {
    key: "BEAR_TEST",
    lane: "BEAR",
    family: "RECOVERY_EXIT",
    stop_roe: -18,
    t1_roe: 15,
    t1_fraction: 0.5,
    residual_floor_roe: 9,
    residual_giveback_roe: 6,
    target: "SPLIT_ROE_15_TRAIL",
    invalidation: "FOUR_BAR_FAILED_RECOVERY_NEW_LOW",
    max_hold_h: 48,
  };
  let state = initialExitState("BEAR", 100, 0, 1);
  for (let index = 0; index < 3; index += 1) {
    const result = evaluateRegimeExit(state, {
      ...baseBar,
      openTime: (index + 1) * 15 * 60 * 1000,
      open: 98,
      high: 99,
      low: 96,
      close: 97,
      bbPos: -1.1,
      btc72: -0.08,
      priorFourHourLow: 97.5,
    }, bear);
    assert(result.action === "HOLD", "invalidation fired before persistence requirement");
    state = result.nextState;
  }
  const fourth = evaluateRegimeExit(state, {
    ...baseBar,
    openTime: 4 * 15 * 60 * 1000,
    open: 98,
    high: 99,
    low: 96,
    close: 97,
    bbPos: -1.1,
    btc72: -0.08,
    priorFourHourLow: 97.5,
  }, bear);
  assert(fourth.action === "FULL_NEXT_OPEN", "fourth confirmed failure should schedule exit");
  assert(fourth.reason === "LANE_SPECIFIC_INVALIDATION", "wrong invalidation reason");
});

Deno.test("maximum hold is a final backstop", () => {
  const policy: ExitPolicy = { ...bull, stop_roe: null, t1_roe: null, invalidation: "NONE", max_hold_h: 24 };
  const state = initialExitState("BULL", 100, 0, 1);
  const result = evaluateRegimeExit(state, { ...baseBar, openTime: 24 * 60 * 60 * 1000 - 15 * 60 * 1000 }, policy);
  assert(result.action === "FULL_AT_TRIGGER", "max hold must close as final backstop");
  assert(result.reason === "MAX_HOLD_RISK_BACKSTOP", "wrong max hold reason");
});

Deno.test("unselected generated policy fails closed", () => {
  const state = initialExitState("BULL", 100, 0, 1);
  const result = evaluateRegimeExit(state, baseBar);
  assert(result.action === "RISK_CIRCUIT", "unselected policy must not trade");
});
