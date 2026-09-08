import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createShadowHost, normalizePositions } from "./v17-shadow-host.mjs";
import { createShadowWorker } from "./v17-shadow-worker.mjs";
import { newR4State, nextR4Exit, r4PolicyKey, R4_CANDIDATE }
  from "../supabase/functions/_shared/leader-exit-r4.mjs";
import { STAGED_ENGINE_FILES } from "./stage-engine.mjs";

const engine = { newR4State, nextR4Exit, r4PolicyKey, R4_CANDIDATE };
const ENTRY_AT = 1_700_000_000_000;
const pos = {
  positionId: "p1", symbol: "FORMUSDT", entryPrice: 100, entryAt: ENTRY_AT,
  quantity: 10, entryFee: 0.06, quantityStep: 1,
};

function fakeSocketClass(created) {
  return class FakeSocket {
    constructor(url) {
      this.url = url;
      this.closed = false;
      created.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
    deliver(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }
  };
}

function host(extra = {}) {
  const created = [], logs = [], reports = [];
  const timeouts = [];
  const h = createShadowHost({
    createShadowWorker,
    engine,
    WebSocketImpl: fakeSocketClass(created),
    log: (l) => logs.push(JSON.parse(l)),
    report: (r) => reports.push(r),
    timers: {
      setInterval: () => null,
      clearInterval: () => {},
      setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; },
    },
    ...extra,
  });
  return { h, created, logs, reports, timeouts };
}

test("pushed positions are validated before the engine sees them", () => {
  assert.equal(normalizePositions([pos]).length, 1);
  assert.throws(() => normalizePositions("nope"), /NOT_ARRAY/);
  assert.throws(() => normalizePositions([{ ...pos, symbol: "BTC-PERP" }]), /BAD_SYMBOL/);
  assert.throws(() => normalizePositions([{ ...pos, entryFee: "x" }]), /BAD_FIELD:FORMUSDT:entryFee/);
  assert.throws(() => normalizePositions(Array(21).fill(pos)), /TOO_MANY/);
});

test("accepting positions subscribes to that symbol's streams", async () => {
  const { h, created } = host();
  const res = await h.setPositions([pos]);
  assert.equal(res.accepted, 1);
  assert.equal(created.length, 1);
  assert.match(created[0].url, /^wss:\/\/fstream\.binance\.com\/stream\?streams=/);
  assert.match(created[0].url, /formusdt@aggTrade/);
  assert.match(created[0].url, /formusdt@kline_1m/);
});

test("stream frames drive the engine and a confirmed breach is logged, not executed", async () => {
  // Receive time decides staleness, so the simulated clock has to sit just after each
  // event; a wall clock would make every frame look stale and reset the confirmation.
  let now = ENTRY_AT;
  const { h, created, logs } = host({ clock: () => now });
  await h.setPositions([pos]);
  const socket = created[0];
  for (let i = 1; i <= 12; i++) {
    now = ENTRY_AT + i * 1000 + 5;
    socket.deliver({ data: { e: "aggTrade", s: "FORMUSDT", p: "97", T: ENTRY_AT + i * 1000, a: 500 + i } });
  }
  const signal = logs.map((l) => l.v17ShadowSignal).find(Boolean);
  assert.ok(signal, "a sustained breach should produce a shadow signal");
  assert.equal(signal.reason, "R3_CONFIRMED_LOSS");
  assert.equal(signal.executed, false);
});

test("an unparseable frame is dropped rather than guessed at", async () => {
  const { h, created, logs } = host();
  await h.setPositions([pos]);
  created[0].onmessage({ data: "<html>rate limited</html>" });
  assert.equal(logs.length, 0);
});

test("an unexpected close schedules a reconnect with backoff", async () => {
  const { h, created, reports, timeouts } = host();
  await h.setPositions([pos]);
  created[0].onclose();
  assert.ok(reports.some((r) => r.kind === "SHADOW_WS_CLOSED"));
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 1000);
  timeouts[0].fn(); // reconnect
  assert.equal(created.length, 2, "a new socket should be opened");
  created[1].onclose();
  assert.equal(timeouts[1].ms, 2000, "backoff should widen");
});

test("stopping does not schedule further reconnects", async () => {
  const { h, created, timeouts } = host();
  await h.setPositions([pos]);
  h.stop();
  assert.ok(created[0].closed);
  assert.equal(timeouts.length, 0, "a deliberate close must not reconnect");
});

test("the host adds no order capability of its own", () => {
  const { h } = host();
  assert.deepEqual(Object.keys(h).sort(), ["setPositions", "status", "stop", "summary"]);
  const src = readFileSync(new URL("./v17-shadow-host.mjs", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "reduceOnly", "apiKey", "signature", "/fapi/"]) {
    assert.ok(!src.includes(forbidden), `shadow host must not reference ${forbidden}`);
  }
});

test("the staged engine list covers leader-exit-r4 and its own import", () => {
  assert.deepEqual(STAGED_ENGINE_FILES, ["leader-exit-r3.mjs", "leader-exit-r4.mjs"]);
  const r4 = readFileSync(
    new URL("../supabase/functions/_shared/leader-exit-r4.mjs", import.meta.url),
    "utf8",
  );
  // If r4 ever imports another shared module, staging only these two would leave the
  // gateway image with an unresolvable import — the exact failure that took the
  // gateway down once already.
  const imports = [...r4.matchAll(/from\s+'\.\/([^']+)'/g)].map((m) => m[1]);
  for (const dep of imports) {
    assert.ok(STAGED_ENGINE_FILES.includes(dep), `leader-exit-r4 imports ${dep}, which is not staged`);
  }
});

test("the health summary reports coverage without leaking positions", async () => {
  let now = ENTRY_AT;
  const { h, created } = host({ clock: () => now });
  await h.setPositions([pos]);
  for (let i = 1; i <= 12; i++) {
    now = ENTRY_AT + i * 1000 + 5;
    created[0].deliver({ data: { e: "aggTrade", s: "FORMUSDT", p: "97", T: ENTRY_AT + i * 1000, a: 900 + i } });
  }
  const s = h.summary();
  assert.equal(s.enabled, true);
  assert.equal(s.positions, 1);
  assert.equal(s.tracked, 1);
  assert.equal(s.ticks, 12);
  assert.equal(s.confirmations_completed, 1);
  // /health is unauthenticated, so the summary must not carry holdings.
  const flat = JSON.stringify(s);
  assert.ok(!flat.includes("FORMUSDT"), "summary must not name symbols");
  assert.ok(!flat.includes("97"), "summary must not carry prices");
});
