-- FD1 execution retry + missed-opportunity evidence.
-- Observational objects only. Trading code never reads this journal.
alter table public.fd1_final_recheck_log
  add column if not exists recheck_sequence integer not null default 1;
create index if not exists fd1_final_recheck_log_signal_sequence_idx
  on public.fd1_final_recheck_log(signal_id,recheck_sequence,created_at desc);

create table if not exists public.missed_opportunity_journal (
  signal_id uuid primary key references public.v11_long_regime_signals(id) on delete cascade,
  symbol text not null,
  candidate_at timestamptz not null,
  reference_price numeric,
  target_margin_usdt numeric,
  leverage numeric,
  target_notional_usdt numeric,
  stop_pct numeric,
  v17_result jsonb,
  v30_result jsonb,
  b06133_result jsonb,
  cec_result jsonb,
  initial_gpt_decision text,
  initial_gpt_at timestamptz,
  initial_gpt_snapshot_at timestamptz,
  initial_gpt_record jsonb,
  pre_dispatch_snapshot jsonb,
  change_detector_result jsonb,
  final_gpt_decision text,
  final_gpt_at timestamptz,
  final_gpt_error text,
  execution_attempts jsonb not null default '[]'::jsonb,
  execution_attempt_count integer not null default 0,
  fill_quantity numeric,
  fill_price numeric,
  position_id uuid,
  signal_status text,
  reject_reason text,
  high_5m numeric, low_5m numeric, close_5m numeric,
  high_15m numeric, low_15m numeric, close_15m numeric,
  high_30m numeric, low_30m numeric, close_30m numeric,
  high_60m numeric, low_60m numeric, close_60m numeric,
  mfe_5 numeric, mae_5 numeric,
  mfe_15 numeric, mae_15 numeric,
  mfe_30 numeric, mae_30 numeric,
  mfe_60 numeric, mae_60 numeric,
  reconstructed_net_usdt numeric,
  realized_net_usdt numeric,
  outcome_tracked_at timestamptz,
  track_attempts integer not null default 0,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.missed_opportunity_journal enable row level security;
create index if not exists missed_opportunity_reason_idx on public.missed_opportunity_journal(reject_reason);
create index if not exists missed_opportunity_untracked_idx on public.missed_opportunity_journal(candidate_at)
  where outcome_tracked_at is null;

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
      p.id as pid,p.original_quantity,p.entry_price,p.realized_pnl_usdt,p.state as position_state
    from sig s
    left join lateral (
      select r.decision,r.completed_at,r.snapshot_at,r.record
      from public.gpt_final_entry_reviews r
      where r.signal_id=s.id::text and r.purpose='PRODUCTION'
        and coalesce(r.record->>'kind','') <> 'FD1_FINAL_RECHECK'
      order by r.completed_at desc nulls last,r.created_at desc limit 1
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
  )
  insert into public.missed_opportunity_journal(
    signal_id,symbol,candidate_at,reference_price,target_margin_usdt,leverage,target_notional_usdt,stop_pct,
    v17_result,v30_result,b06133_result,cec_result,
    initial_gpt_decision,initial_gpt_at,initial_gpt_snapshot_at,initial_gpt_record,
    pre_dispatch_snapshot,change_detector_result,final_gpt_decision,final_gpt_at,final_gpt_error,
    execution_attempts,execution_attempt_count,fill_quantity,fill_price,position_id,signal_status,reject_reason,
    realized_net_usdt,synced_at,updated_at)
  select id,symbol,
    coalesce(to_timestamp(nullif(features->'v17Setup'->>'triggerAt','')::double precision/1000.0),entry_bar_at,created_at),
    coalesce(nullif(features->'v17Setup'->>'triggerClose','')::numeric,nullif(features->>'referenceClose','')::numeric),
    nullif(features->>'targetMarginUsdt','')::numeric,nullif(features->>'leverage','')::numeric,
    nullif(features->>'targetMarginUsdt','')::numeric*nullif(features->>'leverage','')::numeric,
    nullif(features->'exitPolicy'->>'stopPct','')::numeric,
    features->'v17Setup',features->'v30Front',features->'b06133',features->'cec0040',
    initial_decision,initial_completed,initial_snapshot,initial_record,
    pre_dispatch_snapshot,
    case when pre_dispatch_snapshot is null then null else jsonb_build_object(
      'triggered',recheck_triggered,'reasons',coalesce(to_jsonb(recheck_reasons),'[]'::jsonb),'deltas',deltas) end,
    final_gpt_decision,final_gpt_at,final_error,
    coalesce(attempts,'[]'::jsonb),coalesce(attempt_count,0),original_quantity,entry_price,pid,status,
    case
      when pid is not null and had_partial is true and coalesce(last_attempt_no,1)>=2 and coalesce(last_reject_reason,'') like 'IOC_NO_FILL:%'
        then 'PARTIAL_FILL_ABORT:IOC_RETRY_EXHAUSTED'
      when pid is not null and had_partial is true and coalesce(attempt_count,0)=1
        then 'PARTIAL_FILL_ABORT'
      when pid is null and final_gpt_decision='SKIP' then 'GPT_FINAL_RECHECK_SKIP'
      when pid is null and final_gpt_decision='ABSTAIN' then
        case when coalesce(final_error,'') in ('API_TIMEOUT','RC_EXPIRED','RC_TRIGGER_EXPIRED') then 'GPT_FINAL_RECHECK_ABSTAIN:'||final_error
             else 'GPT_FINAL_RECHECK_ABSTAIN' end
      when pid is null and initial_decision='SKIP' then 'GPT_SKIP'
      when pid is null and initial_decision='ABSTAIN' then
        case when coalesce(initial_record->'result'->>'error','')='API_TIMEOUT' then 'GPT_TIMEOUT' else 'GPT_ABSTAIN' end
      when pid is null and coalesce(last_attempt_no,1)>=2 and coalesce(last_reject_reason,'') like 'IOC_NO_FILL:%' then 'IOC_RETRY_EXHAUSTED'
      when pid is null and coalesce(last_reject_reason,'') like 'IOC_NO_FILL:%' then 'IOC_NO_FILL'
      else reject_reason
    end,
    case when position_state='CLOSED' then realized_pnl_usdt else null end,now(),now()
  from enriched
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
    synced_at=excluded.synced_at,updated_at=now();
  get diagnostics n=row_count;
  return n;
end $function$;
revoke all on function public.missed_opportunity_sync(integer) from public,anon,authenticated;

create or replace function public.missed_opportunity_track(p_limit integer default 20)
returns integer
language plpgsql security definer
set search_path='public','extensions'
as $function$
declare r record;k jsonb;st integer;t0 bigint;e numeric;n integer:=0;
        notional numeric;stop numeric;fee numeric;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','4000');
  perform public.missed_opportunity_sync(3000);
  for r in
    select * from public.missed_opportunity_journal
    where outcome_tracked_at is null and track_attempts<8
      and candidate_at < now()-interval '62 minutes' and reference_price>0
    order by candidate_at limit greatest(1,least(p_limit,50))
  loop
    e:=r.reference_price;notional:=coalesce(nullif(r.target_notional_usdt,0),450);
    stop:=coalesce(nullif(r.stop_pct,0),0.025);fee:=notional*0.001;
    t0:=(floor(extract(epoch from r.candidate_at)*1000/60000)*60000)::bigint;
    begin
      select status,case when status=200 then content::jsonb end into st,k
      from http_get('https://fapi.binance.com/fapi/v1/klines?symbol='||r.symbol||
        '&interval=1m&startTime='||t0||'&limit=61');
    exception when others then st:=null;k:=null;end;
    if st is distinct from 200 or k is null or jsonb_array_length(k)<60 then
      update public.missed_opportunity_journal set track_attempts=track_attempts+1,updated_at=now() where signal_id=r.signal_id;
      continue;
    end if;
    with b as (
      select (o.ord-1)::int i,(x->>2)::numeric h,(x->>3)::numeric l,(x->>4)::numeric c
      from jsonb_array_elements(k) with ordinality o(x,ord)
    )
    update public.missed_opportunity_journal j set
      high_5m=(select max(h) from b where i<5),low_5m=(select min(l) from b where i<5),close_5m=(select c from b where i=4),
      high_15m=(select max(h) from b where i<15),low_15m=(select min(l) from b where i<15),close_15m=(select c from b where i=14),
      high_30m=(select max(h) from b where i<30),low_30m=(select min(l) from b where i<30),close_30m=(select c from b where i=29),
      high_60m=(select max(h) from b where i<60),low_60m=(select min(l) from b where i<60),close_60m=(select c from b where i=59),
      mfe_5=(select max(h) from b where i<5)/e-1,mae_5=(select min(l) from b where i<5)/e-1,
      mfe_15=(select max(h) from b where i<15)/e-1,mae_15=(select min(l) from b where i<15)/e-1,
      mfe_30=(select max(h) from b where i<30)/e-1,mae_30=(select min(l) from b where i<30)/e-1,
      mfe_60=(select max(h) from b where i<60)/e-1,mae_60=(select min(l) from b where i<60)/e-1,
      reconstructed_net_usdt=notional*(case when exists(select 1 from b where i<60 and l<=e*(1-stop))
        then -stop else (select c from b where i=59)/e-1 end)-fee,
      outcome_tracked_at=now(),track_attempts=track_attempts+1,updated_at=now()
    where j.signal_id=r.signal_id;
    n:=n+1;
  end loop;
  return n;
end $function$;
revoke all on function public.missed_opportunity_track(integer) from public,anon,authenticated;

create or replace view public.missed_opportunity_by_reason with (security_invoker=true) as
select
  case
    when reject_reason like 'V17_SETUP_EXPIRED%' then 'V17_SETUP_EXPIRED'
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

select public.missed_opportunity_sync(10000);
select cron.schedule('missed-opportunity-sync-track-5m','*/5 * * * *',
  $cmd$ select public.missed_opportunity_track(30); $cmd$);
