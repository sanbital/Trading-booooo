/** LE-SHADOW-2 database access. Every statement is a constant below (the order-free test parses
 * them): SELECTs of production tables the shadow_le_writer role can already read, INSERTs into
 * shadow_le.v2_* and calls of shadow_le.v2_* functions. No production write exists. */
export const EVENT_COLS=['lane','symbol','cycle_id','candidate_id','scan_lane','prod_job_key','prod_signal_id','prod_candidate_id','prod_snapshot_hash',
  'candidate_at','snapshot_at','snapshot_offset_ms','snapshot_source','spread_bps','bid_depth_25bps_usdt','ask_depth_25bps_usdt','bid_depth_to_order',
  'ask_depth_to_order','book_imbalance_25bps','max_bid_wall_to_order','max_ask_wall_to_order','estimated_buy_slippage_bps','order_notional_basis_usdt',
  'micro_complete','entry_ref_at','entry_ref_ask','entry_ref_bid','entry_ref_mid','entry_beyond_ask_bps','roundtrip_cost_bps','rank_context','facts',
  'axes','legacy','hard_safety','prescore','patch'];
export const V2_DECISION_COLS=['event_id','lane','symbol','decision_source','attempt','parent_decision_id','decision','valid','actual_trade','shadow_trade',
  'phase','overheat_view','reasons','support','override','legacy_negatives','expected_move_bps','wait_reason','recheck_trigger','wait_expires_at','gate',
  'packet','packet_hash','model','prompt_hash','schema_hash','asked_at','answered_at','latency_ms','tokens_in','tokens_out','cost_usd','request_id',
  'error','note','hyp_entry_at','hyp_entry_ask','hyp_entry_basis','hyp_entry_beyond_ask_bps'];
export const V2_OUTCOME_COLS=['event_id','decision_id','outcome_version','entry_basis','hyp_entry_at','hyp_entry_price','horizons','ret_5m','ret_15m',
  'ret_30m','ret_60m','ret_120m','ret_240m','mfe_60m','mae_60m','mfe_240m','mae_240m','gross_bps_60m','net_bps_60m','gross_bps_120m','net_bps_120m',
  'gross_bps_240m','net_bps_240m','roundtrip_cost_bps','cost_basis','cost','data_complete','prod_reviewed','prod_actual_trade','prod_position_id',
  'prod_position_state','prod_realized_pnl_usdt'];
const V2_WAIT_EVENT_COLS=['decision_id','symbol','event','at','hyp_price','detail'];
const CYCLE_COLS=['mode','status','started_at','finished_at','request_weight','used_weight_max','binance_status','gpt_state','gpt_calls','errors','detail','patch'];
const list=cs=>cs.join(', '),pick=(cs,a='r')=>cs.map(c=>a+'.'+c).join(', ');

