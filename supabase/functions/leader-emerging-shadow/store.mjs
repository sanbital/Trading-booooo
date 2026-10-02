/** LE-SHADOW-1 database access. Every statement the shadow can run is a constant in SQL below
 * (the order-free test parses them): reads of eight production tables, INSERTs into shadow_le,
 * and calls to shadow_le functions. The connection is the shadow_le_writer role, which the
 * database itself limits to exactly that. `db.query(text, params)` returns rows. */
import {OBSERVER_REVISION} from './universe.mjs';

const CYCLE_COLS=['mode','status','started_at','finished_at','kst_day','observation_bucket','observed_at','source','observer_age_ms',
  'n_universe','n_unanchored','rank_order','top50','velocity_valid','n_leader','n_emerging','n_control','n_shortlist','arms_active',
  'request_weight','used_weight_max','binance_status','gpt_state','gpt_calls','errors','detail','patch'];
export const CANDIDATE_COLS=['observed_at','kst_day','symbol','lane','rank_now','rank_15m','rank_30m','rank_60m','rank_velocity_15m',
  'rank_velocity_60m','velocity_valid','minutes_since_kst_midnight','first_top3_today','leader_reentry_60m','first_top10_today',
  'first_top10_at','minutes_in_top10_today','day_return_live','obs_price','shortlisted','selection_reason','vr15','v17','b06133','v30',
  'cec_readonly','facts','micro_complete','cost','soft_categories','hard_block','alt_score_v1','alt_score_v2','read_errors'];
export const DECISION_COLS=['symbol','arm','attempt','parent_decision_id','decision','valid','reasons','support','expected_move_bps',
  'wait_trigger','wait_expires_at','packet','packet_hash','model','prompt_hash','schema_hash','snapshot_at','answered_at','latency_ms',
  'tokens_in','tokens_out','cost_usd','request_id','error','hyp_entry_at','hyp_entry_ask','hyp_entry_mid','hyp_spread_bps',
  'hyp_slip_bps_600','hyp_slip_bps_450'];
export const OUTCOME_COLS=['candidate_id','decision_id','outcome_version','entry_ref','hyp_entry_at','hyp_entry_price','hyp_fwd_5m',
  'hyp_fwd_15m','hyp_fwd_30m','hyp_fwd_60m','hyp_fwd_120m','hyp_fwd_240m','hyp_mfe_60','hyp_mae_60','hyp_mfe_240','hyp_mae_240',
  'hyp_sim_exit_reason','hyp_sim_hold_min','hyp_sim_gross_bps','hyp_sim_net_bps_real','hyp_sim_net_bps_stress44',
  'hyp_net_bps_real_60m','hyp_net_bps_real_120m','hyp_net_bps_stress44_60m','hyp_net_bps_stress44_120m','hyp_net_usdt_600',
  'hyp_cost_bps_real','hyp_cost_bps_real_450','cost','sim','data_complete'];
const ANCHOR_COLS=['kst_day','day_start','anchor_bucket','anchor_observed_at','anchor_lag_ms','anchor_quality','source','prices',
  'n_prices','coin_symbols','n_coin','excluded','exchange_info_at','patch'];
const WAIT_EVENT_COLS=['decision_id','symbol','event','at','hyp_price','detail'];
const list=cs=>cs.join(', '),pick=(cs,a='r')=>cs.map(c=>a+'.'+c).join(', ');

