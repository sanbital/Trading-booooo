export type CandidateIntegrityDecision = {
  allowed: boolean;
  reason: string | null;
  failedGateCount: number;
  failedGates: string[];
  candidateEngineVersion: string;
  runtimeEngineVersion: string;
};

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function assessCandidateIntegrity(
  candidate: Record<string, any>,
  runtimeEngineVersion: string,
): CandidateIntegrityDecision {
  const failedGates = Array.isArray(candidate?.snapshot?.failed_gates)
    ? candidate.snapshot.failed_gates.map(String)
    : [];
  const failedGateCount = Math.max(
    0,
    Math.floor(finite(candidate?.failed_gate_count)),
    failedGates.length,
  );
  const candidateEngineVersion = String(candidate?.snapshot?.engine_version || "");
  let reason: string | null = null;
  if (failedGateCount > 0) {
    reason = `failed_gate_count=${failedGateCount}: ${
      failedGates.join(",") || "persisted scanner gate failure"
    }`;
  } else if (candidateEngineVersion !== runtimeEngineVersion) {
    reason = `engine version mismatch: candidate=${
      candidateEngineVersion || "MISSING"
    }, runtime=${runtimeEngineVersion}`;
  }
  return {
    allowed: reason === null,
    reason,
    failedGateCount,
    failedGates,
    candidateEngineVersion,
    runtimeEngineVersion,
  };
}
