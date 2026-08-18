import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_FUTURES_LEVERAGE,
  FUTURES_MIN_ENTRY_MARGIN_USDT,
  FUTURES_SPLIT_EXIT_THRESHOLDS,
  futuresEntryMinimums,
  futuresPriceReturnPctForRoe,
  futuresRecoveryState,
  futuresRoePct,
  futuresSplitExitDecision,
  normalizeFuturesLeverage,
} from "./futures-exit-policy.ts";

function decide(overrides: Record<string, unknown> = {}) {
  return futuresSplitExitDecision({
    residualStage: false,
    recoveryMode: false,
    leverage: DEFAULT_FUTURES_LEVERAGE,
    grossReturnPct: 0,
    peakGrossReturnPct: 0,
    netReturnPct: 0,
    executableNetAllowed: false,
    expectedNetProfitQuote: -1,
    heldSeconds: 0,
    preT1ProfitProtectionHit: false,
    safetyRequested: false,
    ...overrides,
  });
}

Deno.test("default futures leverage remains 3x", () => {
  assertEquals(DEFAULT_FUTURES_LEVERAGE, 3);
  assertEquals(normalizeFuturesLeverage(undefined), 3);
});

Deno.test("futures entry floor remains 50 USDT margin", () => {
  assertEquals(FUTURES_MIN_ENTRY_MARGIN_USDT, 50);
  assertEquals(futuresEntryMinimums(3, 5), { marginQuote: 50, notionalQuote: 150, leverage: 3 });
});

Deno.test("3x converts -4/+5 price return to -12/+15 ROE", () => {
  assertEquals(futuresRoePct(-4, 3), -12);
  assertEquals(futuresRoePct(5, 3), 15);
  assertEquals(futuresPriceReturnPctForRoe(-12, 3), -4);
  assertEquals(futuresPriceReturnPctForRoe(15, 3), 5);
});

Deno.test("futures recovery and stale-giveback clocks are intentionally separate", () => {
  assertEquals(FUTURES_SPLIT_EXIT_THRESHOLDS.recoveryLatchAfterSeconds, 180);
  assertEquals(FUTURES_SPLIT_EXIT_THRESHOLDS.staleGivebackAfterSeconds, 10_800);
});

Deno.test("empirical stale-giveback boundary equals the observed EPIC loser lower bound", () => {
  assertEquals(FUTURES_SPLIT_EXIT_THRESHOLDS.staleGivebackMinPeakRoePct, 2.13815789473683);
});

Deno.test("RECOVERY does not latch before the 3-minute mission horizon", () => {
  assertEquals(
    futuresRecoveryState({
      residualStage: false,
      alreadyLatched: false,
      heldSeconds: 179,
      netReturnPct: -2,
    }),
    { enabled: false, newlyLatched: false },
  );
});

Deno.test("RECOVERY permanently latches at 3 minutes when whole-position executable net is non-positive", () => {
  assertEquals(
    futuresRecoveryState({
      residualStage: false,
      alreadyLatched: false,
      heldSeconds: 180,
      netReturnPct: -0.01,
    }),
    { enabled: true, newlyLatched: true },
  );
  assertEquals(
    futuresRecoveryState({
      residualStage: false,
      alreadyLatched: false,
      heldSeconds: 180,
      netReturnPct: 0,
    }),
    { enabled: true, newlyLatched: true },
  );
});

Deno.test("positive whole-position executable net at 3 minutes stays NORMAL", () => {
  assertEquals(
    futuresRecoveryState({
      residualStage: false,
      alreadyLatched: false,
      heldSeconds: 180,
      netReturnPct: 0.01,
    }),
    { enabled: false, newlyLatched: false },
  );
});

Deno.test("RECOVERY latch survives a later positive tick", () => {
  assertEquals(
    futuresRecoveryState({
      residualStage: false,
      alreadyLatched: true,
      heldSeconds: 600,
      netReturnPct: 2,
    }),
    { enabled: true, newlyLatched: false },
  );
});

