import { assert } from "jsr:@std/assert@1";
const engine = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
const migration = Deno.readTextFileSync(
  new URL(
    "../../migrations/20260816003100_empirical_timeout_close_reason_v769.sql",
    import.meta.url,
  ),
);
Deno.test("pinned 600s timeout can liquidate all remaining quantity", () => {
  assert(engine.includes("position.metadata?.absolute_max_holding_seconds"));
  assert(engine.includes('decisionReason === "HALF_HOLD_ABSOLUTE_TIMEOUT"'));
  assert(engine.includes('decision.reason === "HALF_HOLD_ABSOLUTE_TIMEOUT"'));
  assert(migration.includes("ABSOLUTE_TIMEOUT_TOO_EARLY"));
});
Deno.test("semantic exit labels are explicit", () => {
  for (
    const x of ["HARD_STOP", "PROFIT_PROTECTION", "TRAILING_PROFIT", "RECOVERY_PROFIT", "TIMEOUT"]
  ) assert(migration.includes(`then '${x}'`));
  assert(!migration.includes("EV_INFORMATIONAL_ONLY"));
});
