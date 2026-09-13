/**
 * X1 fast-observation candidate.
 *
 * The production R5 equations and QV3 predicate are reused unchanged. X1 changes only
 * observation semantics and emits a candidate command; it performs no database or
 * exchange side effects. A durable worker, lease/CAS, rate budget, and native-stop
 * replacement adapter are intentionally outside this unvalidated research module.
 */
import {nextExitReviewed, EXIT_REVIEW_R5} from '../../supabase/functions/_shared/leader-exit-review.mjs';
import {completed, exitSignal} from '../../supabase/functions/_shared/leader-qv3-rules.mjs';

export const X1_POLICY = Object.freeze({
  policyVersion: 'X1_FAST_OBSERVER_SHADOW_1',
  baseExitPolicyVersion: EXIT_REVIEW_R5.policyVersion,
  maxQuoteAgeMs: 1_000,
  parametersValidatedByBacktest: false,
  executionEnabled: false,
});

const n = value => Number(value);
const finite = value => Number.isFinite(n(value));

function holdUnknown(position, observation, reason) {
  return {
    action: 'HOLD',
    reasonCodes: [reason],
    policyVersion: X1_POLICY.policyVersion,
    baseExitPolicyVersion: X1_POLICY.baseExitPolicyVersion,
    positionId: position.id,
    observationId: observation?.id ?? null,
    observedBidPeak: finite(position.observedBidPeak) ? n(position.observedBidPeak) : null,
    executableVwapPeak: finite(position.executableVwapPeak) ? n(position.executableVwapPeak) : null,
    stopBefore: n(position.stopPrice),
    stopAfter: n(position.stopPrice),
    protectionStage: 'UNKNOWN',
    netCostBreakeven: null,
    protectedQuantity: n(position.quantity),
    nativeOrderGeneration: position.nativeOrderGeneration ?? null,
    idempotencyKey: null,
    qv3EvaluatedBarOpen: position.lastQv3BarOpen ?? null,
    nativeStopCandidate: null,
    dataState: 'UNKNOWN',
    parametersValidatedByBacktest: false,
    executionEnabled: false,
  };
}
function quoteValid(observation, at, maxAgeMs) {
  const bid = n(observation?.bid), ask = n(observation?.ask), receivedAt = n(observation?.quoteReceivedAt);
  return bid > 0 && ask >= bid && observation?.bookGap === false &&
    Number.isSafeInteger(receivedAt) && at - receivedAt >= 0 && at - receivedAt <= maxAgeMs;
}

/**
 * One fresh observation in, one side-effect-free ExitDecision out.
 * `tradeHigh` is accepted only for audit output and NEVER arms R5.
 */
export function observeX1(position, observation, bars = [], policy = X1_POLICY) {
  if (!position?.id || !Number.isSafeInteger(n(observation?.observedAt))) throw new Error('INVALID_X1_IDENTITY');
  const observedAt = n(observation.observedAt);
  if (!quoteValid(observation, observedAt, policy.maxQuoteAgeMs))
    return holdUnknown(position, observation, 'X1_QUOTE_STALE_OR_GAPPED');
  const stopBefore = n(position.stopPrice), tick = n(position.priceTick);
  if (!(stopBefore > 0) || !(tick > 0) || !(n(position.quantity) > 0)) throw new Error('INVALID_X1_POSITION');

  const state = nextExitReviewed({
    entryPrice: n(position.entryPrice),
    entryAt: n(position.entryAt),
    entryFee: n(position.entryFee),
    quantity: n(position.quantity),
    peakPrice: n(position.peakPrice),
    stopPrice: stopBefore,
    lastHighAt: n(position.lastHighAt),
    priceTick: tick,
  }, n(observation.bid), observedAt, {...EXIT_REVIEW_R5, ...position.policy});

  if (state.stopPrice + 1e-12 < stopBefore) throw new Error('X1_STOP_REGRESSION');
  const observedBidPeak = Math.max(
    finite(position.observedBidPeak) ? n(position.observedBidPeak) : n(position.peakPrice),
    n(observation.bid),
  );
  const executableVwapPeak = finite(observation.sellVwap) && n(observation.sellVwap) > 0 ?
    Math.max(finite(position.executableVwapPeak) ? n(position.executableVwapPeak) : 0, n(observation.sellVwap)) :
    (finite(position.executableVwapPeak) ? n(position.executableVwapPeak) : null);

  let action = state.action, reason = state.reason, qv3EvaluatedBarOpen = position.lastQv3BarOpen ?? null;
  if (action === 'HOLD') {
    const closed = completed(bars, observedAt);
    const latestOpen = closed.length ? n(closed.at(-1)[0]) : null;
    if (latestOpen !== null && latestOpen !== qv3EvaluatedBarOpen) {
      qv3EvaluatedBarOpen = latestOpen;
      if (exitSignal({
        entryAt: n(position.entryAt),
        entryPrice: n(position.entryPrice),
        ownership: position.ownership ?? 'AUTO',
      }, bars, observedAt, 'ENTRY_EXIT_TWO')) {
        action = 'CLOSE';
        reason = 'QV3_TWO_BEARISH_CLOSED';
      }
    }
  }

  const improvement = state.stopPrice - stopBefore;
  const nativeStopCandidate = action === 'HOLD' && n(observation.bid) > state.stopPrice &&
    improvement + 1e-12 >= tick ? {
      stopPrice: state.stopPrice,
      protectedQuantity: n(position.quantity),
      priorGeneration: position.nativeOrderGeneration ?? null,
      requiresLeaseCasAndSafeReplace: true,
      executionEnabled: false,
    } : null;
  const reasonCodes = [reason ?? 'X1_HOLD'];
  if (finite(observation.tradeHigh) && n(observation.tradeHigh) > observedBidPeak)
    reasonCodes.push('TRADE_HIGH_AUDIT_ONLY_NOT_EXECUTABLE_PEAK');
  if (!finite(observation.sellVwap)) reasonCodes.push('EXECUTABLE_VWAP_UNKNOWN');

  return {
    action,
    reasonCodes,
    policyVersion: X1_POLICY.policyVersion,
    baseExitPolicyVersion: X1_POLICY.baseExitPolicyVersion,
    positionId: position.id,
    observationId: observation.id,
    observedBidPeak,
    executableVwapPeak,
    stopBefore,
    stopAfter: state.stopPrice,
    protectionStage: state.protectionStage,
    netCostBreakeven: state.breakevenTriggerPrice,
    protectedQuantity: n(position.quantity),
    nativeOrderGeneration: position.nativeOrderGeneration ?? null,
    idempotencyKey: action === 'CLOSE' ? `shadow:${position.id}:${observation.id}:close` : null,
    qv3EvaluatedBarOpen,
    nativeStopCandidate,
    observedMfe: state.observedMfe,
    currentPriceReturn: state.priceReturn,
    tradeHighAuditOnly: finite(observation.tradeHigh) ? n(observation.tradeHigh) : null,
    dataState: 'VALID',
    parametersValidatedByBacktest: false,
    executionEnabled: false,
  };
}
