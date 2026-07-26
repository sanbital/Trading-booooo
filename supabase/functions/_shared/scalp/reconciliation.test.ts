import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextReconciliationFailure, reconciliationRetryDue } from "./reconciliation.ts";

Deno.test("reconciliation failures back off before manual escalation", () => {
  const first = nextReconciliationFailure({ previousFailures: 0, phase: "ENTRY", nowMs: 1000 });
  assertEquals(first.state, "RECONCILIATION_FAILED");
  assertEquals(first.pauseNewEntries, false);
  assert(first.retryAtMs! > 1000);
  const third = nextReconciliationFailure({ previousFailures: 2, phase: "EXIT", nowMs: 1000 });
  assertEquals(third.state, "MANUAL_INTERVENTION_REQUIRED");
  assertEquals(third.pauseNewEntries, true);
});

Deno.test("retry due handles ISO timestamps", () => {
  assertEquals(reconciliationRetryDue(new Date(1000).toISOString(), 2000), true);
  assertEquals(reconciliationRetryDue(new Date(3000).toISOString(), 2000), false);
});