export const SQL_V2=Object.freeze({
  controlV2:`select enabled, gpt_enabled, v2_discovery_gpt, v2_parity_enabled from shadow_le.control where singleton`,
  cecState:`select ewma_usdt, training_count, reject_run, updated_at from public.v11_cec0040_state where singleton`,
  prodScanLatest:`select captured_at, details->'blocked' as blocked, details->'errors' as errors from public.v17_market_scan_runs order by captured_at desc limit 1`,
  prodEntryPending:`select r.job_key, r.signal_id, r.symbol, r.candidate_id, r.decision, r.valid, r.error, r.snapshot_at, r.created_at,
      r.record->'packet' as packet, r.record->>'identity_json' as identity_json, r.record->'snapshot_at_ms' as snapshot_at_ms, r.record->'result'->>'origin' as origin
    from public.gpt_final_entry_reviews r
    where r.purpose = 'PRODUCTION' and r.state = 'DONE' and r.created_at > $1::timestamptz and r.record->'packet'->>'task' = 'ENTRY'
      and not exists (select 1 from shadow_le.v2_events e where e.lane = 'PARITY' and e.prod_job_key = r.job_key)
    order by r.created_at limit $2::int`,
  rankCycles:`select observed_at, rank_order from shadow_le.cycles where mode = 'SCAN' and status = 'OK' and observed_at >= $1::timestamptz and observed_at < $2::timestamptz order by observed_at`,
  cyclesAfterV2:`select observed_at, rank_order from shadow_le.cycles where mode = 'SCAN' and status = 'OK' and observed_at > $1::timestamptz order by observed_at limit 4`,
  insertEvent:`insert into shadow_le.v2_events(${list(EVENT_COLS)}) select ${pick(EVENT_COLS)} from jsonb_populate_record(null::shadow_le.v2_events, $1::text::jsonb) r
    on conflict do nothing returning event_id`,
  insertV2Decisions:`insert into shadow_le.v2_decisions(${list(V2_DECISION_COLS)}) select ${pick(V2_DECISION_COLS)} from jsonb_populate_recordset(null::shadow_le.v2_decisions, $1::text::jsonb) r
    on conflict do nothing returning decision_id, event_id, decision_source, attempt, decision`,
  v2OpenWaits:`select d.decision_id, d.event_id, d.lane, d.symbol, d.recheck_trigger, d.wait_expires_at, d.packet, e.snapshot_at, e.entry_ref_mid, e.rank_context
    from shadow_le.v2_decisions d join shadow_le.v2_events e on e.event_id = d.event_id
    where d.decision = 'WAIT' and not exists (select 1 from shadow_le.v2_wait_events w where w.decision_id = d.decision_id)
    order by d.wait_expires_at limit 10`,
  claimV2WaitEvent:`insert into shadow_le.v2_wait_events(${list(V2_WAIT_EVENT_COLS)}) select ${pick(V2_WAIT_EVENT_COLS)} from jsonb_populate_record(null::shadow_le.v2_wait_events, $1::text::jsonb) r
    on conflict (decision_id) do nothing returning wait_event_id`,
  v2OutcomeDue:`select * from (
      select e.event_id, null::bigint as decision_id, 'EVENT_SNAPSHOT_ASK' as entry_basis, e.lane, e.symbol, e.snapshot_at, e.prod_signal_id,
        e.entry_ref_at as entry_at, e.entry_ref_ask as entry_price, e.entry_beyond_ask_bps as beyond
      from shadow_le.v2_events e
      where e.entry_ref_at < $1::timestamptz and e.entry_ref_ask > 0
        and not exists (select 1 from shadow_le.v2_outcomes o where o.event_id = e.event_id and o.decision_id is null)
      union all
      select d.event_id, d.decision_id, 'WAIT_TRIGGER_ASK', d.lane, d.symbol, e.snapshot_at, e.prod_signal_id, d.hyp_entry_at, d.hyp_entry_ask, d.hyp_entry_beyond_ask_bps
      from shadow_le.v2_decisions d join shadow_le.v2_events e on e.event_id = d.event_id
      where d.hyp_entry_basis = 'WAIT_TRIGGER_ASK' and d.decision = 'BUY' and d.hyp_entry_at < $1::timestamptz and d.hyp_entry_ask > 0
        and not exists (select 1 from shadow_le.v2_outcomes o where o.decision_id = d.decision_id)) z
    order by entry_at limit $2::int`,
  prodTradeBySignal:`select p.id, p.state, p.realized_pnl_usdt from public.v11_long_regime_positions p where p.signal_id::text = $1::text order by p.entry_at limit 1`,
  prodTradeBySymbol:`select p.id, p.state, p.realized_pnl_usdt from public.v11_long_regime_positions p
    where p.symbol = $1::text and p.entry_at between $2::timestamptz and $3::timestamptz order by p.entry_at limit 1`,
  prodReviewedWindow:`select exists (select 1 from public.gpt_final_entry_reviews r where r.purpose = 'PRODUCTION' and r.symbol = $1::text
    and r.created_at between $2::timestamptz and $3::timestamptz) as seen`,
  insertV2Outcomes:`insert into shadow_le.v2_outcomes(${list(V2_OUTCOME_COLS)}) select ${pick(V2_OUTCOME_COLS)} from jsonb_populate_recordset(null::shadow_le.v2_outcomes, $1::text::jsonb) r
    on conflict do nothing returning outcome_id`,
  v2BudgetReserve:`select shadow_le.v2_budget_reserve($1::text, $2::numeric, $3::text) as r`,
  v2BudgetSettle:`select shadow_le.v2_budget_settle($1::bigint, $2::numeric) as r`,
  v2BudgetState:`select shadow_le.v2_budget_state($1::text) as r`,
  insertV2Cycle:`insert into shadow_le.cycles(${list(CYCLE_COLS)}) select ${pick(CYCLE_COLS)} from jsonb_populate_record(null::shadow_le.cycles, $1::text::jsonb) r returning cycle_id`,
});

const toParam=v=>v===null||v===undefined?null:typeof v==='object'?JSON.stringify(v):String(v);
export function makeStoreV2(db){
  const q=(name,params=[])=>db.query(SQL_V2[name],params.map(toParam));
  const one=async(name,params)=>(await q(name,params))[0]??null;
  return {
    controlV2:()=>one('controlV2'),
    cecState:()=>one('cecState'),
    prodScanLatest:()=>one('prodScanLatest'),
    prodEntryPending:(since,limit)=>q('prodEntryPending',[since,limit]),
    rankCycles:(from,to)=>q('rankCycles',[from,to]),
    cyclesAfterV2:at=>q('cyclesAfterV2',[at]),
    insertEvent:async row=>(await one('insertEvent',[{...row,hard_safety:row.hard_safety??[]}]))?.event_id??null,
    // jsonb_populate_recordset turns an absent key into an explicit NULL, which bypasses column defaults
    insertV2Decisions:rows=>rows.length?q('insertV2Decisions',[rows.map(r=>({...r,reasons:r.reasons??[],support:r.support??[]}))]):[],
    v2OpenWaits:()=>q('v2OpenWaits'),
    claimV2WaitEvent:async row=>(await one('claimV2WaitEvent',[row]))?.wait_event_id??null,
    v2OutcomeDue:(before,limit)=>q('v2OutcomeDue',[before,limit]),
    prodTradeBySignal:id=>one('prodTradeBySignal',[id]),
    prodTradeBySymbol:(s,from,to)=>one('prodTradeBySymbol',[s,from,to]),
    prodReviewedWindow:async(s,from,to)=>(await one('prodReviewedWindow',[s,from,to]))?.seen===true,
    insertV2Outcomes:rows=>rows.length?q('insertV2Outcomes',[rows]):[],
    v2BudgetReserve:async(lane,usd,purpose)=>(await one('v2BudgetReserve',[lane,usd,purpose]))?.r??null,
    v2BudgetSettle:async(id,usd)=>(await one('v2BudgetSettle',[id,usd]))?.r??null,
    v2BudgetState:async lane=>(await one('v2BudgetState',[lane]))?.r??null,
    insertV2Cycle:cycle=>one('insertV2Cycle',[cycle]),
  };
}