export const SQL=Object.freeze({
  control:`select enabled, gpt_enabled from shadow_le.control where singleton`,
  haltedToday:`select binance_status from shadow_le.cycles where started_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc') and binance_status like 'BINANCE_HTTP_%' limit 1`,
  observerLatest:`select observation_bucket, observed_at, liquid_prices from public.market_regime_observations where model_revision = $1 order by observed_at desc limit 1`,
  observerFirstAfter:`select observation_bucket, observed_at, liquid_prices from public.market_regime_observations where model_revision = $1 and observed_at >= $2::timestamptz order by observed_at asc limit 1`,
  observerRange:`select observation_bucket, observed_at, liquid_prices from public.market_regime_observations where model_revision = $1 and observed_at >= $2::timestamptz and observed_at < $3::timestamptz order by observed_at asc`,
  scanExists:`select 1 as x from shadow_le.cycles where mode = 'SCAN' and status = 'OK' and observation_bucket = $1::timestamptz limit 1`,
  anchor:`select kst_day, prices, coin_symbols, anchor_observed_at, anchor_quality from shadow_le.day_anchor where kst_day = $1::date`,
  insertAnchor:`insert into shadow_le.day_anchor(${list(ANCHOR_COLS)}) select ${pick(ANCHOR_COLS)} from jsonb_populate_record(null::shadow_le.day_anchor, $1::text::jsonb) r on conflict (kst_day) do nothing returning kst_day`,
  historyRefs:`select observed_at, rank_order from shadow_le.cycles where mode = 'SCAN' and status = 'OK' and observed_at >= $1::timestamptz and observed_at < $2::timestamptz order by observed_at`,
  historyToday:`select observed_at, jsonb_path_query_array(rank_order, '$[0 to 9]') as top10 from shadow_le.cycles where mode = 'SCAN' and status = 'OK' and kst_day = $1::date and observed_at < $2::timestamptz order by observed_at`,
  recentShortlisted:`select distinct symbol from shadow_le.candidates where shortlisted and observed_at > $1::timestamptz`,
  cec:`select ewma_usdt, training_count, updated_at from public.v11_cec0040_state where singleton`,
  prodTop10Latest:`select signal_close_at, captured_at, details->'top10' as top10 from public.v17_market_scan_runs order by captured_at desc limit 1`,
  prodTop10Since:`select signal_close_at, captured_at, details->'top10' as top10 from public.v17_market_scan_runs where signal_close_at >= $1::timestamptz order by signal_close_at, captured_at`,
  gptHealth:`select shadow_le.production_gpt_health() as h`,
  budgetReserve:`select shadow_le.budget_reserve($1::numeric, $2::text) as r`,
  budgetSettle:`select shadow_le.budget_settle($1::bigint, $2::numeric) as r`,
  budgetState:`select shadow_le.budget_state() as r`,
  writeCycle:`with cy as (
      insert into shadow_le.cycles(${list(CYCLE_COLS)}) select ${pick(CYCLE_COLS)} from jsonb_populate_record(null::shadow_le.cycles, $1::text::jsonb) r returning cycle_id),
    ins_c as (
      insert into shadow_le.candidates(cycle_id, ${list(CANDIDATE_COLS)})
      select cy.cycle_id, ${pick(CANDIDATE_COLS)} from cy, jsonb_populate_recordset(null::shadow_le.candidates, $2::text::jsonb) r returning candidate_id, symbol),
    ins_d as (
      insert into shadow_le.decisions(candidate_id, cycle_id, ${list(DECISION_COLS)})
      select c.candidate_id, cy.cycle_id, ${pick(DECISION_COLS)} from cy, jsonb_populate_recordset(null::shadow_le.decisions, $3::text::jsonb) r join ins_c c on c.symbol = r.symbol
      returning decision_id, candidate_id, symbol, arm, decision)
    select (select cycle_id from cy) as cycle_id, (select count(*) from ins_c) as n_candidates,
      (select coalesce(jsonb_agg(jsonb_build_object('decision_id', decision_id, 'candidate_id', candidate_id, 'symbol', symbol, 'arm', arm, 'decision', decision)), '[]'::jsonb) from ins_d) as decisions`,
  insertCycleOnly:`insert into shadow_le.cycles(${list(CYCLE_COLS)}) select ${pick(CYCLE_COLS)} from jsonb_populate_record(null::shadow_le.cycles, $1::text::jsonb) r returning cycle_id`,
  insertDecisions:`insert into shadow_le.decisions(candidate_id, cycle_id, ${list(DECISION_COLS)})
    select r.candidate_id, r.cycle_id, ${pick(DECISION_COLS)} from jsonb_populate_recordset(null::shadow_le.decisions, $1::text::jsonb) r
    on conflict do nothing returning decision_id, arm, attempt`,
  activeWaits:`select d.decision_id, d.candidate_id, d.cycle_id, d.symbol, d.wait_trigger, d.wait_expires_at, d.snapshot_at, d.packet, k.rank_now, k.lane
    from shadow_le.decisions d join shadow_le.candidates k on k.candidate_id = d.candidate_id
    where d.decision = 'WAIT' and d.wait_expires_at > now() and not exists (select 1 from shadow_le.wait_events e where e.decision_id = d.decision_id)
    order by d.snapshot_at limit 5`,
  cyclesAfter:`select observed_at, rank_order from shadow_le.cycles where mode = 'SCAN' and status = 'OK' and observed_at > $1::timestamptz order by observed_at`,
  claimWaitEvent:`insert into shadow_le.wait_events(${list(WAIT_EVENT_COLS)}) select ${pick(WAIT_EVENT_COLS)} from jsonb_populate_record(null::shadow_le.wait_events, $1::text::jsonb) r on conflict (decision_id) do nothing returning event_id`,
  sweepExpiredWaits:`insert into shadow_le.wait_events(decision_id, symbol, event, at, detail)
    select d.decision_id, d.symbol, 'EXPIRED', d.wait_expires_at, '{"by":"sweep"}'::jsonb from shadow_le.decisions d
    where d.decision = 'WAIT' and d.wait_expires_at <= now() and not exists (select 1 from shadow_le.wait_events e where e.decision_id = d.decision_id)
    on conflict (decision_id) do nothing returning event_id`,
  outcomeDue:`select * from (
      select 'CANDIDATE' as kind, k.candidate_id, null::bigint as decision_id, k.symbol, 'ASK_AT_DECISION' as entry_ref, d.hyp_entry_at, d.hyp_entry_ask,
        d.hyp_slip_bps_600, d.hyp_slip_bps_450, d.hyp_spread_bps
      from shadow_le.candidates k join lateral (select * from shadow_le.decisions d where d.candidate_id = k.candidate_id and d.arm in ('RULE_BASELINE','TAKE_ALL')
        and d.hyp_entry_at is not null order by d.decision_id limit 1) d on true
      where k.shortlisted and d.hyp_entry_at < $1::timestamptz
        and not exists (select 1 from shadow_le.outcomes o where o.candidate_id = k.candidate_id and o.decision_id is null and o.entry_ref = 'ASK_AT_DECISION')
      union all
      select 'DECISION', d.candidate_id, d.decision_id, d.symbol, case when d.arm = 'WAIT_MECHANICAL' then 'ASK_AT_WAIT_TRIGGER' else 'ASK_AFTER_ANSWER' end,
        d.hyp_entry_at, d.hyp_entry_ask, d.hyp_slip_bps_600, d.hyp_slip_bps_450, d.hyp_spread_bps
      from shadow_le.decisions d
      where d.arm in ('GPT_ALT1','WAIT_MECHANICAL') and d.decision = 'BUY' and d.hyp_entry_at < $1::timestamptz
        and not exists (select 1 from shadow_le.outcomes o where o.decision_id = d.decision_id)) z
    order by hyp_entry_at limit $2::int`,
  insertOutcomes:`insert into shadow_le.outcomes(${list(OUTCOME_COLS)}) select ${pick(OUTCOME_COLS)} from jsonb_populate_recordset(null::shadow_le.outcomes, $1::text::jsonb) r on conflict do nothing returning outcome_id`,
  labelObserver:`select shadow_le.label_observer_outcomes($1::int) as n`,
  linkProduction:`select shadow_le.link_production($1::int) as n`,
});

