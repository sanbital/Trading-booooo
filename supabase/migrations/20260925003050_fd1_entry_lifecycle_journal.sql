-- FD1 opportunity refinement (2026-09-25): missed-opportunity journal accounting.
-- Research/evidence objects only. Trading code never reads the journal, and no signal,
-- order, position or review row is modified here.
--
--  1. terminal_class: every candidate ends in exactly one class, derived from its existing
--     reason by public.entry_terminal_class(), the mirror of TERMINAL_RULES in
--     supabase/functions/v10-lane-executor/entry-lifecycle.mjs (a parity test pins them).
--  2. The initial GPT decision is the first ENTRY review. HOLD/EXIT reviews of the position
--     the entry opened live in the same table and were being read as the entry decision.
--  3. A V17_CHASE_EXPIRED row is measured from the chase bar close -- the price a chase entry
--     would have paid -- at that bar's close, not from the signal reference at the 5m bar.
--     Rows whose anchor changes are re-tracked; the previous anchor and its outcome are kept
--     in legacy_anchor.
--  4. A GPT BUY with no order attempt that later expired as V17_SETUP_EXPIRED is labelled
--     GPT_BUY_NOT_EXECUTED:<reason> (class STALE) instead of looking like a V17 rejection.
--  5. Per-attempt IOC evidence (offset, quote age, reachable depth, latency, executed qty,
--     retry plan) is carried into execution_attempts.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

alter table public.missed_opportunity_journal
  add column if not exists terminal_class text,
  add column if not exists entry_path text,
  add column if not exists chase_state text,
  add column if not exists anchor_basis text,
  add column if not exists gpt_abstain_reason text,
  add column if not exists gpt_expected_value_bias text,
  add column if not exists legacy_anchor jsonb;
create index if not exists missed_opportunity_class_idx on public.missed_opportunity_journal(terminal_class);

create or replace function public.entry_terminal_class(p_reason text,p_filled boolean default false,p_partial boolean default false)
returns text language sql immutable set search_path=pg_catalog as $$
  select case
    when coalesce(p_filled,false) then case when coalesce(p_partial,false) then 'PARTIAL_FILLED' else 'FILLED' end
    when coalesce(p_reason,'')='' then 'STALE'
    when p_reason ~ '^PARTIAL_FILL' then 'PARTIAL_FILLED'
    when p_reason ~ '^(IOC_NO_FILL|IOC_RETRY_EXHAUSTED)' then 'IOC_NO_FILL'
    when p_reason ~ '^(SLOT_UNAVAILABLE|V11_SLOT_FULL|DUPLICATE_SYMBOL_OPEN|PORTFOLIO_CHANGED|V17_SETUP_POLICY_SLOT_LIMIT|ENTRY_MARGIN_INSUFFICIENT|EXECUTION_SAFETY_REJECT:INSUFFICIENT_MARGIN|MAX_SLOTS_REACHED|INSUFFICIENT_MARGIN|PENDING_CAPITAL_RESERVED)' then 'SLOT_UNAVAILABLE'
    when p_reason ~ '^(GPT_REJECTED|GPT_SKIP|GPT_ABSTAIN|GPT_TIMEOUT|GPT_FINAL_RECHECK_(SKIP|ABSTAIN)|GPT_NO_VALID_API_RESPONSE)' then 'GPT_REJECTED'
    when p_reason ~ '^(V17_SETUP_EXPIRED|V17_CHASE_EXPIRED|V30_FRONT_REJECT|B06133_TRIGGER_REQUIRED|B06133_MARKET_UNAVAILABLE|V17_SETUP_INVALID|V17_SETUP_NOT_TRIGGERED|WRONG_STRATEGY)' then 'STRATEGY_REJECTED'
    when p_reason ~ '^(STALE|GPT_BUY_NOT_EXECUTED|GPT_REVIEW_EXPIRED|GPT_STALE_OR_FUTURE_REVIEW|GPT_REVIEW_PENDING|GPT_TRIGGER_EXPIRED|V17_TRIGGER_STALE|V17_TRIGGER_FUTURE|E1_DISPATCH_QUOTE_AGED|ENTRY_ATTEMPTS_EXHAUSTED|ENTRY_RUN_BUDGET_EXHAUSTED|V17_SETUP_BUDGET_EXHAUSTED|SIGNAL_STALE_OR_FUTURE|ENTRY_PER_RUN_LIMIT|IOC_RETRY_AUTHORITY|SUPERSEDED_BY_FRESHER_SIGNAL|EXECUTION_SAFETY_REJECT:(CYCLE_BUDGET_RESERVE|ENTRY_RUN_BUDGET_EXHAUSTED))' then 'STALE'
    when p_reason ~ '^(ERROR|ACCOUNT_SAFETY_BLOCK|GPT_REVIEW_STORAGE|GPT_CONTROL_UNREADABLE|GPT_REVIEW_NOT_|GPT_NOT_ENFORCING|GPT_API_BUDGET|GPT_BINDING_MISMATCH|GPT_SNAPSHOT_|V17_CONTROLS_UNAVAILABLE|V17_RUNTIME_BLOCKED|V17_ENTRY_KILL_SWITCH|V17_OPERATOR_CUTOVER|V17_MARGIN_CONFIG|SIZING_CONTRACT_STALE|B06133_SELECTION_INVALID|V30_SELECTION_INVALID|CEC0040_(SELECTION|INPUT)_INVALID|CEC0040_DECISION|CEC0040_WRITE|B06133_WRITE|SETUP_WRITE|CLAIM:|ORDER_INTENT|ENTRY_AVAILABLE_BALANCE_UNREADABLE|.*_WRITE$)' then 'ERROR'
    else 'EXECUTION_REJECTED'
  end
