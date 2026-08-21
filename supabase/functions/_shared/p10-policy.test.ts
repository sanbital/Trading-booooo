import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectLatestP10Signal,
  evaluateP10Exit,
  P10_CONFIG,
  P10_HOUR_MS,
  p10ExactFuturesTicketCapital,
  p10ExecutableTicketCapital,
  type P10PreparedBar,
  planP10Entry,
} from "./p10-policy.ts";

Deno.test("P10 permits one executable minimum ticket when slot division falls below it", () => {
  assertEquals(
    p10ExecutableTicketCapital({
      available: 119.90743764675331,
      capital: 119.90743764675331,
      slots: 3,
      maximum: 40,
      minimum: 40,
      step: 0.01,
    }),
    40,
  );
  assertEquals(
    p10ExecutableTicketCapital({
      available: 66.65928212,
      capital: 66.65928212,
      slots: 3,
      maximum: 50,
      minimum: 50,
      step: 0.01,
    }),
    50,
  );
  assertEquals(
    p10ExecutableTicketCapital({
      available: 16.65928212,
      capital: 66.65928212,
      slots: 3,
      maximum: 50,
      minimum: 50,
      step: 0.01,
    }),
    16.65,
  );
});

function directionalBars(direction: 1 | -1) {
  const bars = [];
  let close = 100;
  for (let index = 0; index < 130; index++) {
    const prior = close;
    close += direction * (index % 2 === 0 ? 0.4 : -0.2);
    if (index === 129) close += direction * 1.2;
    bars.push({
      time: (index + 1) * P10_HOUR_MS,
      open: prior,
      high: Math.max(prior, close) + 0.2,
      low: Math.min(prior, close) - 0.25,
      close,
      volume: 10_000,
      quoteVolume: index === 129 ? 10_000_000 : 1_000_000,
    });
  }
  return bars;
}

Deno.test("P10 detects completed-bar long breakouts and keeps spot long-only", () => {
  const bull = directionalBars(1);
  const long = detectLatestP10Signal("binance_spot", bull, bull);
  assertEquals(long?.side, "LONG");

  const bear = directionalBars(-1);
  assertEquals(detectLatestP10Signal("binance_spot", bear, bear), null);
  assertEquals(detectLatestP10Signal("binance_futures", bear, bear)?.side, "SHORT");
});

Deno.test("P10 entry uses 2 ATR stop, 2R partial, 4R final and rejects late gaps", () => {
  const plan = planP10Entry("LONG", 100, 1, 100.25);
  assert(plan.allowed);
  assertEquals(plan.initialRisk, 2);
  assertEquals(plan.stopPrice, 98.25);
  assertEquals(plan.partialTarget, 104.25);
  assertEquals(plan.finalTarget, 108.25);
  assertEquals(planP10Entry("LONG", 100, 1, 100.51).allowed, false);
});

Deno.test("P10 stop wins a same-tick collision", () => {
  const decision = evaluateP10Exit({
    side: "LONG",
    entryPrice: 100,
    initialRisk: 2,
    currentStop: 98,
    partialDone: false,
    executablePrice: 97,
    entryBarTime: 0,
    openedAtMs: 0,
    nowMs: P10_HOUR_MS,
    lastPolicyBarTime: 0,
    latestCompletedBar: null,
    roundTripCostBps: 20,
  });
  assertEquals(decision.action, "STOP");
  assertEquals(decision.fraction, 1);
});

