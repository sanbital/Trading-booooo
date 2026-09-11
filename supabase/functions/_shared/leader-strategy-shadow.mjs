/** Pure hypotheses only. No broker, DB, credentials, timers, or production imports.
 * All percentages are unleveraged price returns. Parameters are NOT promoted.
 */
import {STRATEGY, kstDayStart, entryFresh} from './leader-momentum-v17.mjs';
import {EXIT_REVIEW_R5, nextExitReviewed} from './leader-exit-review.mjs';

export const SHADOW_VERSION = 'V18_STRATEGY_SHADOW_1';
export const VARIANTS = Object.freeze({
  BASELINE: Object.freeze({}),
  REPEAT_STOP_2: Object.freeze({stopLossCountKstDay: 2}),
  SPIKE_3PCT: Object.freeze({maxClosed5mReturn: .03}),
  COMBINED: Object.freeze({stopLossCountKstDay: 2, maxClosed5mReturn: .03}),
  LOCK_1P5: Object.freeze({profitLockArmPct: .015, profitLockCapture: .5}),
});
const stopReasons = new Set(['V17_NATIVE_STOP','V17_HARD_STOP','V17_RISK_CUT',
  'V17_TRAILING_STOP','V17_RATCHET_STOP','V17_PROFIT_LOCK','V17_COST_BREAKEVEN']);
const numeric = v => v === null || v === undefined || v === '' ? NaN : Number(v);
const timestamp = v => typeof v === 'number' ? v : Date.parse(v);

export function confirmedLossHistory(history, symbol, asOf) {
  if (!Array.isArray(history) || !Number.isSafeInteger(asOf)) throw Error('INVALID_HISTORY_INPUT');
  const seen = new Map(), losses = [], unresolved = [];
  const dayStart = kstDayStart(asOf);
  for (const p of history) {
    if (!p?.id) throw Error('HISTORY_ID_MISSING');
    const canonical = JSON.stringify(p);
    if (seen.has(p.id)) {
      if (seen.get(p.id) !== canonical) throw Error('CONFLICTING_HISTORY_DUPLICATE');
      continue;
    }
    seen.set(p.id, canonical);
    if (p.symbol !== symbol || p.metadata?.executionMode !== STRATEGY || p.state !== 'CLOSED') continue;
    const closed = timestamp(p.closed_at), available = timestamp(p.available_at ?? p.updated_at);
    if (!Number.isFinite(closed) || closed < dayStart || closed >= asOf) continue;
    // Current snapshots cannot prove a historical settlement was available before its write.
    if (!Number.isFinite(available)) { unresolved.push(p.id); continue; }
    if (available > asOf) continue;
    const net = numeric(p.realized_pnl_usdt);
    if (!Number.isFinite(net) || p.metadata?.exitAccountingPending === true) {
      unresolved.push(p.id); continue;
    }
    if (net < 0 && stopReasons.has(p.exit_reason)) losses.push({id:p.id, net, closedAt:closed});
  }
  return {dayStart, losses:losses.sort((a,b)=>a.closedAt-b.closedAt), unresolved};
}

export function evaluateEntry({symbol, features, asOf, history=[], historyComplete=true,
  variant='BASELINE', config=VARIANTS[variant]}) {
  if (!config || !Number.isSafeInteger(asOf) || !symbol || symbol !== features?.symbol)
    throw Error('INVALID_ENTRY_INPUT');
  const base = {version:SHADOW_VERSION, variant, symbol, evaluatedAt:asOf,
    executionEnabled:false, parametersValidatedByBacktest:false,
    scope:'FEATURE_FILTER_ONLY_NOT_ORDER_ELIGIBILITY'};
  const fresh = entryFresh(features, asOf, numeric(features.referenceClose));
  if (fresh) return {...base, verdict:'UNAVAILABLE', reasons:[fresh]};
  const reasons=[], unknown=[], evidence={};
  if (config.stopLossCountKstDay !== undefined) {
    if (!Number.isInteger(config.stopLossCountKstDay) || config.stopLossCountKstDay < 1)
      throw Error('INVALID_REPEAT_THRESHOLD');
    if (!historyComplete) unknown.push('HISTORY_INCOMPLETE');
    const h=confirmedLossHistory(history,symbol,asOf);
    evidence.confirmedStopLosses=h.losses; evidence.kstDayStart=h.dayStart;
    if (h.unresolved.length) unknown.push('UNSETTLED_OR_UNDATED_HISTORY');
    if (h.losses.length >= config.stopLossCountKstDay) reasons.push('REPEATED_NET_STOP_LOSS');
  }
  if (config.maxClosed5mReturn !== undefined) {
    if (!(Number.isFinite(config.maxClosed5mReturn) && config.maxClosed5mReturn > 0))
      throw Error('INVALID_SPIKE_THRESHOLD');
    const r=numeric(features.return5m);
    if (!Number.isFinite(r)) unknown.push('CLOSED_5M_RETURN_MISSING');
    else { evidence.closed5mReturn=r; if (r >= config.maxClosed5mReturn) reasons.push('CLOSED_5M_SPIKE'); }
  }
  // An independently proven rejection stays a rejection despite an unrelated missing field.
  return {...base, verdict:reasons.length?'WOULD_FILTER':unknown.length?'UNAVAILABLE':'NO_ADDITIONAL_FILTER',
    reasons:[...reasons,...unknown], evidence};
}

export function evaluateExit(position, bid, asOf, variant='BASELINE') {
  if (!VARIANTS[variant]) throw Error('INVALID_EXIT_VARIANT');
  const config={...EXIT_REVIEW_R5,...(position.policy ?? {})};
  if (variant === 'LOCK_1P5') Object.assign(config,{profitLockArmPct:.015,profitLockCapture:.5});
  // Existing stop, peak, residual quantity and partial state are supplied unchanged.
  const result=nextExitReviewed(position,bid,asOf,config);
  return {...result,version:SHADOW_VERSION,variant,executionEnabled:false,
    scope:'CURRENT_STATE_COUNTERFACTUAL_NOT_INDEPENDENT_PAPER_POSITION'};
}