$$;
revoke all on function public.entry_terminal_class(text,boolean,boolean) from public,anon,authenticated;

create or replace function public.missed_opportunity_sync(p_limit integer default 2000)
returns integer
language plpgsql security definer
set search_path='public','extensions'
as $function$
declare n integer;
begin
  with sig as (
    select s.*
    from public.v11_long_regime_signals s
    where s.created_at >= now()-interval '30 days'
    order by s.updated_at desc
    limit greatest(1,least(p_limit,10000))
  ), enriched as (
    select s.*,
      g.decision as initial_decision,g.completed_at as initial_completed,g.snapshot_at as initial_snapshot,g.record as initial_record,
      rc.pre_dispatch_snapshot,rc.recheck_triggered,rc.recheck_reasons,rc.deltas,
      rc.final_gpt_decision,rc.final_gpt_at,rc.final_error,
      o.attempts,o.attempt_count,o.last_reject_reason,o.had_partial,o.last_attempt_no,
      p.id as pid,p.original_quantity,p.entry_price,p.realized_pnl_usdt,p.state as position_state,
      s.features->'v17Setup' as setup,
      -- A chase is measured where a chase entry would have bought: the chase bar's close.
      (s.features->'v17Setup'->>'state')='CHASE_EXPIRED'
        and nullif(s.features->'v17Setup'->>'lastClose','') is not null
        and nullif(s.features->'v17Setup'->>'lastCandleOpenTime','') is not null as chase_anchor
    from sig s
    left join lateral (
      -- The entry decision is the first ENTRY review; HOLD/EXIT reviews of the position are not it.
      select r.decision,r.completed_at,r.snapshot_at,r.record
      from public.gpt_final_entry_reviews r
      where r.signal_id=s.id::text and r.purpose='PRODUCTION'
        and coalesce(r.record->>'kind','') <> 'FD1_FINAL_RECHECK'
        and coalesce(r.record->'packet'->>'task','ENTRY')='ENTRY'
      order by r.created_at asc,r.completed_at asc nulls last limit 1
    ) g on true
    left join lateral (
      select x.pre_dispatch_snapshot,x.recheck_triggered,x.recheck_reasons,x.deltas,
             x.final_gpt_decision,x.final_gpt_at,x.final_error
      from public.fd1_final_recheck_log x
      where x.signal_id=s.id::text
      order by x.recheck_sequence desc,x.created_at desc limit 1
    ) rc on true
    left join lateral (
      select
        jsonb_agg(jsonb_build_object(
          'attempt',coalesce(nullif(q.request_payload->>'entry_ioc_attempt','')::integer,1),
          'at',q.created_at,
          'client_order_id',q.client_order_id,
          'exchange_order_id',q.exchange_order_id,
          'requested_quantity',q.requested_quantity,
          'limit_price',nullif(q.request_payload->'order'->>'price','')::numeric,
          'spread_bps',nullif(q.request_payload->>'spread_bps','')::numeric,
          'offset_bps',coalesce(nullif(q.request_payload->'ioc_attempt_evidence'->>'offsetBps','')::numeric,
            nullif(q.request_payload->>'ioc_bps','')::numeric),
          'quote_age_ms',coalesce(nullif(q.request_payload->'ioc_attempt_evidence'->>'quoteAgeMs','')::numeric,
            nullif(q.request_payload->'e1'->>'dispatchQuoteAgeAtIntentMs','')::numeric),
          'executable_qty_at_limit',nullif(q.request_payload->'ioc_attempt_evidence'->>'executableQtyAtLimit','')::numeric,
          'best_ask',nullif(q.request_payload->'ioc_attempt_evidence'->>'bestAsk','')::numeric,
          'ask_change_bps_since_first',nullif(q.request_payload->'ioc_attempt_evidence'->>'askChangeBpsSinceFirst','')::numeric,
          'since_first_attempt_ms',nullif(q.request_payload->'ioc_attempt_evidence'->>'sinceFirstAttemptMs','')::numeric,
          'retry_uplift_bps',nullif(q.request_payload->'ioc_attempt_evidence'->'retryPlan'->>'upliftBps','')::numeric,
          'retry_budget_shrunk',(q.request_payload->'ioc_attempt_evidence'->'retryPlan'->>'budgetShrunk')::boolean,
          'latency_ms',nullif(q.response_payload->'v22EntryFinality'->>'latencyMs','')::numeric,
          'executed_quantity',coalesce(nullif(q.response_payload->'order'->>'executed_volume','')::numeric,
            nullif(q.response_payload->'order'->>'executedQty','')::numeric,
            nullif(q.response_payload->'order'->'raw'->>'executedQty','')::numeric),
          'exchange_status',coalesce(q.response_payload->'order'->>'status',q.response_payload->'order'->'raw'->>'status'),
          'expected_vwap',nullif(q.request_payload->>'expected_entry_vwap','')::numeric,
          'expected_slippage_bps',nullif(q.request_payload->>'expected_slippage_bps','')::numeric,
          'state',q.state,
          'reject_reason',q.reject_reason
        ) order by q.created_at) as attempts,
        count(*)::integer attempt_count,
        (array_agg(q.reject_reason order by q.created_at desc))[1] as last_reject_reason,
        bool_or(
          coalesce(nullif(q.response_payload->'order'->>'executed_volume','')::numeric,
                   nullif(q.response_payload->'order'->>'executedQty','')::numeric,
                   nullif(q.response_payload->'order'->'raw'->>'executedQty','')::numeric,0) > 0
          and coalesce(nullif(q.response_payload->'order'->>'executed_volume','')::numeric,
                       nullif(q.response_payload->'order'->>'executedQty','')::numeric,
                       nullif(q.response_payload->'order'->'raw'->>'executedQty','')::numeric,0) < q.requested_quantity
        ) as had_partial,
        max(coalesce(nullif(q.request_payload->>'entry_ioc_attempt','')::integer,1)) as last_attempt_no
      from public.v11_long_regime_orders q
      where q.signal_id=s.id and q.intent='OPEN_LONG'
    ) o on true
    left join lateral (
      select z.id,z.original_quantity,z.entry_price,z.realized_pnl_usdt,z.state
      from public.v11_long_regime_positions z where z.signal_id=s.id
      order by z.entry_at desc limit 1
    ) p on true
  ), labelled as (
    select e.*,
      case
        when pid is not null and had_partial is true and coalesce(last_attempt_no,1)>=2 and coalesce(last_reject_reason,'') like 'IOC_NO_FILL:%'
          then 'PARTIAL_FILL_ABORT:IOC_RETRY_EXHAUSTED'
        when pid is not null and had_partial is true and coalesce(attempt_count,0)=1
          then 'PARTIAL_FILL_ABORT'
        when pid is null and final_gpt_decision='SKIP' then 'GPT_FINAL_RECHECK_SKIP'
        when pid is null and final_gpt_decision='ABSTAIN' then
          case when coalesce(final_error,'') in ('API_TIMEOUT','RC_EXPIRED','RC_TRIGGER_EXPIRED') then 'GPT_FINAL_RECHECK_ABSTAIN:'||final_error
               else 'GPT_FINAL_RECHECK_ABSTAIN' end
        when pid is null and initial_decision='SKIP' then
          case when coalesce(reject_reason,'') like 'GPT_SKIP%' then reject_reason else 'GPT_SKIP' end
        when pid is null and initial_decision='ABSTAIN' then
          case when coalesce(initial_record->'result'->>'error','')='API_TIMEOUT' then 'GPT_TIMEOUT'
               when coalesce(reject_reason,'') like 'GPT_ABSTAIN%' then reject_reason else 'GPT_ABSTAIN' end
        when pid is null and coalesce(last_attempt_no,1)>=2 and coalesce(last_reject_reason,'') like 'IOC_NO_FILL:%' then 'IOC_RETRY_EXHAUSTED'
        when pid is null and coalesce(last_reject_reason,'') like 'IOC_NO_FILL:%' then 'IOC_NO_FILL'
        -- A GPT BUY that never reached an order and later expired with the setup was a BUY
        -- orphan, not a V17 rejection.
        when pid is null and initial_decision='BUY' and coalesce(attempt_count,0)=0 and final_gpt_decision is null
          and coalesce(reject_reason,'') like 'V17_SETUP_EXPIRED%' then 'GPT_BUY_NOT_EXECUTED:'||reject_reason
        else reject_reason
      end as final_reason
    from enriched e
  )
  insert into public.missed_opportunity_journal(
    signal_id,symbol,candidate_at,reference_price,target_margin_usdt,leverage,target_notional_usdt,stop_pct,
    v17_result,v30_result,b06133_result,cec_result,
    initial_gpt_decision,initial_gpt_at,initial_gpt_snapshot_at,initial_gpt_record,
    pre_dispatch_snapshot,change_detector_result,final_gpt_decision,final_gpt_at,final_gpt_error,
    execution_attempts,execution_attempt_count,fill_quantity,fill_price,position_id,signal_status,reject_reason,
    realized_net_usdt,terminal_class,entry_path,chase_state,anchor_basis,gpt_abstain_reason,gpt_expected_value_bias,
    synced_at,updated_at)
  select id,symbol,
    case when chase_anchor then to_timestamp(((setup->>'lastCandleOpenTime')::bigint+60000)/1000.0)
      else coalesce(to_timestamp(nullif(setup->>'triggerAt','')::double precision/1000.0),entry_bar_at,created_at) end,
    case when chase_anchor then (setup->>'lastClose')::numeric
      else coalesce(nullif(setup->>'triggerClose','')::numeric,nullif(features->>'referenceClose','')::numeric) end,
    nullif(features->>'targetMarginUsdt','')::numeric,nullif(features->>'leverage','')::numeric,
    nullif(features->>'targetMarginUsdt','')::numeric*nullif(features->>'leverage','')::numeric,
    nullif(features->'exitPolicy'->>'stopPct','')::numeric,
    setup,features->'v30Front',features->'b06133',features->'cec0040',
    initial_decision,initial_completed,initial_snapshot,initial_record,
    pre_dispatch_snapshot,
    case when pre_dispatch_snapshot is null then null else jsonb_build_object(
      'triggered',recheck_triggered,'reasons',coalesce(to_jsonb(recheck_reasons),'[]'::jsonb),'deltas',deltas) end,
    final_gpt_decision,final_gpt_at,final_error,
    coalesce(attempts,'[]'::jsonb),coalesce(attempt_count,0),original_quantity,entry_price,pid,status,final_reason,
    case when position_state='CLOSED' then realized_pnl_usdt else null end,
    -- An open candidate (NEW/CLAIMED/ORDERED, no reason yet) has no terminal class.
    case when pid is null and final_reason is null and status in ('NEW','CLAIMED','ORDERED') then null
      else public.entry_terminal_class(final_reason,pid is not null,had_partial is true) end,
    coalesce(setup->>'triggerMode',case when nullif(setup->>'triggerAt','') is not null then 'PULLBACK_REACCEL' end),
    setup->'chase'->>'state',
    case when chase_anchor then 'CHASE_CLOSE' when nullif(setup->>'triggerClose','') is not null then 'TRIGGER_CLOSE' else 'SIGNAL_REFERENCE' end,
    initial_record->'result'->'answer'->>'abstain_reason',
    initial_record->'result'->'answer'->>'expected_value_bias',
    now(),now()
  from labelled
  on conflict(signal_id) do update set
    symbol=excluded.symbol,candidate_at=excluded.candidate_at,reference_price=excluded.reference_price,
    target_margin_usdt=excluded.target_margin_usdt,leverage=excluded.leverage,target_notional_usdt=excluded.target_notional_usdt,
    stop_pct=excluded.stop_pct,v17_result=excluded.v17_result,v30_result=excluded.v30_result,
    b06133_result=excluded.b06133_result,cec_result=excluded.cec_result,
    initial_gpt_decision=excluded.initial_gpt_decision,initial_gpt_at=excluded.initial_gpt_at,
    initial_gpt_snapshot_at=excluded.initial_gpt_snapshot_at,initial_gpt_record=excluded.initial_gpt_record,
    pre_dispatch_snapshot=excluded.pre_dispatch_snapshot,change_detector_result=excluded.change_detector_result,
    final_gpt_decision=excluded.final_gpt_decision,final_gpt_at=excluded.final_gpt_at,final_gpt_error=excluded.final_gpt_error,
    execution_attempts=excluded.execution_attempts,execution_attempt_count=excluded.execution_attempt_count,
    fill_quantity=excluded.fill_quantity,fill_price=excluded.fill_price,position_id=excluded.position_id,
    signal_status=excluded.signal_status,reject_reason=excluded.reject_reason,
    realized_net_usdt=coalesce(excluded.realized_net_usdt,public.missed_opportunity_journal.realized_net_usdt),
    terminal_class=excluded.terminal_class,entry_path=excluded.entry_path,chase_state=excluded.chase_state,
    anchor_basis=excluded.anchor_basis,gpt_abstain_reason=excluded.gpt_abstain_reason,
    gpt_expected_value_bias=excluded.gpt_expected_value_bias,
    synced_at=excluded.synced_at,updated_at=now();
  get diagnostics n=row_count;
  return n;
