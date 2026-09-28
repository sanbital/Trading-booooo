import {LEADER20} from './universe.mjs';
import {entryCaptureSafety, dynamicDelta} from '../gpt-final-decision/dynamic-flow.mjs';
import {CLOCK_VERSION, SLOT_MS, EXECUTION_MS} from './clock.mjs';
export const CAMPAIGN_POLICY = Object.freeze({version: LEADER20, fairReviewMs: 21600000, minReviewMs: 1800000, eventTtlMs: 120000});
export const isLeader20 = row => row?.features?.leader20?.version === LEADER20;
/** The hard end of entry permission for a fixed clock slot, DERIVED from the slot itself.
 *
 * A clock entry's whole authority is [slot_ms, slot_ms + EXECUTION_MS). That bound must not be
 * readable from anything a TTL, a config row or a stored feature can grow: otherwise raising
 * CAMPAIGN_POLICY.eventTtlMs, or writing a larger features.leader20.expires_at_ms, silently
 * extends the window and CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION simply stops firing -- an expired
 * authority would then execute on a stale 24-bucket path instead of being refused.
 * A malformed clock window yields null, which every caller treats as already expired (fail closed).
 */
export function clockAuthorityDeadline(window) {
  if (window?.version !== CLOCK_VERSION) return null;
  const slot = window.slot_ms;
  if (!Number.isSafeInteger(slot) || slot % SLOT_MS !== 0) return null;
  return slot + EXECUTION_MS;
}
/** Expiry of one entry event. For a clock entry the stored value can only ever be TIGHTENED by
 * the derived slot deadline, never loosened past it. */
export const eventExpiry = row => {
  const e = row?.features?.leader20, stored = e?.expires_at_ms;
  if (!e?.entry_window) return stored;
  const hard = clockAuthorityDeadline(e.entry_window);
  if (hard === null) return null;
  return Number.isSafeInteger(stored) ? Math.min(stored, hard) : hard;
};
export function validEvent(row) {
  const e = row?.features?.leader20;
  return isLeader20(row) && !!row.id && row.symbol === e.symbol &&
    typeof e.epoch_id === 'string' && typeof e.event_id === 'string' &&
    Number.isSafeInteger(e.generation) && e.generation > 0 &&
    Number.isSafeInteger(e.requested_at_ms) && Number.isSafeInteger(e.expires_at_ms) &&
    e.expires_at_ms > e.requested_at_ms && e.expires_at_ms - e.requested_at_ms <= CAMPAIGN_POLICY.eventTtlMs &&
    !['REJECTED', 'ORDERED', 'FILLED', 'CLOSED'].includes(row.status);
}
export function leaderIdentity(row) {
  const f = row.features, e = f.leader20;
  return {signal_id: String(row.id), symbol: row.symbol, trigger_at_ms: e.requested_at_ms,
    reference_close: f.referenceClose, day_return: null, rank: f.rank,
    judgments: {legacy_models: 'OPTIONAL_ADVISORY_ONLY'}, exit_policy: structuredClone(f.exitPolicy),
    leader20: structuredClone(e)};
}
export function reviewRequest(watch, capture, {at, member, hasExposure = false, settledAt = null, policy = CAMPAIGN_POLICY}) {
  if (!member && !hasExposure) return {state: 'RETIRED', request: false, reason: 'UNIVERSE_EXPIRED'};
  const safety = entryCaptureSafety(capture, at);
  if (!safety.ok) return {state: watch?.last_review_at_ms ? 'DATA_UNAVAILABLE' : 'WARMING_UP', request: false, reason: safety.reason};
  if (settledAt !== null && capture.start_ms <= settledAt) return {state: 'WATCHING', request: false, reason: 'POST_SETTLEMENT_EVIDENCE_PENDING'};
  if (watch?.in_flight === true) return {state: 'REVIEWING', request: false, reason: 'SINGLE_FLIGHT'};
  if (watch?.last_capture_end_ms >= capture.end_ms) return {state: 'WATCHING', request: false, reason: 'DUPLICATE_SNAPSHOT'};
  const elapsed = at - (watch?.last_review_at_ms ?? 0);
  const changed = watch?.capture ? dynamicDelta(watch.capture, capture) : null;
  const h = capture.dynamics?.horizons?.s15, old = watch?.capture?.dynamics?.horizons?.s15;
  const strengthening = old && h && (h.return > old.return || h.net_taker_flow > old.net_taker_flow || h.imbalance > old.imbalance);
  const initial = !watch?.last_review_at_ms, fair = elapsed >= policy.fairReviewMs;
  const changedDue = elapsed >= policy.minReviewMs && (changed?.review || strengthening || watch?.state === 'DATA_UNAVAILABLE');
  return {state: hasExposure && !member ? 'MANAGE_ONLY' : 'WATCHING', request: initial || fair || !!changedDue,
    reason: initial ? 'INITIAL_COMPLETE_CAPTURE' : fair ? 'FAIR_REEVALUATION' : changedDue ? 'EVIDENCE_CHANGED' : 'OBSERVING',
    priority: hasExposure ? 0 : strengthening ? 2 : 3, authority: 'REVIEW_REQUEST_ONLY'};
}
export function campaignOutcome(decision, technical = null) {
  if (technical) return {state: 'DEFERRED', action: 'DEFER', reason: technical};
  const action = ({BUY: 'ENTER', WAIT: 'DEFER', SKIP: 'DEFER', ABSTAIN: 'DEFER'})[decision] ?? decision;
  if (!['ENTER', 'DEFER', 'HOLD', 'PROTECT', 'EXIT'].includes(action)) throw Error('LEADER20_UNKNOWN_DECISION');
  return {action, state: action === 'ENTER' ? 'ENTRY_APPROVED' : action === 'DEFER' ? 'DEFERRED' : action === 'EXIT' ? 'EXIT_PENDING' : 'OPEN'};
}
