import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  earliestExecutedAt,
  latestExecutedAt,
  resolveLifecycleTimes,
} from "./time-integrity.ts";

Deno.test("fill time uses earliest entry and latest exit", () => {
  const entryFills = [
    { executed_at: "2026-07-28T03:00:02.000Z", volume: 1 },
    { executed_at: "2026-07-28T03:00:01.000Z", funds_quote: 100 },
  ];
  const exitFills = [
    { executed_at: "2026-07-28T03:02:00.000Z", volume: 0.4 },
    { executed_at: "2026-07-28T03:03:01.000Z", volume: 0.6 },
  ];
  assertEquals(earliestExecutedAt(entryFills), "2026-07-28T03:00:01.000Z");
  assertEquals(latestExecutedAt(exitFills), "2026-07-28T03:03:01.000Z");
  const result = resolveLifecycleTimes({ state: "CLOSED", entryFills, exitFills });
  assertEquals(result.quality, "FILL_VERIFIED");
  assertEquals(result.durationSeconds, 180);
});

Deno.test("rejected zero-fill position is not a verified trade", () => {
  const result = resolveLifecycleTimes({
    state: "CLOSED",
    entryFills: [],
    exitFills: [],
  });
  assertEquals(result.quality, "ENTRY_FILL_MISSING");
  assertStrictEquals(result.durationSeconds, null);
});

Deno.test("closed position without sell fill is excluded", () => {
  const result = resolveLifecycleTimes({
    state: "CLOSED",
    entryFills: [{ executed_at: "2026-07-28T03:00:00Z", volume: 1 }],
    exitFills: [],
  });
  assertEquals(result.quality, "EXIT_FILL_MISSING");
  assertStrictEquals(result.durationSeconds, null);
});

Deno.test("time reversal is never converted to zero seconds", () => {
  const result = resolveLifecycleTimes({
    state: "CLOSED",
    entryFills: [{ executed_at: "2026-07-28T03:05:00Z", volume: 1 }],
    exitFills: [{ executed_at: "2026-07-28T03:00:00Z", volume: 1 }],
  });
  assertEquals(result.quality, "TIME_REVERSED");
  assertStrictEquals(result.durationSeconds, null);
});

Deno.test("open duration uses verified entry fill", () => {
  const result = resolveLifecycleTimes({
    state: "OPEN",
    entryFills: [{ executed_at: "2026-07-28T03:00:00Z", volume: 1 }],
    exitFills: [],
    nowMs: new Date("2026-07-28T03:02:30Z").getTime(),
  });
  assertEquals(result.quality, "FILL_VERIFIED");
  assertEquals(result.durationSeconds, 150);
});
