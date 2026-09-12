import { assessCandidateIntegrity } from "./entry-integrity.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

const VERSION = "7.2.3-EXECUTABLE-NET-INTEGRITY";

Deno.test("failed_gate_count greater than zero is an unconditional block", () => {
  const decision = assessCandidateIntegrity({
    failed_gate_count: 1,
    snapshot: { engine_version: VERSION, failed_gates: [] },
  }, VERSION);
  assert(!decision.allowed);
  assert(decision.reason?.startsWith("failed_gate_count=1"));
});

Deno.test("persisted failed gate names cannot bypass a stale zero count", () => {
  const decision = assessCandidateIntegrity({
    failed_gate_count: 0,
    snapshot: { engine_version: VERSION, failed_gates: ["reward_risk"] },
  }, VERSION);
  assert(!decision.allowed);
  assert(decision.failedGateCount === 1);
});

Deno.test("candidate and runtime engine versions must match exactly", () => {
  const missing = assessCandidateIntegrity({ failed_gate_count: 0, snapshot: {} }, VERSION);
  const stale = assessCandidateIntegrity({
    failed_gate_count: 0,
    snapshot: { engine_version: "7.2.2-LOB-ENTRY-RISK-GATES" },
  }, VERSION);
  const current = assessCandidateIntegrity({
    failed_gate_count: 0,
    snapshot: { engine_version: VERSION },
  }, VERSION);
  assert(!missing.allowed);
  assert(!stale.allowed);
  assert(current.allowed);
});