end $function$;
revoke all on function public.missed_opportunity_sync(integer) from public,anon,authenticated;

-- A changed anchor invalidates the tracked outcome: keep the old one, clear it, re-track.
create or replace function public.missed_opportunity_reanchor()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if (new.reference_price is distinct from old.reference_price or new.candidate_at is distinct from old.candidate_at)
    and (old.outcome_tracked_at is not null or old.reconstructed_net_5m is not null) then
    new.legacy_anchor:=coalesce(old.legacy_anchor,jsonb_build_object('reference_price',old.reference_price,
      'candidate_at',old.candidate_at,'reconstructed_net_30m',old.reconstructed_net_30m,
      'reconstructed_net_usdt',old.reconstructed_net_usdt,'mfe_60',old.mfe_60,'mae_60',old.mae_60,'reanchored_at',now()));
    new.high_5m:=null;new.low_5m:=null;new.close_5m:=null;new.high_15m:=null;new.low_15m:=null;new.close_15m:=null;
    new.high_30m:=null;new.low_30m:=null;new.close_30m:=null;new.high_60m:=null;new.low_60m:=null;new.close_60m:=null;
    new.mfe_5:=null;new.mae_5:=null;new.mfe_15:=null;new.mae_15:=null;new.mfe_30:=null;new.mae_30:=null;new.mfe_60:=null;new.mae_60:=null;
    new.reconstructed_net_5m:=null;new.reconstructed_net_15m:=null;new.reconstructed_net_30m:=null;new.reconstructed_net_usdt:=null;
    new.outcome_tracked_at:=null;new.next_track_at:=null;new.tracking_error:=null;new.track_attempts:=0;
  end if;
  return new;
