-- GPT FINAL RECHECK (FD1-RC1) evidence. OBSERVATIONAL ONLY: no trading code reads these
-- objects; they record, for every candidate that reached the pre-dispatch change detector,
-- the initial GPT BUY, the pre-dispatch snapshot, whether a recheck ran and what GPT answered,
-- and afterwards the counterfactual price path (5/15/30/60 m) so "did FINAL RECHECK reduce
-- losses, or is it too conservative?" can be answered with data.
create table if not exists public.fd1_final_recheck_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  signal_id text not null,
  symbol text not null,
  policy_version text not null,
  initial_gpt_decision text,
  initial_gpt_at timestamptz,
  initial_snapshot_at timestamptz,
  initial_snapshot_hash text,
  initial_context jsonb,
  pre_dispatch_at timestamptz,
  pre_dispatch_snapshot jsonb,
  recheck_triggered boolean not null,
  recheck_reasons text[] not null default '{}',
  deltas jsonb,
  final_gpt_decision text,
  final_gpt_at timestamptz,
  final_error text,
  final_job_key text,
  final_latency_ms integer,
  final_cost_usd numeric,
  final_answer jsonb,
  outcome text not null,
  counterfactual_entry_price numeric,
  -- filled by fd1_final_recheck_track()
  track_attempts integer not null default 0,
  tracked_at timestamptz,
  ret_5m numeric, ret_15m numeric, ret_30m numeric, ret_60m numeric,
  mfe_60m numeric, mae_60m numeric, stop_hit_minute integer,
  counterfactual_net_usdt numeric,
  position_id uuid,
  actual_entry_price numeric, exit_price numeric, exit_reason text, net_pnl_usdt numeric,
  position_mfe numeric, position_mae numeric
);
alter table public.fd1_final_recheck_log enable row level security;
create index if not exists fd1_final_recheck_log_signal_idx on public.fd1_final_recheck_log (signal_id);
create index if not exists fd1_final_recheck_log_untracked_idx on public.fd1_final_recheck_log (created_at) where tracked_at is null;
comment on table public.fd1_final_recheck_log is
  'GPT FINAL RECHECK evidence (observational). counterfactual_net_usdt: 600 USDT notional from the pre-dispatch ask, native-stop proxy -2.5% within 60 m else the 60 m close, minus 0.1% round-trip fee; 1m-bar resolution.';

