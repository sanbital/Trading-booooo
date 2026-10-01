const CANDIDATE_AUTHORITY_VETO = new Set([
  'DEFER_UNIVERSE_STALE_OR_GENERATION',
  'POST_SETTLEMENT_APPROVAL_REQUIRED',
  'CLOCK_ENTRY_WINDOW_EXPIRED_OR_CHANGED',
]);

/**
 * Classify the second authority check performed after a signal claim.
 *
 * A veto is candidate scoped only before an exchange side effect. Once dispatch has
 * started, the same text can no longer prove that the account is side effect free and
 * reconciliation must retain account scoped ownership of the failure.
 */
export function classifyEntryAuthorityError(error, {orderDispatched = false} = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const candidateVeto = orderDispatched !== true && CANDIDATE_AUTHORITY_VETO.has(message);
  return Object.freeze({
    message,
    candidateVeto,
    technical: !candidateVeto,
    scope: candidateVeto ? 'CANDIDATE' : 'ACCOUNT',
    sideEffectStarted: orderDispatched === true,
  });
}
