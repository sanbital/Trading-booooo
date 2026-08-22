import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type LeaseGateway, runWithContendedLease, runWithRenewedLease } from "./lease.ts";

/**
 * In-memory stand-in for acquire_trading_lease / release_trading_lease, including the two
 * behaviours the live RPC guarantees: an expired lease can be taken over, and an acquire by
 * the current owner refreshes the expiry instead of failing.
 */
function fakeLeases(clock: { now: number }) {
  const rows = new Map<string, { owner: string; expiresAt: number }>();
  const acquires: string[] = [];
  const gateway: LeaseGateway = {
    acquire(name, owner, ttlSeconds) {
      acquires.push(owner);
      const row = rows.get(name);
      if (row && row.owner !== owner && row.expiresAt > clock.now) return Promise.resolve(false);
      rows.set(name, { owner, expiresAt: clock.now + ttlSeconds * 1000 });
      return Promise.resolve(true);
    },
    release(name, owner) {
      if (rows.get(name)?.owner === owner) rows.delete(name);
      return Promise.resolve(true);
    },
  };
  return { gateway, rows, acquires };
}

const options = { ttlSeconds: 45, renewMs: 10_000, waitMs: 18_000, pollMs: 20 };

Deno.test("a scan releases its lease as soon as the cycle finishes", async () => {
  const clock = { now: 0 };
  const { gateway, rows } = fakeLeases(clock);
  const result = await runWithRenewedLease(gateway, "autotrader-scan", "owner-a", options, () => {
    assertEquals(rows.get("autotrader-scan")?.owner, "owner-a");
    return Promise.resolve({ scanned: 1 });
  });
  assertEquals(result, { scanned: 1 });
  assertEquals(rows.has("autotrader-scan"), false);
});

