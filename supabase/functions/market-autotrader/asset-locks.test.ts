import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextAssetLockState } from "./asset-locks.ts";
Deno.test("network failure pauses rather than resets clean lock evidence", () => {
  assertEquals(nextAssetLockState({ state: "LOCKED", cleanChecks: 2 }, "QUERY_FAILED", 3), {
    state: "LOCKED", cleanChecks: 2,
  });
});
Deno.test("real mismatch resets clean checks", () => {
  assertEquals(nextAssetLockState({ state: "LOCKED", cleanChecks: 2 }, "MISMATCH", 3), {
    state: "LOCKED", cleanChecks: 0,
  });
});
Deno.test("three clean checks release a lock", () => {
  assertEquals(nextAssetLockState({ state: "LOCKED", cleanChecks: 2 }, "CLEAN", 3).state, "RELEASED");
});