Deno.test("P10 slow exit updates trail on a completed bar and supports short partial", () => {
  const completed = {
    time: P10_HOUR_MS,
    open: 100,
    high: 104,
    low: 99,
    close: 103.5,
    volume: 1,
    quoteVolume: 100,
    ema20: 101,
    ema50: 100,
    ema100: 99,
    ema20Slope6Pct: 1,
    atr14: 1,
    rsi14: 60,
    ret24Pct: 2,
    ret72Pct: 4,
    efficiency24: 0.5,
    high72Prev: 103,
    low72Prev: 90,
    volumeRatio: 2,
    quoteVolumeMean20: 100,
  } satisfies P10PreparedBar;
  const long = evaluateP10Exit({
    side: "LONG",
    entryPrice: 100,
    initialRisk: 2,
    currentStop: 96,
    partialDone: false,
    executablePrice: 101,
    entryBarTime: 0,
    openedAtMs: 0,
    nowMs: 2 * P10_HOUR_MS,
    lastPolicyBarTime: 0,
    latestCompletedBar: completed,
    roundTripCostBps: 20,
  });
  assert(long.nextStop >= 101);
  const short = evaluateP10Exit({
    side: "SHORT",
    entryPrice: 100,
    initialRisk: 2,
    currentStop: 104,
    partialDone: false,
    executablePrice: 96,
    entryBarTime: 0,
    openedAtMs: 0,
    nowMs: P10_HOUR_MS,
    lastPolicyBarTime: 0,
    latestCompletedBar: null,
    roundTripCostBps: 18,
  });
  assertEquals(short.action, "TARGET_1");
  assertEquals(short.fraction, P10_CONFIG.partialFraction);
});

// The live regression this replaces: with allocation=200, slots=10 and an ALL-mode wallet,
// the generic ticket path sized a futures slot from capital/slots and produced 50 USDT of
// margin -- a 150 USDT notional at 3x instead of the operator's 600.
Deno.test("P10 futures slot margin is the configured margin, not capital divided by slots", () => {
  const wallet = 520.37;
  assertEquals(
    p10ExecutableTicketCapital({
      available: wallet,
      capital: wallet,
      slots: 10,
      maximum: 200,
      minimum: 50,
      step: 0.01,
    }),
    52.03,
  );
  assertEquals(p10ExactFuturesTicketCapital(wallet, 200), 200);
});

Deno.test("P10 futures target notional is the configured margin times leverage", () => {
  const margin = p10ExactFuturesTicketCapital(5_000, 200);
  assertEquals(margin, 200);
  assertEquals(margin * 1, 200);
  assertEquals(margin * 3, 600);
  assertEquals(margin * 5, 1_000);
});

Deno.test("P10 futures margin holds across wallet sizes and rounds to the 0.01 step", () => {
  assertEquals(p10ExactFuturesTicketCapital(500, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(200, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(334, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(5_000, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(1_000, 133.339), 133.33);
});

Deno.test("P10 futures refuses a downsized ticket when the wallet cannot fund a whole slot", () => {
  // Never shrink 200 into a smaller live order: a zero ticket makes the caller skip the entry.
  assertEquals(p10ExactFuturesTicketCapital(199.99, 200), 0);
  assertEquals(p10ExactFuturesTicketCapital(50, 200), 0);
  assertEquals(p10ExactFuturesTicketCapital(0, 200), 0);
  // 334 funds one 200 ticket; the 134 left behind funds none.
  assertEquals(p10ExactFuturesTicketCapital(334, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(134, 200), 0);
  // An unset operator margin falls back to the generic path instead of forcing a ticket.
  assertEquals(p10ExactFuturesTicketCapital(500, 0), 0);
});

Deno.test("P10 spot venues keep generic capital divided by slots sizing", () => {
  // Binance spot unchanged by the futures-only exact margin.
  assertEquals(
    p10ExecutableTicketCapital({
      available: 500,
      capital: 500,
      slots: 10,
      maximum: 100,
      minimum: 10,
      step: 0.01,
    }),
    50,
  );
  // Upbit KRW unchanged, including its 1000 KRW step.
  assertEquals(
    p10ExecutableTicketCapital({
      available: 500_000,
      capital: 500_000,
      slots: 10,
      maximum: 100_000,
      minimum: 5_000,
      step: 1_000,
    }),
    50_000,
  );
});