end $$;
revoke all on function public.missed_opportunity_reanchor() from public,anon,authenticated;
drop trigger if exists missed_opportunity_reanchor on public.missed_opportunity_journal;
create trigger missed_opportunity_reanchor before update of reference_price,candidate_at on public.missed_opportunity_journal
  for each row execute function public.missed_opportunity_reanchor();

create or replace view public.missed_opportunity_by_reason with (security_invoker=true) as
select
  case
    when reject_reason like 'GPT_BUY_NOT_EXECUTED%' then 'GPT_BUY_NOT_EXECUTED'
    when reject_reason like 'V17_SETUP_EXPIRED%' then 'V17_SETUP_EXPIRED'
    when reject_reason like 'V17_CHASE_EXPIRED:DEAD%' then 'V17_CHASE_EXPIRED:DEAD'
    when reject_reason like 'V17_CHASE_EXPIRED%' then 'V17_CHASE_EXPIRED'
    when reject_reason like 'V17_ENTRY_DRIFT%' then 'V17_ENTRY_DRIFT'
    when reject_reason like 'V30_FRONT_REJECT:fresh5over15+volumeTails%' or reject_reason like 'V30_FRONT_REJECT:volumeTails+fresh5over15%'
      then 'V30_FRONT_REJECT:fresh5over15+volumeTails'
    when reject_reason like 'V30_FRONT_REJECT:fresh5over15%' then 'V30_FRONT_REJECT:fresh5over15'
    when reject_reason like 'V30_FRONT_REJECT:volumeTails%' then 'V30_FRONT_REJECT:volumeTails'
    when reject_reason like 'GPT_FINAL_RECHECK_SKIP%' then 'GPT_FINAL_RECHECK_SKIP'
    when reject_reason like 'GPT_FINAL_RECHECK_ABSTAIN%' then 'GPT_FINAL_RECHECK_ABSTAIN'
    when reject_reason like 'GPT_SKIP%' then 'GPT_SKIP'
    when reject_reason like 'GPT_TIMEOUT%' then 'GPT_TIMEOUT'
    when reject_reason like 'GPT_ABSTAIN%' then 'GPT_ABSTAIN'
    when reject_reason like 'IOC_RETRY_EXHAUSTED%' then 'IOC_RETRY_EXHAUSTED'
    when reject_reason like 'IOC_NO_FILL%' then 'IOC_NO_FILL'
    when reject_reason like 'PARTIAL_FILL_ABORT%' then 'PARTIAL_FILL_ABORT'
    when reject_reason like 'EXECUTION_SAFETY_REJECT%' then 'EXECUTION_SAFETY_REJECT'
    when reject_reason like 'SLOT_UNAVAILABLE%' then 'SLOT_UNAVAILABLE'
    when reject_reason like 'STALE%' then 'STALE'
    when reject_reason like 'EXECUTION_REJECTED%' then 'EXECUTION_REJECTED'
    else coalesce(reject_reason,'FILLED_OR_OPEN')
  end as reason,
  count(*) as sample_count,
  count(*) filter(where outcome_tracked_at is not null) as tracked_count,
  round(avg(mfe_5)*100,3) avg_mfe_5_pct,round(avg(mae_5)*100,3) avg_mae_5_pct,
  round(avg(mfe_15)*100,3) avg_mfe_15_pct,round(avg(mae_15)*100,3) avg_mae_15_pct,
  round(avg(mfe_30)*100,3) avg_mfe_30_pct,round(avg(mae_30)*100,3) avg_mae_30_pct,
  round(avg(mfe_60)*100,3) avg_mfe_60_pct,round(avg(mae_60)*100,3) avg_mae_60_pct,
  round(sum(greatest(reconstructed_net_usdt,0)) filter(where position_id is null),2) as missed_upside_usdt,
  round(sum(greatest(-reconstructed_net_usdt,0)) filter(where position_id is null),2) as avoided_loss_usdt,
  round(sum(realized_net_usdt),2) as realized_net_usdt
from public.missed_opportunity_journal
group by 1;

-- One row per terminal class and entry path: the lifecycle completeness view.
create or replace view public.missed_opportunity_by_class with (security_invoker=true) as
select coalesce(terminal_class,'OPEN') as terminal_class,coalesce(entry_path,'NONE') as entry_path,
  coalesce(chase_state,'-') as chase_state,initial_gpt_decision,
  count(*) as sample_count,
  count(*) filter(where outcome_tracked_at is not null) as tracked_count,
  count(*) filter(where initial_gpt_decision='BUY' and execution_attempt_count=0 and position_id is null) as gpt_buy_without_attempt,
  round(avg(reconstructed_net_30m/nullif(target_notional_usdt,0))*100,3) as avg_net_30m_pct,
  round(avg(reconstructed_net_usdt/nullif(target_notional_usdt,0))*100,3) as avg_net_60m_pct,
  round(sum(realized_net_usdt),2) as realized_net_usdt
from public.missed_opportunity_journal
group by 1,2,3,4;
revoke all on public.missed_opportunity_by_class from anon,authenticated;

select public.missed_opportunity_sync(10000);
commit;
