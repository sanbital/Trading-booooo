import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveProfileHolding } from "./profile.ts";

Deno.test("HF_SCALP cannot exceed thirty minutes", () => {
  const r = resolveProfileHolding("HF_SCALP", 120, 360, 80);
  assertEquals(r.profileCeilingMinutes, 30);
  assertEquals(r.geometryHorizonCeilingMinutes, 30);
  assertEquals(r.expectedResolutionMinutes, 30);
  assertEquals(r.timeoutMinutes, 30);
});

Deno.test("INTRADAY_SCALP is isolated with a 120-minute ceiling", () => {
  const r = resolveProfileHolding("INTRADAY_SCALP", 90, 100, 60);
  assertEquals(r.profileCeilingMinutes, 120);
  assertEquals(r.geometryHorizonCeilingMinutes, 90);
  assertEquals(r.expectedResolutionMinutes, 60);
  assertEquals(r.timeoutMinutes, 100);
});
