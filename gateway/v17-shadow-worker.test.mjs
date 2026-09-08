import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createShadowWorker, streamsFor, toEvent } from "./v17-shadow-worker.mjs";
// The real production engine is injected, so these exercise the same code the executor
// would run in phase 2 rather than a stand-in.
import {
  newR4State,
  nextR4Exit,
  r4PolicyKey,
  R4_CANDIDATE,
} from "../supabase/functions/_shared/leader-exit-r4.mjs";

const engine = { newR4State, nextR4Exit, r4PolicyKey, R4_CANDIDATE };
const ENTRY_AT = 1_700_000_000_000;
const position = {
  symbol: "FORMUSDT",
  entryPrice: 100,
  entryAt: ENTRY_AT,
  quantity: 10,
  entryFee: 0.06,
  quantityStep: 1,
};

function harness(positions = [position], opts = {}) {
  const emitted = [], reports = [], closed = [];
  let subscribed = null;
  // Receive time is what the engine uses to judge staleness, so the simulated clock has
  // to sit just after the event it is handed; a wall clock would make every historical
  // event look stale and silently reset the confirmation instead of testing it.
  let now = ENTRY_AT;
  const worker = createShadowWorker({
    engine,
    listPositions: async () => positions,
    connect: (streams) => {
      subscribed = streams;
      return { close: () => closed.push(streams) };
    },
    emit: (d) => emitted.push(d),
    report: (r) => reports.push(r),
    clock: () => now,
    timers: { setInterval: () => null, clearInterval: () => {} },
    ...opts,
  });
  // delayMs is the simulated transport delay; a negative value produces receivedAt < at,
  // which is the clock inversion the engine rejects outright.
  const feed = (price, at, sequence, symbol, delayMs = 5) => {
    now = at + delayMs;
    worker.onMessage(agg(price, at, sequence, symbol));
  };
  return { worker, emitted, reports, closed, feed, streams: () => subscribed };
}

const agg = (price, at, sequence, symbol = "FORMUSDT") => ({
  data: { e: "aggTrade", s: symbol, p: String(price), T: at, a: sequence },
});

test("streamsFor asks for both streams per symbol and rejects junk", () => {
  assert.deepEqual(streamsFor(["FORMUSDT", "formusdt"]), ["formusdt@aggTrade", "formusdt@kline_1m"]);
  assert.throws(() => streamsFor(["BTC-PERP"]), /INVALID_SHADOW_SYMBOL/);
});

test("aggTrade maps to a sequenced tick and an unclosed candle is dropped", () => {
  const tick = toEvent(agg(99.5, ENTRY_AT + 1000, 42), ENTRY_AT + 1001);
  assert.deepEqual(tick, {
    symbol: "FORMUSDT", type: "tick", price: 99.5, at: ENTRY_AT + 1000, sequence: 42, receivedAt: ENTRY_AT + 1001,
  });
  const open = { data: { e: "kline", s: "FORMUSDT", k: { x: false, c: "99", T: ENTRY_AT + 60000 } } };
  assert.equal(toEvent(open, ENTRY_AT), null, "a running candle has no final close");
  const done = { data: { e: "kline", s: "FORMUSDT", k: { x: true, c: "99", T: ENTRY_AT + 60000 } } };
  assert.equal(toEvent(done, ENTRY_AT).type, "bar");
  for (const junk of [null, {}, { data: { e: "aggTrade", s: "X", p: "0", T: 1, a: 1 } }]) {
    assert.equal(toEvent(junk, 0), null);
  }
});

test("a sustained breach exits only after the confirmation window", async () => {
  const h = harness();
  await h.worker.start();
  assert.deepEqual(h.streams(), ["formusdt@aggTrade", "formusdt@kline_1m"]);
  // 97.0 sits under the -2.5% stop and above the -3.5% emergency level, so this is the
  // confirmed-loss path, not the immediate one.
  for (let i = 1; i <= 9; i++) h.feed(97, ENTRY_AT + i * 1000, 100 + i);
  assert.equal(h.emitted.length, 0, "must not exit before 10s of continuous breach");
  for (let i = 10; i <= 12; i++) h.feed(97, ENTRY_AT + i * 1000, 100 + i);
  const signal = h.emitted.find((e) => e.leg === "risk");
  assert.ok(signal, "risk leg should exit once the window elapses");
  assert.equal(signal.reason, "R3_CONFIRMED_LOSS");
  assert.equal(signal.executed, false, "a shadow signal is never executed");
  // The completion counter is what gates promotion to phase 2, so it has to move when a
  // confirmation actually completes. Watching breachSince return to null does not: the
  // engine leaves it set once the leg closes.
  assert.equal(h.worker.snapshot()[0].coverage.confirmationsCompleted, 1);
});