Deno.test("normal T1 residual is never demoted into RECOVERY", () => {
  assertEquals(
    futuresRecoveryState({
      residualStage: true,
      alreadyLatched: true,
      heldSeconds: 20_000,
      netReturnPct: -1,
    }),
    { enabled: false, newlyLatched: false },
  );
});

Deno.test("NORMAL futures takes 50% at +15% ROE", () => {
  const d = decide({ grossReturnPct: 5, peakGrossReturnPct: 5 });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 0.5);
  assertEquals(d.reason, "FUTURES_HALF_TAKE_PROFIT_ROE_15");
});

Deno.test("futures hard stop closes 100% at -12% ROE", () => {
  const d = decide({ grossReturnPct: -4, peakGrossReturnPct: 0 });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_HALF_STOP_LOSS_ROE_12");
});

Deno.test("RECOVERY still respects the -12% ROE last-resort hard stop", () => {
  const d = decide({
    recoveryMode: true,
    grossReturnPct: -4,
    peakGrossReturnPct: 0,
    netReturnPct: -4.1,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_HALF_STOP_LOSS_ROE_12");
});

Deno.test("RECOVERY waits while executable whole-position net is not positive", () => {
  const d = decide({
    recoveryMode: true,
    grossReturnPct: -0.1,
    peakGrossReturnPct: 1,
    netReturnPct: -0.2,
    executableNetAllowed: false,
    expectedNetProfitQuote: -0.01,
  });
  assertEquals(d.action, "NONE");
  assertEquals(d.reason, "FUTURES_RECOVERY_AWAITING_NET_POSITIVE");
});

Deno.test("RECOVERY exits 100% on the first executable whole-position net profit", () => {
  const d = decide({
    recoveryMode: true,
    grossReturnPct: 0.3,
    peakGrossReturnPct: 1,
    netReturnPct: 0.2,
    executableNetAllowed: true,
    expectedNetProfitQuote: 0.05,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_RECOVERY_NET_POSITIVE_EXIT");
});

Deno.test("RECOVERY full exit takes precedence even if price jumps through +15% ROE", () => {
  const d = decide({
    recoveryMode: true,
    grossReturnPct: 5.2,
    peakGrossReturnPct: 5.2,
    netReturnPct: 5.1,
    executableNetAllowed: true,
    expectedNetProfitQuote: 1,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_RECOVERY_NET_POSITIVE_EXIT");
});

Deno.test("EPIC path: 3m failure latches RECOVERY and later executable breakeven exits whole", () => {
  const entry = 0.3648;
  const stateAt3m = futuresRecoveryState({
    residualStage: false,
    alreadyLatched: false,
    heldSeconds: 180,
    // EPIC was already below entry around the 3-minute mission horizon.
    netReturnPct: -0.9,
  });
  assertEquals(stateAt3m, { enabled: true, newlyLatched: true });

  // Later live executable quote recorded by the bot was about 0.36622697, above the
  // fee-adjusted breakeven. Under the intended state machine this is the exit tick.
  const executablePrice = 0.366226969844358;
  const d = decide({
    heldSeconds: 15_000,
    recoveryMode: stateAt3m.enabled,
    grossReturnPct: (executablePrice / entry - 1) * 100,
    peakGrossReturnPct: (0.3674 / entry - 1) * 100,
    netReturnPct: (executablePrice * 0.9995 / (entry * 1.0005) - 1) * 100,
    executableNetAllowed: true,
    expectedNetProfitQuote: 0.4,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_RECOVERY_NET_POSITIVE_EXIT");
});

Deno.test("futures residual at +15% ROE peak protects at +10.5% ROE", () => {
  const hold = decide({ residualStage: true, grossReturnPct: 3.6, peakGrossReturnPct: 5 });
  assertEquals(hold.action, "NONE");
  assertEquals(hold.peakRoePct, 15);
  assertEquals(hold.residualProtectRoePct, 10.5);
  const exit = decide({ residualStage: true, grossReturnPct: 3.5, peakGrossReturnPct: 5 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.fraction, 1);
});

Deno.test("futures +24% ROE peak exits residual at +19.5% ROE", () => {
  const d = decide({ residualStage: true, grossReturnPct: 6.5, peakGrossReturnPct: 8 });
  assertEquals(d.peakRoePct, 24);
  assertEquals(d.residualProtectRoePct, 19.5);
  assertEquals(d.action, "STOP");
  assertEquals(d.reason, "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT");
});

Deno.test("futures residual protection floor is never below +9% ROE", () => {
  const d = decide({ residualStage: true, grossReturnPct: 3, peakGrossReturnPct: 4 });
  assertEquals(d.residualProtectRoePct, 9);
  assertEquals(d.action, "STOP");
});

Deno.test("EPIC stale-giveback class remains independently defended at 180m in NORMAL state", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    grossReturnPct: (0.3611 / 0.3648 - 1) * 100,
    peakGrossReturnPct: (0.3674 / 0.3648 - 1) * 100,
    netReturnPct: (0.3611 * 0.9995 / (0.3648 * 1.0005) - 1) * 100,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_STALE_GIVEBACK_EXIT_180M");
});

Deno.test("CVX live stale loser class is also cut after 180m giveback", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    grossReturnPct: (1.7250 / 1.7252597701149426 - 1) * 100,
    peakGrossReturnPct: (1.7467632183908046 / 1.7252597701149426 - 1) * 100,
    netReturnPct: (1.7250 * 0.9995 / (1.7252597701149426 * 1.0005) - 1) * 100,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.reason, "FUTURES_STALE_GIVEBACK_EXIT_180M");
});

Deno.test("OPEN live sample is not in the empirical stale-loser peak class", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    grossReturnPct: (0.2111 / 0.2133 - 1) * 100,
    peakGrossReturnPct: (0.2139 / 0.2133 - 1) * 100,
    netReturnPct: (0.2111 * 0.9995 / (0.2133 * 1.0005) - 1) * 100,
  });
  assertEquals(d.action, "NONE");
  assertEquals(d.reason, "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12");
});

Deno.test("EDEN live sample is not in the empirical stale-loser peak class", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    grossReturnPct: (0.04856 / 0.04885186054089279 - 1) * 100,
    peakGrossReturnPct: (0.04896297816878462 / 0.04885186054089279 - 1) * 100,
    netReturnPct: (0.04856 * 0.9995 / (0.04885186054089279 * 1.0005) - 1) * 100,
  });
  assertEquals(d.action, "NONE");
  assertEquals(d.reason, "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12");
});

