import {slotFloor} from './clock.mjs';
import {LEADER20, fetchEpoch} from './universe.mjs';
import {batchControl,runEntryBatch} from './batch-runtime.mjs';
import {isLeader20} from './campaign.mjs';
import {POLICY, STRATEGY} from '../leader-momentum-v17.mjs';
import {validateCapture120} from '../gpt-final-decision/capture-context.mjs';
import {entryCaptureSafety} from '../gpt-final-decision/dynamic-flow.mjs';
import {hash} from '../gpt-final-decision/snapshot-hash.mjs';

export async function leaderControl(db) {
  const r = await db.from('leader20_control').select('*').eq('singleton', true).maybeSingle();
  // Only an absent additive migration permits the existing release to run unchanged.
  if (r.error?.code === '42P01' || r.error?.code === 'PGRST205') return {active_strategy: 'LEGACY', observation_enabled: false};
  if (r.error || !r.data) throw Error('LEADER20_CONTROL_UNAVAILABLE');
  return r.data;
}
export async function requireEntryAuthority(db, row) {
  const ctl = await leaderControl(db);
  if (!isLeader20(row) && ctl.active_strategy === 'LEGACY') return;
  const r = await db.rpc('leader20_entry_authority', {p_signal_id: row.id});
  if (r.error || r.data?.allowed !== true) throw Error(r.data?.reason ?? 'LEADER20_AUTHORITY_UNAVAILABLE');
}

/** Reuses the production generator and its internal-token authentication. */
export async function generateLeader20(db, ctl, {now = Date.now, fetchFn = fetch, diagnostic = false} = {}) {
  let epoch = null;
  if (ctl.epoch_id) {
    const r = await db.from('leader20_epochs').select('*').eq('id', ctl.epoch_id).single();
    if (r.error) throw Error('LEADER20_EPOCH_READ');
    epoch = r.data;
  }
  if (diagnostic) {
    const status=await db.rpc('leader20_status');
    if(status.error)throw Error('LEADER20_STATUS_READ');
    return {ok:true,diagnostic:true,...status.data};
  }
  let refreshError = null;
  const phase=now()-slotFloor(now()),preparing=phase>=420000&&phase<480000;
  const refresh=ctl.clock_capture_enabled?preparing&&(!epoch||epoch.snapshot?.capture_slot_ms!==slotFloor(now())+600000):!epoch||now()>=Date.parse(epoch.next_refresh_at);
  if (refresh) {
    try {
      const snapshot = await fetchEpoch(epoch ? {next_refresh_at_ms: Date.parse(epoch.next_refresh_at)} : null, {now, fetchFn,clock:ctl.clock_capture_enabled===true});
      const r = await db.rpc('leader20_publish_epoch', {p_snapshot: snapshot, p_previous: ctl.epoch_id ?? null});
      if (r.error) throw Error('LEADER20_EPOCH_PUBLISH:' + r.error.message);
      ctl = await leaderControl(db);
    } catch (e) { refreshError = String(e.message); }
  }
  if(ctl.clock_capture_enabled&&(phase<1000||phase>=120000))return {ok:true,strategy:LEADER20,inserted:0,state:preparing?'PREPARING_CAPTURE':phase>=480000?'CAPTURING':'WAITING_FOR_WINDOW',refreshError};
  const batchMode=await batchControl(db);
  // Observation/candidate housekeeping continues even while a batch is not due.
  if(batchMode.enabled){
    const observed=await db.rpc('leader20_schedule');
    if(observed.error)throw Error('LEADER20_OBSERVATION_FAILED');
  }
  const batchOutcome=batchMode.enabled?await runEntryBatch(db,ctl,{now,fetchFn}):null;
  const scheduled = batchMode.enabled?{data:batchOutcome}:await db.rpc('leader20_schedule');
  if (scheduled.error) throw Error('LEADER20_SCHEDULE_FAILED');
  if (ctl.active_strategy !== LEADER20) return {ok: true, strategy: LEADER20, inserted: 0, state: 'OBSERVATION_ONLY', refreshError};
  const queue = await db.from('leader20_review_events').select('*').eq('state', 'REQUESTED')
    .eq('epoch_id', ctl.epoch_id).eq('generation', ctl.generation)
    .order('requested_at', {ascending: true}).order('priority', {ascending: true}).limit(20);
  if (queue.error) throw Error('LEADER20_QUEUE_READ');
  const outcomes = [];
  for (const e of queue.data ?? []) {
    try {
      if(batchMode.enabled&&!e.result?.batch_advice){outcomes.push({symbol:e.symbol,reason:'BATCH_ADVICE_REQUIRED'});continue;}
      const at = now(), raw = await db.rpc('doa_context_for_role_v1', {p_symbol: e.symbol,
        p_as_of: new Date(at).toISOString(), p_role: 'TRADE_CANDIDATE', p_position_id: null});
      if (raw.error) throw Error('CAPTURE_READ');
      const capture = validateCapture120(raw.data, now()), safety = entryCaptureSafety(capture, now());
      if (!safety.ok) { outcomes.push({symbol: e.symbol, reason: safety.reason}); continue; }
      const member = await db.from('leader20_members').select('rank,price_change_percent').eq('epoch_id', e.epoch_id).eq('symbol', e.symbol).single();
      if (member.error) throw Error('MEMBERSHIP_READ');
      const ref = capture.trajectory.at(-1).mid;
      const features = {strategy: STRATEGY, routeAuthority: LEADER20, rank: member.data.rank,
        execution_snapshot:{captured_at_ms:now(),end_ms:capture.end_ms,start_ms:capture.start_ms,
          complete:capture.complete,causal:capture.causal,bucket_count:capture.bucket_count,
          trajectory_hash:await hash(capture.trajectory),...(capture.entry_window?{entry_window:capture.entry_window}:{})},
        rankBasis: 'ROLLING_24H', rolling24hChangePercent: member.data.price_change_percent,
        referenceClose: ref, atr: null, atrBasis: 'NOT_USED_BY_LEADER20',
        exitPolicy: {stopPct: POLICY.stopPct, trailArmPct: POLICY.trailArmPct, trailGapPct: POLICY.trailGapPct,
          staleMs: POLICY.staleMs, maxHoldMs: POLICY.maxHoldMs},
        sizingContractVersion: POLICY.sizingContractVersion, targetMarginUsdt: POLICY.marginUsdt,
        leverage: POLICY.leverage, maxSlots: POLICY.maxSlots, storageLaneOnly: 'BULL',
        ...(e.result?.batch_advice?{batch_advice:e.result.batch_advice,batch_id:e.result.batch_id}:{})};
      const r = await db.rpc('leader20_materialize_event', {p_event_id: e.id, p_features: features});
      if (r.error) throw Error('EVENT_MATERIALIZE:' + r.error.message);
      outcomes.push({symbol: e.symbol, ...r.data});
    } catch (error) { outcomes.push({symbol: e.symbol, reason: String(error.message)}); }
  }
  return {ok: true, strategy: LEADER20, epoch_id: ctl.epoch_id, generation: ctl.generation,
    inserted: outcomes.filter(x => x.created).length, outcomes, refreshError};
}
