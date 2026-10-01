function text(value) {
  return String(value?.message ?? value ?? '').slice(0, 440);
}

/**
 * Derive current-cycle runtime telemetry without weakening the success gate.
 * A historical fatal error must never survive a later cycle as if it happened now.
 */
export function runtimeCycleOutcome({fatal = null, entryEvaluationCompleted = false,
  health = 'NOT_EVALUATED', managed = [], reconciliation = []} = {}) {
  const successful = !fatal && entryEvaluationCompleted &&
    ['FLAT', 'PROTECTED', 'SOFTWARE_ONLY'].includes(health) &&
    managed.every(item => !item?.error && !item?.skipped) &&
    reconciliation.every(item => !item?.error);
  if (successful) return Object.freeze({successful: true, lastError: null});
  if (fatal) return Object.freeze({successful: false, lastError: text(fatal).slice(0, 500)});

  const management = managed.find(item => item?.error || item?.skipped);
  const unsettled = reconciliation.find(item => item?.error || item?.outcome === 'UNRESOLVED' || item?.accountingComplete === false);
  const current = management
    ? `MANAGEMENT:${text(management.error ?? management.skipped)}`
    : unsettled
      ? `RECONCILIATION:${text(unsettled.error ?? unsettled.reason ?? unsettled.outcome)}`
      : !entryEvaluationCompleted
        ? null
        : !['FLAT', 'PROTECTED', 'SOFTWARE_ONLY'].includes(health)
          ? `PROTECTION_HEALTH:${text(health)}`
          : null;
  return Object.freeze({successful: false, lastError: current ? `CYCLE_DEGRADED:${current}`.slice(0, 500) : null});
}

