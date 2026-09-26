-- R181 follow-up (2026-09-26) -- UNAPPLIED. Requires operator approval before it touches production.
--
-- WHAT: public.missed_opportunity_sync() labelled every non-timeout initial ABSTAIN as 'GPT_ABSTAIN',
-- including provider failures (HTTP_429 quota, 2026-09-25 12:09 .. 2026-09-26 08:18) and local
-- contract refusals. Those are not GPT judgments about the market. This replaces ONLY that CASE
-- branch: a non-valid ABSTAIN is labelled GPT_NO_VALID_API_RESPONSE:<decision_source>:<error>, the
-- same string the v10-lane-executor now writes (entry-lifecycle.mjs). terminal_class is unchanged
-- (GPT_REJECTED: the GPT gate did not pass). Nothing else in the function changes; the body is the
-- applied 20260925003050 definition, which matches the live pg_get_functiondef of 2026-09-26.
--
-- EFFECT ON EXISTING ROWS: missed_opportunity_journal is a derived table that this function re-syncs
-- (last 30 days) on every run, so derived reject_reason for provider-failure rows will change on the
-- next sync. Source ledgers (v11_long_regime_signals, gpt_final_entry_reviews) are not touched.
--
-- APPLY (one transaction):  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f <this file>
-- ROLLBACK: re-apply the function definition from 20260925003050_fd1_entry_lifecycle_journal.sql.
create or replace function public.gpt_decision_source(p_result jsonb)
returns text language sql immutable set search_path=pg_catalog as $$
  select case
    when coalesce((p_result->>'valid')::boolean,false) and coalesce(p_result->>'origin','OPENAI_API')='OPENAI_API' then 'GPT_VALID'
    when p_result->>'error'='API_TIMEOUT' then 'TIMEOUT'
    when p_result->>'origin'='LOCAL_DATA_ERROR'
      or p_result->>'error' in ('REVIEW_PREPARATION_FAILED','COUNTER_PREPARATION_FAILED','HISTORY_INVALID') then 'SYSTEM_ABORT'
    when p_result->>'error' ~ '^HTTP_[0-9]+$'
      or p_result->>'error' in ('FD_API_KEY_MISSING','FD_API_OR_VALIDATION_ERROR','FD_API_INCOMPLETE','FD_MODEL_MISMATCH') then 'PROVIDER_ERROR'
    when p_result->>'error' in ('FD_RESPONSE_NOT_JSON','FD_RESPONSE_TOO_LARGE','FD_API_OUTPUT_COUNT','FD_UNEXPECTED_TOOL')
      or p_result->>'error' ~ '^(TYPE|ENUM|STRING|REQUIRED|EXTRA|ARRAY):' then 'PARSE_ERROR'
    else 'SAFETY_FALLBACK'
  end
$$;
revoke all on function public.gpt_decision_source(jsonb) from public,anon,authenticated;

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
               -- R181: an ABSTAIN that is not a valid GPT answer is a failure, never a GPT judgment.
               when coalesce((initial_record->'result'->>'valid')::boolean,false) is false then
                 case when coalesce(reject_reason,'') like 'GPT_NO_VALID_API_RESPONSE:%' then reject_reason
                      else 'GPT_NO_VALID_API_RESPONSE:'||public.gpt_decision_source(initial_record->'result')
                        ||coalesce(':'||left(initial_record->'result'->>'error',60),'') end
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
