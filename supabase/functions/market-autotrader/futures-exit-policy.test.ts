import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_FUTURES_LEVERAGE,
  FUTURES_MIN_ENTRY_MARGIN_USDT,
  FUTURES_SPLIT_EXIT_THRESHOLDS,
  futuresEntryMinimums,
  futuresPriceReturnPctForRoe,
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

Deno.test("empirical stale-giveback boundary equals the observed EPIC loser lower bound", () => {
  assertEquals(FUTURES_SPLIT_EXIT_THRESHOLDS.staleGivebackMinPeakRoePct, 2.13815789473683);
});

Deno.test("futures takes 50% at +15% ROE", () => {
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

Deno.test("futures 180m recovery exits 100% only on executable positive net for low-progress stale trades", () => {
  const before = decide({
    heldSeconds: 10_799,
    grossReturnPct: 0.5,
    peakGrossReturnPct: 0.5,
    netReturnPct: 0.4,
    executableNetAllowed: true,
    expectedNetProfitQuote: 0.2,
  });
  assertEquals(before.action, "NONE");

  const exit = decide({
    heldSeconds: 10_800,
    grossReturnPct: 0.5,
    peakGrossReturnPct: 0.5,
    netReturnPct: 0.4,
    executableNetAllowed: true,
    expectedNetProfitQuote: 0.2,
  });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.fraction, 1);
  assertEquals(exit.reason, "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M");

  const blocked = decide({
    heldSeconds: 10_800,
    grossReturnPct: -0.5,
    peakGrossReturnPct: 0.2,
    netReturnPct: -0.6,
    executableNetAllowed: false,
    expectedNetProfitQuote: -0.01,
  });
  assertEquals(blocked.action, "NONE");
  assertEquals(blocked.reason, "FUTURES_STALE_RECOVERY_AWAITING_POSITIVE_NET_180M");
});

Deno.test("EPIC live sample is cut at 180m after empirical peak giveback instead of waiting for -12% ROE", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    // EPIC: entry 0.3648, 180m price ~0.3611 => about -1.014% gross price return.
    grossReturnPct: (0.3611 / 0.3648 - 1) * 100,
    // Exact observed peak: 0.3674 / 0.3648 - 1 = +0.712719...% raw = +2.138157...% ROE.
    peakGrossReturnPct: (0.3674 / 0.3648 - 1) * 100,
    netReturnPct: (0.3611 * 0.9995 / (0.3648 * 1.0005) - 1) * 100,
    executableNetAllowed: false,
    expectedNetProfitQuote: -1,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT");
});

Deno.test("CVX live sample is also cut after 180m giveback", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    grossReturnPct: (1.7250 / 1.7252597701149426 - 1) * 100,
    peakGrossReturnPct: (1.7467632183908046 / 1.7252597701149426 - 1) * 100,
    netReturnPct: (1.7250 * 0.9995 / (1.7252597701149426 * 1.0005) - 1) * 100,
    executableNetAllowed: false,
    expectedNetProfitQuote: -0.01,
  });
  assertEquals(d.action, "STOP");
  assertEquals(d.reason, "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT");
});

Deno.test("OPEN live winner remains in recovery because its observed peak never entered the stale-loser class", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    grossReturnPct: (0.2111 / 0.2133 - 1) * 100,
    peakGrossReturnPct: (0.2139 / 0.2133 - 1) * 100,
    netReturnPct: (0.2111 * 0.9995 / (0.2133 * 1.0005) - 1) * 100,
    executableNetAllowed: false,
    expectedNetProfitQuote: -0.01,
  });
  assertEquals(d.action, "NONE");
  assertEquals(d.reason, "FUTURES_STALE_RECOVERY_AWAITING_POSITIVE_NET_180M");
});

Deno.test("EDEN live winner remains in recovery because its observed peak never entered the stale-loser class", () => {
  const d = decide({
    heldSeconds: 10_800,
    leverage: 3,
    grossReturnPct: (0.04856 / 0.04885186054089279 - 1) * 100,
    peakGrossReturnPct: (0.04896297816878462 / 0.04885186054089279 - 1) * 100,
    netReturnPct: (0.04856 * 0.9995 / (0.04885186054089279 * 1.0005) - 1) * 100,
    executableNetAllowed: false,
    expectedNetProfitQuote: -0.01,
  });
  assertEquals(d.action, "NONE");
  assertEquals(d.reason, "FUTURES_STALE_RECOVERY_AWAITING_POSITIVE_NET_180M");
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

Deno.test("futures +15% ROE target keeps precedence after 180m", () => {
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

Deno.test("futures pre-T1 earned profit floor closes 100%", () => {
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

Deno.test("futures +15% ROE target keeps precedence over pre-T1 protection", () => {
  const d = decide({
    grossReturnPct: 5.1,
    peakGrossReturnPct: 5.1,
    netReturnPct: 5,
    preT1ProfitProtectionHit: true,
  });
  assertEquals(d.fraction, 0.5);
  assertEquals(d.reason, "FUTURES_HALF_TAKE_PROFIT_ROE_15");
});