const toParam=v=>v===null||v===undefined?null:typeof v==='object'?JSON.stringify(v):String(v);
export function makeStore(db){
  const q=(name,params=[])=>db.query(SQL[name],params.map(toParam));
  const one=async(name,params)=>(await q(name,params))[0]??null;
  return {
    q,one,
    control:()=>one('control'),
    haltedToday:()=>one('haltedToday'),
    observerLatest:()=>one('observerLatest',[OBSERVER_REVISION]),
    observerFirstAfter:at=>one('observerFirstAfter',[OBSERVER_REVISION,at]),
    observerRange:(from,to)=>q('observerRange',[OBSERVER_REVISION,from,to]),
    scanExists:async bucket=>!!(await one('scanExists',[bucket])),
    anchor:day=>one('anchor',[day]),
    insertAnchor:row=>one('insertAnchor',[row]),
    historyRefs:(from,to)=>q('historyRefs',[from,to]),
    historyToday:(day,before)=>q('historyToday',[day,before]),
    recentShortlisted:async since=>new Set((await q('recentShortlisted',[since])).map(r=>r.symbol)),
    cec:()=>one('cec'),
    prodTop10Latest:()=>one('prodTop10Latest'),
    prodTop10Since:since=>q('prodTop10Since',[since]),
    gptHealth:async()=>(await one('gptHealth'))?.h??null,
    budgetReserve:async(usd,purpose)=>(await one('budgetReserve',[usd,purpose]))?.r??null,
    budgetSettle:async(id,usd)=>(await one('budgetSettle',[id,usd]))?.r??null,
    writeCycle:(cycle,candidates,decisions)=>one('writeCycle',[cycle,candidates,decisions]),
    insertCycleOnly:cycle=>one('insertCycleOnly',[cycle]),
    insertDecisions:rows=>q('insertDecisions',[rows]),
    activeWaits:()=>q('activeWaits'),
    cyclesAfter:at=>q('cyclesAfter',[at]),
    claimWaitEvent:row=>one('claimWaitEvent',[row]),
    sweepExpiredWaits:()=>q('sweepExpiredWaits'),
    outcomeDue:(before,limit)=>q('outcomeDue',[before,limit]),
    insertOutcomes:rows=>q('insertOutcomes',[rows]),
    labelObserver:async n=>Number((await one('labelObserver',[n]))?.n??0),
    linkProduction:async n=>Number((await one('linkProduction',[n]))?.n??0),
  };
}