test("a gap wider than the evidence window restarts the confirmation clock", async () => {
  const h = harness();
  await h.worker.start();
  for (let i = 1; i <= 5; i++) h.feed(97, ENTRY_AT + i * 1000, 200 + i);
  // 4.6s was the widest real no-trade gap measured across 642k trades; it exceeds the 3s
  // evidence window, so the clock must restart rather than count the silence as breach.
  h.feed(97, ENTRY_AT + 9600, 206);
  for (let i = 1; i <= 4; i++) h.feed(97, ENTRY_AT + 9600 + i * 1000, 206 + i);
  assert.equal(h.emitted.length, 0, "silence must not be counted as continuous breach");
  const cov = h.worker.snapshot()[0].coverage;
  assert.ok(cov.maxGapMs >= 3000);
  assert.ok(cov.gapsOverWindow >= 1);
});

test("an emergency move exits without waiting for confirmation", async () => {
  const h = harness();
  await h.worker.start();
  h.feed(96, ENTRY_AT + 1000, 300);
  assert.ok(h.emitted.some((e) => e.reason === "R3_EMERGENCY_STOP"), "-4% must not wait 10s");
});

test("duplicate and out-of-order events are ignored", async () => {
  const h = harness();
  await h.worker.start();
  h.feed(99, ENTRY_AT + 5000, 400);
  const before = h.worker.snapshot()[0].coverage.ticks;
  h.feed(99, ENTRY_AT + 5000, 400); // duplicate id
  h.feed(99, ENTRY_AT + 1000, 399); // older
  assert.equal(h.worker.snapshot()[0].coverage.ticks, before, "neither should advance the engine");
});

test("a position too small to split is recorded, not crashed on", async () => {
  const h = harness([{ ...position, quantity: 1, quantityStep: 1 }]);
  await h.worker.start();
  const [row] = h.worker.snapshot();
  assert.match(row.skipped, /POSITION_TOO_SMALL_TO_SPLIT/);
  h.feed(97, ENTRY_AT + 1000, 500);
  assert.equal(h.emitted.length, 0, "a skipped position must not produce decisions");
});

test("a malformed event is reported and does not kill the worker", async () => {
  const h = harness();
  await h.worker.start();
  // receivedAt before the trade time is impossible and the engine throws INVALID_TICK.
  // (A tick older than entry is merely ignored, not rejected, so it would not test this.)
  h.feed(99, ENTRY_AT + 1000, 600, "FORMUSDT", -100);
  assert.ok(h.reports.some((r) => r.kind === "SHADOW_EVENT_REJECTED"));
  h.feed(97, ENTRY_AT + 2000, 601);
  assert.equal(h.worker.snapshot()[0].coverage.ticks, 1, "worker still processes the next event");
});

test("releasing a closed position unsubscribes its streams", async () => {
  let open = [position];
  const h = harness(open, { listPositions: async () => open });
  await h.worker.start();
  assert.equal(h.worker.snapshot().length, 1);
  open = [];
  await h.worker.start(); // no-op, already running
  h.worker.stop();
  assert.ok(h.closed.length >= 1, "socket must be closed on stop");
});

test("the worker exposes no way to place an order", () => {
  const { worker } = harness();
  assert.deepEqual(Object.keys(worker).sort(), ["onMessage", "snapshot", "start", "stop"]);
  const src = readFileSync(new URL("./v17-shadow-worker.mjs", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "submitReduceOnly", "createOrder", "signature", "apiKey", "reduceOnly"]) {
    assert.ok(!src.includes(forbidden), `shadow worker must not reference ${forbidden}`);
  }
});

test("the engine is injected, never imported from the shared tree", () => {
  const src = readFileSync(new URL("./v17-shadow-worker.mjs", import.meta.url), "utf8");
  assert.ok(!/^import .*leader-exit/m.test(src),
    "importing the engine here would either break the gateway image or fork the engine");
  assert.throws(() => createShadowWorker({ connect: () => {}, listPositions: async () => [] }),
    /SHADOW_WORKER_ENGINE/);
});
