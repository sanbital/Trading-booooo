/** Dynamic evidence integrity and review scheduling. Never chooses a strategic exit. */
export const DYNAMIC_VERSION = 'DYNAMIC_FLOW_LIFECYCLE_1';
export const HORIZONS = Object.freeze([5, 15, 30, 60, 120]);
export const DYNAMIC_POLICY = Object.freeze({
  version: DYNAMIC_VERSION, bucketMs: 5000, buckets: 24,
  normalAgeMs: 5000, absoluteAgeMs: 10000, positionReadMs: 5000,
  missingRetryMs: 5000, periodicReviewMs: 120000, fastReviewMs: 6000,
  singleModelBuyConfidence: 0.8, maxWaitReviews: 3,
});
const finite = Number.isFinite;
const validTime = Number.isSafeInteger;
const unavailable = (reason, extra = {}) => ({ok: false, decision: 'WAIT', reason, ...extra});
/** The clock is the capture's last completed bucket, never the current quote's clock. */
export function entryCaptureSafety(c, at, {btc = null, btcRequired = false, policy = DYNAMIC_POLICY} = {}) {
  if (!validTime(at)) return unavailable('DYNAMIC_CLOCK_INVALID');
  if (c?.status !== 'AVAILABLE') return unavailable('DYNAMIC_' + (c?.reason ?? 'UNAVAILABLE'));
  const age = at - c.end_ms;
  if (!validTime(c.end_ms) || age < 0 || age >= Math.min(10000, policy.absoluteAgeMs))
    return unavailable('DYNAMIC_TRAJECTORY_STALE_OR_FUTURE', {trajectory_age_ms: finite(age) ? age : null});
  const p = c.trajectory;
  if (c.buckets !== policy.buckets || !Array.isArray(p) || p.length !== policy.buckets ||
      !validTime(c.start_ms) || c.end_ms - c.start_ms < policy.buckets * policy.bucketMs - policy.bucketMs)
    return unavailable('DYNAMIC_INCOMPLETE_TRAJECTORY');
  for (let i = 0; i < p.length; i++) {
    const x = p[i];
    if (!x || !['start_ms','end_ms','bucket_ms','received_at_ms','exchange_event_ms','book_received_at_ms'].every(k => validTime(x[k])) ||
        x.end_ms > at || x.received_at_ms > at || x.received_at_ms < x.end_ms ||
        x.exchange_event_ms > x.end_ms || x.book_received_at_ms > x.end_ms ||
        x.book_received_at_ms < x.exchange_event_ms - 1000 || x.book_received_at_ms - x.exchange_event_ms > 10000 ||
        x.end_ms - x.book_received_at_ms > 10000 || Math.abs(x.end_ms - x.bucket_ms) >= 1000 ||
        x.end_ms - x.start_ms < 4000 || x.end_ms - x.start_ms > 6500 ||
        (i && (x.start_ms !== p[i - 1].end_ms || x.bucket_ms - p[i - 1].bucket_ms !== policy.bucketMs)))
      return unavailable('DYNAMIC_NONCAUSAL_BUCKET');
    if (!(x.mid > 0) || !(x.start_mid > 0) || !finite(x.mid) || !finite(x.start_mid) ||
        !['bid_depth_25_usdt','ask_depth_25_usdt','spread_bps','imbalance','buy_impact_450_bps','sell_impact_450_bps'].every(k => finite(x[k])) ||
        x.bid_depth_25_usdt <= 0 || x.ask_depth_25_usdt <= 0 || x.spread_bps < 0)
      return unavailable('DYNAMIC_BOOK_INCOMPLETE');
    if (!finite(x.aggressive_buy) || !finite(x.aggressive_sell) || x.aggressive_buy < 0 || x.aggressive_sell < 0 ||
        !validTime(x.trade_count) || x.trade_count < 0 ||
        (x.trade_count > 0 && (!validTime(x.flow_event_ms) || !validTime(x.flow_received_at_ms) ||
         x.flow_event_ms > x.end_ms || x.flow_received_at_ms > x.end_ms || x.flow_received_at_ms <= x.start_ms)))
      return unavailable('DYNAMIC_FLOW_UNKNOWN');
  }
  if (p[0].start_ms !== c.start_ms || p.at(-1).end_ms !== c.end_ms)
    return unavailable('DYNAMIC_WINDOW_MISMATCH');
  if (HORIZONS.some(s => !finite(c.dynamics?.horizons?.['s' + s]?.return) ||
      !finite(c.dynamics?.horizons?.['s' + s]?.net_taker_flow))) return unavailable('DYNAMIC_HORIZONS_INCOMPLETE');
  if (btcRequired && !entryCaptureSafety(btc, at, {policy}).ok) return unavailable('DYNAMIC_BTC_UNAVAILABLE');
  return {ok: true, reason: null, trajectory_age_ms: age, refresh_recommended: age > policy.normalAgeMs,
    trajectory_end_ms: c.end_ms, trajectory_hash: c.trajectory_hash ?? null};
}
/** Sign changes and multi-axis deterioration request another judgment, never a SELL. */
export function dynamicDelta(initial, current) {
  if (initial?.status !== 'AVAILABLE' || current?.status !== 'AVAILABLE')
    return {review: true, reasons: ['DYNAMIC_COMPARISON_UNAVAILABLE'], changes: {}};
  const changes = {}, reasons = [], weak = new Set();
  for (const s of HORIZONS) {
    const a = initial.dynamics?.horizons?.['s' + s], b = current.dynamics?.horizons?.['s' + s];
    if (!a || !b) { reasons.push('DYNAMIC_HORIZON_MISSING_' + s); continue; }
    const keys = ['return','velocity_bps_s','acceleration_bps_s2','buy_share','buy_share_slope',
      'net_taker_flow','flow_acceleration','bid_liquidity_change','ask_liquidity_change',
      'imbalance','imbalance_trend','spread','buy_impact_450_bps','high_renewal_slowdown',
      'drawdown_from_sampled_peak','recovery_velocity_bps_s'];
    changes['s' + s] = Object.fromEntries(keys.map(k => [k, finite(a[k]) && finite(b[k]) ? b[k] - a[k] : null]));
    if (s <= 15 && finite(a.return) && finite(b.return) && a.return >= 0 && b.return < 0)
      reasons.push('DYNAMIC_RETURN_REVERSED_' + s);
    if (finite(a.net_taker_flow) && finite(b.net_taker_flow) && a.net_taker_flow >= 0 && b.net_taker_flow < 0)
      reasons.push('DYNAMIC_FLOW_REVERSED_' + s);
    const d = changes['s' + s];
    if (d.return < 0 && d.velocity_bps_s < 0) weak.add('PRICE');
    if (d.buy_share < 0 && d.net_taker_flow < 0) weak.add('FLOW');
    if (d.bid_liquidity_change < 0 && (d.ask_liquidity_change > 0 || d.imbalance < 0)) weak.add('BOOK');
    if (d.high_renewal_slowdown > 0 && d.recovery_velocity_bps_s < 0) weak.add('PARTICIPATION');
  }
  if (weak.size >= 2) reasons.push('DYNAMIC_MULTI_AXIS_CHANGE');
  return {review: reasons.length > 0, reasons: [...new Set(reasons)], changes, weakening_axes: [...weak]};
}
export function dispatchDynamicSafety({reviewed, latest, at, btc, btcRequired = false}) {
  const current = entryCaptureSafety(latest, at, {btc, btcRequired});
  if (!current.ok) return current;
  const original = entryCaptureSafety(reviewed, at, {btc, btcRequired});
  if (!original.ok) return {...original, reason: 'REVIEWED_' + original.reason};
  if (latest.end_ms < reviewed.end_ms) return unavailable('DYNAMIC_CAPTURE_REGRESSED');
  const delta = dynamicDelta(reviewed, latest);
  return delta.review ? unavailable('DYNAMIC_DIRECTION_REVIEW_REQUIRED', {delta, current, reviewed: original}) :
    {ok: true, decision: 'BUY_NOW', reason: null, delta, current, reviewed: original};
}
/** Original buckets remain in the journal; models get horizons and critical segments. */
export function compactDynamic(c) {
  if (c?.status !== 'AVAILABLE') return c ?? {status: 'UNAVAILABLE', reason: 'MISSING'};
  const p = c.trajectory ?? [], indices = new Set([0, p.length - 1]);
  const largest = key => p.reduce((best, x, i) => finite(x[key]) && (!finite(p[best]?.[key]) || x[key] > p[best][key]) ? i : best, 0);
  indices.add(largest('aggressive_buy')); indices.add(largest('aggressive_sell'));
  const inflections = [];
  for (let i = 1; i < p.length; i++) if (finite(p[i].d_mid_bps) && finite(p[i - 1].d_mid_bps) &&
      Math.sign(p[i].d_mid_bps) !== Math.sign(p[i - 1].d_mid_bps)) inflections.push(i);
  for (const i of inflections.slice(-4)) indices.add(i);
  const {trajectory, ...summary} = c;
  return {...summary, representation: 'COMPACT_WITH_ORIGINAL_BUCKET_INDEX',
    critical_segments: [...indices].filter(i => i >= 0).sort((a,b) => a-b).map(i => ({index: i, ...p[i]})),
    raw_bucket_count: p.length};
}
/** Absence of data changes confidence and schedules review, never creates an EXIT. */
export function positionDynamicState(previous, capture, {at, bid, entry, generation, positionId, emergency = null}) {
  const prior = previous && previous.generation === generation ? previous : {};
  const valid = entryCaptureSafety(capture, at).ok;
  const last = valid ? capture : prior.last_valid_capture ?? null;
  const reference = last?.trajectory?.at(-1)?.mid;
  return {version: DYNAMIC_VERSION, position_id: String(positionId), generation, observed_at_ms: at,
    status: valid ? 'AVAILABLE' : 'DATA_DEGRADED', capture_reason: valid ? null : entryCaptureSafety(capture, at).reason,
    capture, last_valid_capture: last, last_valid_age_ms: last ? at - last.end_ms : null,
    drift_from_last_valid: reference > 0 && bid > 0 ? bid / reference - 1 : null,
    current_return: entry > 0 && bid > 0 ? bid / entry - 1 : null,
    confidence: valid ? 'NORMAL' : 'LOW', exposure_increase_allowed: false,
    hard_stop_action: 'KEEP', approved_protection_action: 'NEVER_LOWER', emergency_packet: emergency};
}
/** Multi-axis entry failure is evidence for immediate AI review, including post-fill. */
export function entryFailureEvidence(c, {entry, peak, prior = null} = {}) {
  if (c?.status !== 'AVAILABLE') return {review: false, status: 'DATA_DEGRADED', axes: []};
  const h = c.dynamics?.horizons, a = h?.s15, b = h?.s30;
  if (!a || !b) return {review: false, status: 'DATA_DEGRADED', axes: []};
  const axes = [];
  if (a.return < 0 && b.return < 0 && (c.dynamics.acceleration < 0 || a.sampled_high_renewals === 0)) axes.push('PRICE');
  if (a.net_taker_flow < 0 && (a.buy_share_slope < 0 || a.aggressive_sell > a.aggressive_buy)) axes.push('FLOW');
  if (a.bid_liquidity_change < 0 && (a.ask_liquidity_change > 0 || a.imbalance < 0)) axes.push('BOOK');
  if (a.high_renewal_slowdown > 0 && (a.arrival_rate_slope < 0 ||
      finite(prior?.dynamics?.horizons?.s15?.trade_count) && a.trade_count < prior.dynamics.horizons.s15.trade_count)) axes.push('PARTICIPATION');
  const recovery = a.return > 0 && a.net_taker_flow > 0 && a.bid_liquidity_change > 0;
  return {review: axes.length >= 2 && !recovery, status: 'AVAILABLE', axes, recovery,
    no_positive_excursion: finite(peak) && finite(entry) ? peak <= entry : null,
    action: 'FAST_AI_REVIEW_ONLY'};
}
