import { resolveFinalLobAdmission } from "./final-entry-gate.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("futures final M1 failure is a hard veto even when executable LOB passes", () => {
  const result = resolveFinalLobAdmission(
    "binance_futures",
    true,
    [],
    false,
    ["M1_PREVIOUS_CANDLE_NOT_BULLISH", "M1_STOCH_K_NOT_ABOVE_D"],
  );
  assert(!result.passed);
  assert(result.blockingReasons.includes("M1_PREVIOUS_CANDLE_NOT_BULLISH"));
  assert(result.blockingReasons.includes("M1_STOCH_K_NOT_ABOVE_D"));
  assert(!result.minuteGateAdvisory);
  assert(result.minuteGateAdvisoryReasons.length === 0);
});

Deno.test("futures current LOB safety veto remains authoritative", () => {
  const result = resolveFinalLobAdmission(
    "binance_futures",
    false,
    ["SELL_PRESSURE_DOMINANT", "BUY_PRESSURE_NOT_CONFIRMED"],
    true,
    [],
  );
  assert(!result.passed);
  assert(result.blockingReasons.includes("SELL_PRESSURE_DOMINANT"));
  assert(result.blockingReasons.includes("BUY_PRESSURE_NOT_CONFIRMED"));
});

Deno.test("futures simultaneous M1 and executable depth failures are both preserved", () => {
  const result = resolveFinalLobAdmission(
    "binance_futures",
    false,
    ["PREORDER_ASK_DEPTH_DROPPED"],
    false,
    ["M1_PREVIOUS_CANDLE_NOT_BULLISH"],
  );
  assert(!result.passed);
  assert(result.blockingReasons.length === 2);
  assert(result.blockingReasons.includes("PREORDER_ASK_DEPTH_DROPPED"));
  assert(result.blockingReasons.includes("M1_PREVIOUS_CANDLE_NOT_BULLISH"));
  assert(result.minuteGateAdvisoryReasons.length === 0);
});

Deno.test("spot keeps the hard final M1 gate", () => {
  const result = resolveFinalLobAdmission(
    "binance",
    true,
    [],
    false,
    ["M1_UPPER_BAND_NOT_TOUCHED"],
  );
  assert(!result.passed);
  assert(!result.minuteGateAdvisory);
  assert(result.blockingReasons[0] === "M1_UPPER_BAND_NOT_TOUCHED");
});
