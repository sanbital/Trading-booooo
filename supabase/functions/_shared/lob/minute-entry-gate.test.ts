import {
  evaluateMinuteEntryGate,
  MINUTE_ENTRY_GATE_VERSION,
  type MinuteCandle,
} from "./minute-entry-gate.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function candidate(now: number, step: number): MinuteCandle[] {
  const start = now - 50 * 60_000;
  return Array.from({ length: 44 }, (_, index) => {
    // The reference window is volatile, then compresses before a two-candle release.
    // This is a real squeeze rather than an always-flat series.
    const quietAmplitude = index < 22 ? 0.08 : 0.004;
    const quiet = Math.sin(index * 1.7) * quietAmplitude;
    const launch = index >= 42 ? (index - 41) * step : 0;
    const close = 100 + quiet + launch;
    const open = close - (index >= 38 ? Math.max(0.004, step * 0.35) : 0.003);
    return {
      openTimeMs: start + index * 60_000,
      closeTimeMs: start + (index + 1) * 60_000 - 1,
      open,
      high: Math.max(open, close) + 0.035,
      low: Math.min(open, close) - 0.035,
      close,
      volume: index === 43 ? 180 : 100 + (index % 4) * 3,
    };
  });
}

Deno.test("pre-breakout gate has an admissible small-candle squeeze-release zone", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  let accepted = null;
  for (const step of [0.006, 0.008, 0.01, 0.012, 0.015, 0.018, 0.02]) {
    const result = evaluateMinuteEntryGate(candidate(now, step), now);
    if (result.passed) {
      accepted = result;
      break;
    }
  }
  assert(accepted, "no synthetic pre-breakout setup passed");
  assert(accepted.version === MINUTE_ENTRY_GATE_VERSION);
  assert(accepted.preBreakout && accepted.squeezeRelease);
  assert(accepted.bodyAtrRatio != null && accepted.bodyAtrRatio <= 0.75);
});

Deno.test("a completed giant bullish candle is never a new entry", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  const candles = candidate(now, 0.012);
  const last = candles.at(-1)!;
  last.open = last.close - 0.8;
  last.low = last.open - 0.05;
  last.high = last.close + 0.05;
  last.volume = 400;
  const result = evaluateMinuteEntryGate(candles, now);
  assert(!result.passed);
  assert(result.reasons.includes("M1_CANDLE_ALREADY_EXTENDED"));
});

Deno.test("forming candle is excluded and insufficient history fails closed", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  const candles = candidate(now, 0.012);
  candles.push({
    openTimeMs: now - 30_000,
    closeTimeMs: now + 30_000,
    open: 999,
    high: 1000,
    low: 800,
    close: 801,
    volume: 9999,
  });
  const result = evaluateMinuteEntryGate(candles, now);
  assert(result.latestClose !== 801, "forming candle leaked into the gate");
  const short = evaluateMinuteEntryGate(candles.slice(-10), now);
  assert(!short.passed && short.reasons.includes("M1_CANDLE_DATA_INSUFFICIENT"));
});