-- Counterfactual/outcome tracker. Public Binance klines only; never touches trading tables
-- except reading the position of the same signal.
create or replace function public.fd1_final_recheck_track(p_limit integer default 10)
returns integer
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  r record; k jsonb; st integer; t0 bigint; e numeric; n integer := 0;
  pos record; pk jsonb; pe bigint; ps bigint;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','4000');
  for r in select * from public.fd1_final_recheck_log
    where tracked_at is null and track_attempts < 6 and pre_dispatch_at < now() - interval '62 minutes'
    order by created_at limit greatest(1,least(p_limit,50))
  loop
    update public.fd1_final_recheck_log set track_attempts=track_attempts+1 where id=r.id;
    e := coalesce(r.counterfactual_entry_price,(r.pre_dispatch_snapshot->>'mid')::numeric);
    if e is null or e<=0 then continue; end if;
    t0 := (floor(extract(epoch from r.pre_dispatch_at)*1000/60000)*60000)::bigint;
    begin
      select status, case when status=200 then content::jsonb end into st, k
        from http_get('https://fapi.binance.com/fapi/v1/klines?symbol='||r.symbol||'&interval=1m&startTime='||t0||'&limit=62');
    exception when others then continue; end;
    if st is distinct from 200 or jsonb_array_length(k) < 61 then continue; end if;
    -- bar i covers [t0+i m, t0+(i+1) m); the close of bar h is the price h minutes after dispatch (1m resolution)
    with b as (select (o.ord-1)::int i,(x->>2)::numeric h,(x->>3)::numeric l,(x->>4)::numeric c
               from jsonb_array_elements(k) with ordinality o(x,ord))
    update public.fd1_final_recheck_log g set
      ret_5m=(select c from b where i=5)/e-1, ret_15m=(select c from b where i=15)/e-1,
      ret_30m=(select c from b where i=30)/e-1, ret_60m=(select c from b where i=60)/e-1,
      mfe_60m=(select max(h) from b where i<=60)/e-1, mae_60m=(select min(l) from b where i<=60)/e-1,
      stop_hit_minute=(select min(i) from b where i<=60 and l<=e*0.975),
      counterfactual_net_usdt=600*(case when exists(select 1 from b where i<=60 and l<=e*0.975) then -0.025
        else (select c from b where i=60)/e-1 end) - 0.6
    where g.id=r.id;
    -- the real position of the same signal, once closed
    select p.id,p.entry_price,p.exit_price,p.exit_reason,p.realized_pnl_usdt,p.entry_at,p.closed_at,p.state into pos
      from public.v11_long_regime_positions p where p.signal_id::text=r.signal_id order by p.entry_at desc limit 1;
    if pos.id is not null and pos.state<>'CLOSED' then continue; end if;
    if pos.id is not null then
      ps := (floor(extract(epoch from pos.entry_at)*1000/60000)*60000)::bigint;
      pe := (extract(epoch from pos.closed_at)*1000)::bigint;
      begin
        select case when status=200 then content::jsonb end into pk
          from http_get('https://fapi.binance.com/fapi/v1/klines?symbol='||r.symbol||'&interval=1m&startTime='||ps||'&endTime='||pe||'&limit=500');
      exception when others then pk := null; end;
      update public.fd1_final_recheck_log g set position_id=pos.id, actual_entry_price=pos.entry_price, exit_price=pos.exit_price,
        exit_reason=pos.exit_reason, net_pnl_usdt=pos.realized_pnl_usdt,
        position_mfe=(select max((x->>2)::numeric) from jsonb_array_elements(coalesce(pk,'[]'::jsonb)) x)/pos.entry_price-1,
        position_mae=(select min((x->>3)::numeric) from jsonb_array_elements(coalesce(pk,'[]'::jsonb)) x)/pos.entry_price-1
      where g.id=r.id;
    end if;
    update public.fd1_final_recheck_log set tracked_at=now() where id=r.id;
    n := n+1;
  end loop;
  return n;
end $function$;
revoke all on function public.fd1_final_recheck_track(integer) from public, anon, authenticated;

-- One row per arm/outcome. avoided_loss / missed_upside are only meaningful for rows that
-- did NOT trade (FINAL SKIP/ABSTAIN, post-recheck safety); traded rows carry real PnL.
create or replace view public.fd1_final_recheck_evaluation with (security_invoker=true) as
select
  case when not recheck_triggered then 'A_NO_RECHECK'
       when final_gpt_decision='BUY' then 'B_FINAL_BUY'
       else 'C_FINAL_'||coalesce(final_gpt_decision,'ABSTAIN') end as arm,
  outcome,
  count(*) as candidates,
  count(position_id) as traded,
  count(*) filter (where tracked_at is not null) as tracked,
  round(avg(ret_5m)*100,3) as avg_ret_5m_pct, round(avg(ret_15m)*100,3) as avg_ret_15m_pct,
  round(avg(ret_30m)*100,3) as avg_ret_30m_pct, round(avg(ret_60m)*100,3) as avg_ret_60m_pct,
  round(avg(mfe_60m)*100,3) as avg_mfe_60m_pct, round(avg(mae_60m)*100,3) as avg_mae_60m_pct,
  round(sum(counterfactual_net_usdt),2) as counterfactual_net_usdt,
  round(sum(greatest(0,-counterfactual_net_usdt)) filter (where position_id is null),2) as avoided_loss_usdt,
  round(sum(greatest(0,counterfactual_net_usdt)) filter (where position_id is null),2) as missed_upside_usdt,
  round(sum(net_pnl_usdt),2) as realized_net_usdt,
  round(avg(final_latency_ms)) as avg_recheck_latency_ms,
  round(sum(final_cost_usd),4) as recheck_cost_usd
from public.fd1_final_recheck_log
group by 1,2;

select cron.schedule('fd1-final-recheck-track-5m', '*/5 * * * *', $cmd$ select public.fd1_final_recheck_track(10); $cmd$);

-- Order-free replay of the FINAL RECHECK (A/B comparison on historical FD1 BUY triggers).
alter table public.fd1_replay_jobs drop constraint if exists fd1_replay_jobs_task_check;
alter table public.fd1_replay_jobs add constraint fd1_replay_jobs_task_check check (task in ('ENTRY','HOLD','RECHECK'));
