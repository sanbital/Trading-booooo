// Trading-booooo v5.12 — reconciliation failure state machine.

export type ReconciliationPhase = "ENTRY" | "EXIT" | "ACCOUNT";
export type ReconciliationState =
  | "RECONCILING"
  | "RECONCILIATION_FAILED"
  | "MANUAL_INTERVENTION_REQUIRED";

export interface ReconciliationFailureInput {
  previousFailures: number;
  phase: ReconciliationPhase;
  nowMs?: number;
  maxAutomaticRetries?: number;
  baseBackoffMs?: number;
}

export interface ReconciliationFailureDecision {
  state: ReconciliationState;
  failureCount: number;
  retryAtMs: number | null;
  pauseNewEntries: boolean;
  manualInterventionRequired: boolean;
}

export function nextReconciliationFailure(
  input: ReconciliationFailureInput,
): ReconciliationFailureDecision {
  const failureCount = Math.max(0, Math.floor(input.previousFailures)) + 1;
  const maxRetries = Math.max(1, Math.floor(input.maxAutomaticRetries ?? 3));
  const now = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const base = Math.max(1000, Number(input.baseBackoffMs ?? 5000));

  // A reconciliation transport/order failure is not evidence of human trading.
  // After automatic retries are exhausted, keep the position in a technical failure
  // state and fail closed for new entries. Explicit account-delta/manual-detection
  // paths are solely responsible for MANUAL_INTERVENTION_REQUIRED.
  if (failureCount >= maxRetries) {
    return {
      state: "RECONCILIATION_FAILED",
      failureCount,
      retryAtMs: now + base * 2 ** Math.min(failureCount - 1, 6),
      pauseNewEntries: true,
      manualInterventionRequired: false,
    };
  }
  return {
    state: "RECONCILIATION_FAILED",
    failureCount,
    retryAtMs: now + base * 2 ** (failureCount - 1),
    pauseNewEntries: false,
    manualInterventionRequired: false,
  };
}

export function reconciliationRetryDue(retryAt: string | number | null | undefined, nowMs = Date.now()): boolean {
  if (retryAt == null) return true;
  const value = typeof retryAt === "number" ? retryAt : Date.parse(retryAt);
  return !Number.isFinite(value) || value <= nowMs;
}
