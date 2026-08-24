import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  latestCompletedPolicyBarTime,
  shouldLoadCompletedPolicyBar,
} from "./p10-monitor-cadence.ts";

const HOUR = 3_600_000;

Deno.test("completed policy bar advances only across an hourly boundary", () => {
  const now = Date.UTC(2026, 7, 24, 4, 37, 12);
  assertEquals(latestCompletedPolicyBarTime(now, HOUR), Date.UTC(2026, 7, 24, 3));
  assertEquals(
    latestCompletedPolicyBarTime(Date.UTC(2026, 7, 24, 5, 0, 0), HOUR),
    Date.UTC(2026, 7, 24, 4),
  );
});

Deno.test("hourly history is skipped until a newer completed bar exists", () => {
  const now = Date.UTC(2026, 7, 24, 4, 37, 12);
  const latest = Date.UTC(2026, 7, 24, 3);
  assertEquals(shouldLoadCompletedPolicyBar(latest, now, HOUR), false);
  assertEquals(shouldLoadCompletedPolicyBar(latest - HOUR, now, HOUR), true);
});