Deno.test("empirical stale-giveback guard does not fire before 180m", () => {
  const d = decide({
    heldSeconds: 10_799,
    leverage: 3,
    grossReturnPct: -1,
    peakGrossReturnPct: 1,
    netReturnPct: -1.1,
  });
  assertEquals(d.action, "NONE");
  assertEquals(d.reason, "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12");
});

Deno.test("NORMAL +15% ROE target keeps precedence after 180m", () => {
  const d = decide({
    heldSeconds: 20_000,
    grossReturnPct: 5,
    peakGrossReturnPct: 5,
    netReturnPct: 4.9,
    executableNetAllowed: true,
    expectedNetProfitQuote: 1,
  });
  assertEquals(d.fraction, 0.5);
  assertEquals(d.reason, "FUTURES_HALF_TAKE_PROFIT_ROE_15");
});

Deno.test("futures pre-T1 earned profit floor closes 100% in NORMAL state", () => {
  const d = decide({
    grossReturnPct: 2.5,
    peakGrossReturnPct: 3,
    netReturnPct: 2.4,
    preT1ProfitProtectionHit: true,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT");
});

Deno.test("NORMAL +15% ROE target keeps precedence over pre-T1 protection", () => {
  const d = decide({
    grossReturnPct: 5.1,
    peakGrossReturnPct: 5.1,
    netReturnPct: 5,
    preT1ProfitProtectionHit: true,
  });
  assertEquals(d.fraction, 0.5);
  assertEquals(d.reason, "FUTURES_HALF_TAKE_PROFIT_ROE_15");
});
