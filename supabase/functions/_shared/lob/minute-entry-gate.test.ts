import {
  evaluateMinuteEntryGate,
  MINUTE_ENTRY_GATE_VERSION,
  type MinuteCandle,
} from "./minute-entry-gate.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function risingCandles(nowMs: number): MinuteCandle[] {
  const start = nowMs - 30 * 60_000;
  return Array.from({ length: 24 }, (_, index) => {
    const base = 100 + index * 0.2;
    const close = base + (index >= 19 ? (index - 18) * 0.35 : 0.1);
    return {
      openTimeMs: start + index * 60_000,
      closeTimeMs: start + (index + 1) * 60_000 - 1,
      open: base,
      high: close + 0.2,
      low: base - 0.2,
      close,
    };
  });
}

Deno.test("m1 gate accepts only completed bullish candle with stochastic K above D", () => {
  const now = Date.UTC(2026, 7, 2, 14, 30, 30);
  const candles = risingCandles(now);
  candles.push({
    openTimeMs: now - 30_000,
    closeTimeMs: now + 30_000,
    open: 999,
    high: 1_000,
    low: 900,
    close: 901,
  });
  const result = evaluateMinuteEntryGate(candles, now);
  assert(result.version === MINUTE_ENTRY_GATE_VERSION);
  assert(result.previousBullish === true, "forming candle must be excluded");
  assert(result.stochK != null && result.stochD != null && result.stochK > result.stochD);
  assert(result.passed, result.reasons.join(","));
});

Deno.test("m1 gate blocks a bearish previous completed candle", () => {
  const now = Date.UTC(2026, 7, 2, 14, 30, 30);
  const candles = risingCandles(now);
  const last = candles.at(-1)!;
  last.open = last.close + 0.5;
  last.high = last.open + 0.1;
  const result = evaluateMinuteEntryGate(candles, now);
  assert(!result.passed);
  assert(result.reasons.includes("M1_PREVIOUS_CANDLE_NOT_BULLISH"));
});

Deno.test("m1 gate fails closed when completed history is insufficient", () => {
  const now = Date.UTC(2026, 7, 2, 14, 30, 30);
  const result = evaluateMinuteEntryGate(risingCandles(now).slice(-10), now);
  assert(!result.passed);
  assert(result.reasons.includes("M1_CANDLE_DATA_INSUFFICIENT"));
});