Deno.test("a cycle that throws still releases the lease", async () => {
  const clock = { now: 0 };
  const { gateway, rows } = fakeLeases(clock);
  let thrown: string | null = null;
  try {
    await runWithRenewedLease(gateway, "autotrader-scan", "owner-a", options, () => {
      throw new Error("gateway unreachable");
    });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  assertEquals(thrown, "gateway unreachable");
  assertEquals(rows.has("autotrader-scan"), false);
});

Deno.test("a busy lease is skipped rather than stolen, and never runs the work twice", async () => {
  const clock = { now: 0 };
  const { gateway, rows } = fakeLeases(clock);
  rows.set("autotrader-scan", { owner: "monitor-in-flight", expiresAt: 600_000 });
  let runs = 0;
  const result = await runWithContendedLease(
    gateway,
    "autotrader-scan",
    () => `scan-${runs}`,
    { ...options, waitMs: 60, pollMs: 20 },
    () => {
      runs++;
      return Promise.resolve({ scanned: 1 });
    },
    // Each read advances the fake clock, so the wait window closes as it would in wall time.
    () => (clock.now += 20),
  );
  assertEquals(result, null);
  assertEquals(runs, 0);
  // The holder keeps its lease; a losing attempt must never overwrite the owner.
  assertEquals(rows.get("autotrader-scan")?.owner, "monitor-in-flight");
});

Deno.test("a scan waits out the holder's cycle instead of skipping", async () => {
  const clock = { now: 0 };
  const { gateway, rows } = fakeLeases(clock);
  rows.set("autotrader-scan", { owner: "monitor-in-flight", expiresAt: 90_000 });
  let attempts = 0;
  const result = await runWithContendedLease(
    gateway,
    "autotrader-scan",
    () => `scan-${attempts}`,
    { ...options, waitMs: 18_000, pollMs: 5 },
    () => Promise.resolve({ scanned: 7 }),
    () => {
      // The holder releases partway through the wait window, well inside 18s of polling.
      if (++attempts === 3) rows.delete("autotrader-scan");
      return (clock.now += 2_000);
    },
  );
  assertEquals(result, { scanned: 7 });
  assert(attempts >= 3, "the scan must have retried rather than skipped");
});

Deno.test("an owner that died frees the lease once its TTL expires", async () => {
  const clock = { now: 0 };
  const { gateway, rows } = fakeLeases(clock);
  // A previous invocation acquired and never released.
  rows.set("autotrader-scan", { owner: "dead-owner", expiresAt: 45_000 });
  assertEquals(await gateway.acquire("autotrader-scan", "next-owner", 45), false);
  clock.now = 45_001;
  assertEquals(await gateway.acquire("autotrader-scan", "next-owner", 45), true);
  assertEquals(rows.get("autotrader-scan")?.owner, "next-owner");
});

Deno.test("the renewal heartbeat refreshes the same owner's expiry while work runs", async () => {
  const clock = { now: 0 };
  const { gateway, rows, acquires } = fakeLeases(clock);
  const result = await runWithRenewedLease(
    gateway,
    "autotrader-scan",
    "owner-a",
    { ...options, renewMs: 5 },
    async () => {
      const before = rows.get("autotrader-scan")!.expiresAt;
      clock.now = 20_000;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const after = rows.get("autotrader-scan")!.expiresAt;
      assert(after > before, "renewal must push the expiry forward");
      assertEquals(rows.get("autotrader-scan")?.owner, "owner-a");
      return { scanned: 1 };
    },
  );
  assertEquals(result, { scanned: 1 });
  assert(acquires.length > 1, "expected at least one renewal");
  // Renewal must stop with the work; nothing may keep the lease alive after release.
  assertEquals(rows.has("autotrader-scan"), false);
  const settled = acquires.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(acquires.length, settled);
});

// The monitor holds `autotrader-engine` through the same RPC the scan uses. It used to take
// a flat 90s TTL and never renew it, which meant a monitor the runtime killed mid-cycle
// blocked stop monitoring for a further 90 seconds — the 98s cadence gap seen in production.
// A short renewed TTL has to keep both guarantees at once: a live monitor is never
// overlapped, and a dead one frees the lease within one TTL.
const monitorOptions = { ttlSeconds: 30, renewMs: 5_000 };

Deno.test("a second monitor cannot run while the first still holds the lease", async () => {
  const clock = { now: 0 };
  const { gateway, rows } = fakeLeases(clock);
  let concurrent = 0;
  let peak = 0;
  let overlapped = 0;
  const run = (owner: string) =>
    runWithRenewedLease(gateway, "autotrader-monitor", owner, monitorOptions, async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      if (concurrent > 1) overlapped++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent--;
      return { exits: 1 };
    });
  const [first, second] = await Promise.all([run("monitor-a"), run("monitor-b")]);
  // Exactly one cycle ran; the other skipped rather than issuing a duplicate exit.
  assertEquals([first, second].filter((result) => result !== null).length, 1);
  assertEquals(peak, 1);
  assertEquals(overlapped, 0);
  assertEquals(rows.has("autotrader-monitor"), false);
});

Deno.test("a monitor cycle longer than its TTL still excludes the next one", async () => {
  const clock = { now: 0 };
  const { gateway } = fakeLeases(clock);
  let intruderRan = false;
  const result = await runWithRenewedLease(
    gateway,
    "autotrader-monitor",
    "monitor-a",
    { ...monitorOptions, renewMs: 5 },
    async () => {
      // Well past the 30s TTL: only the renewal heartbeat can be keeping the lease alive.
      clock.now = 45_000;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const intruder = await runWithRenewedLease(
        gateway,
        "autotrader-monitor",
        "monitor-b",
        monitorOptions,
        () => {
          intruderRan = true;
          return Promise.resolve({ exits: 1 });
        },
      );
      assertEquals(intruder, null);
      return { exits: 1 };
    },
  );
  assertEquals(result, { exits: 1 });
  assertEquals(intruderRan, false);
});

Deno.test("a monitor that died frees the engine lease in one short TTL, not ninety seconds", async () => {
  const clock = { now: 0 };
  const { gateway, rows } = fakeLeases(clock);
  rows.set("autotrader-monitor", { owner: "killed-mid-cycle", expiresAt: 30_000 });
  assertEquals(await gateway.acquire("autotrader-monitor", "monitor-next", 30), false);
  // The old 90s TTL would still have been holding here.
  clock.now = 30_001;
  assertEquals(await gateway.acquire("autotrader-monitor", "monitor-next", 30), true);
});
