-- V15 RANGE R7 capacity preflight
-- Research-only. This file creates TEMP tables only and never mutates production state.
-- Candidate: V10_R7_GATED_BTCABS20_R24GE6
-- Exit: RANGE_R7_STATE_T1P00_A18_G0P75
-- Stored outcome cost baseline is 21 bp = 6 bp entry premium + 5 bp entry fee + 5 bp exit fee + 5 bp exit hair.
-- Premium stress therefore subtracts only +4 bp at 10 bp and +9 bp at 15 bp.

begin read only;

create temporary table tmp_v15_r7_candidates on commit drop as
with route as (
  select
    t,
    btc72,
    route,
    lag(route) over(order by t) as prev_route,
    lag(btc72) over(order by t) as prev_btc72
  from v10_research.regime_route_15m_v1
), base as (
  select
    o.event_id,
    o.symbol,
    b.t as signal_at,
    o.entry_at,
    o.exit_at,
    o.net_bps,
    o.gross_bps,
    o.exit_reason,
    o.holding_minutes,
    f.r24,
    f.bb_pos,
    f.atr_ratio,
    f.qv24,
    r.btc72,
    r.prev_btc72,
    r.route,
    r.prev_route
  from v10_research.regime_exit_r1_outcomes o
  join v10_research.regime_transition_base_events_v1 b
    on b.id=o.event_id
  join v10_research.lanes_v4_features f
    on f.symbol=o.symbol and f.t=b.t
  join route r
    on r.t=b.t
  where o.candidate_key='RANGE_R7_STATE_T1P00_A18_G0P75'
    and r.route='RANGE'
    and r.prev_route='RANGE'
    and abs(r.btc72)<=0.02
    and f.qv24>=50000000
    and f.atr_ratio>=1.65
    and f.bb_pos<=-1.05
    and f.r24>=-0.06
)
select
  *,
  row_number() over(
    partition by entry_at
    order by bb_pos asc, atr_ratio desc, symbol asc
  )::int as candidate_rank
from base;

create temporary table tmp_v15_r7_results(
  cap int,
  event_id bigint,
  symbol text,
  signal_at timestamptz,
  entry_at timestamptz,
  exit_at timestamptz,
  net_bps numeric,
  gross_bps numeric,
  exit_reason text,
  holding_minutes numeric,
  candidate_rank int,
  admitted_slot int
) on commit drop;

create temporary table tmp_v15_open(
  event_id bigint,
  symbol text,
  exit_at timestamptz,
  slot int
) on commit drop;

create temporary table tmp_v15_cooldown(
  symbol text primary key,
  last_signal_at timestamptz
) on commit drop;

-- No-backfill semantics intentionally match the current V15 shadow lineage:
-- rank the bar first, take only the number of currently free slots, then apply
-- same-symbol/cooldown guards.  A rejected ranked candidate is not replaced by
-- a lower-ranked candidate on the same bar.
do $$
declare
  c int;
  ts timestamptz;
  rec record;
  free_slots int;
  slotno int;
  lastsig timestamptz;
begin
  foreach c in array array[1,3,5,10] loop
    truncate tmp_v15_open;
    truncate tmp_v15_cooldown;

    for ts in select distinct entry_at from tmp_v15_r7_candidates order by entry_at loop
      delete from tmp_v15_open where exit_at<=ts;
      free_slots:=c-(select count(*) from tmp_v15_open);
      if free_slots<=0 then continue; end if;

      for rec in
        select *
        from tmp_v15_r7_candidates
        where entry_at=ts
        order by bb_pos asc, atr_ratio desc, symbol asc
        limit free_slots
      loop
        if exists(select 1 from tmp_v15_open where symbol=rec.symbol) then
          continue;
        end if;

        select last_signal_at into lastsig
        from tmp_v15_cooldown
        where symbol=rec.symbol;

        if lastsig is not null and rec.signal_at<lastsig+interval '6 hours' then
          continue;
        end if;

        select s into slotno
        from generate_series(1,c) s
        where not exists(select 1 from tmp_v15_open o where o.slot=s)
        order by s
        limit 1;
        if slotno is null then exit; end if;

        insert into tmp_v15_r7_results values(
          c,rec.event_id,rec.symbol,rec.signal_at,rec.entry_at,rec.exit_at,
          rec.net_bps,rec.gross_bps,rec.exit_reason,rec.holding_minutes,
          rec.candidate_rank,slotno
        );
        insert into tmp_v15_open values(rec.event_id,rec.symbol,rec.exit_at,slotno);
        insert into tmp_v15_cooldown(symbol,last_signal_at)
        values(rec.symbol,rec.signal_at)
        on conflict(symbol) do update set last_signal_at=excluded.last_signal_at;
      end loop;
    end loop;
  end loop;
end $$;

-- Primary capacity / premium-stress output.
select
  cap,
  count(*) as trades,
  round(avg(net_bps)::numeric,4) as avg_net_6bp,
  round(avg(net_bps-4)::numeric,4) as avg_net_10bp,
  round(avg(net_bps-9)::numeric,4) as avg_net_15bp,
  round(avg((net_bps>0)::int::numeric),4) as win_rate_6bp,
  round((sum(net_bps) filter(where net_bps>0)/nullif(abs(sum(net_bps) filter(where net_bps<0)),0))::numeric,4) as pf_6bp,
  round((sum(net_bps-4) filter(where net_bps-4>0)/nullif(abs(sum(net_bps-4) filter(where net_bps-4<0)),0))::numeric,4) as pf_10bp,
  round((sum(net_bps-9) filter(where net_bps-9>0)/nullif(abs(sum(net_bps-9) filter(where net_bps-9<0)),0))::numeric,4) as pf_15bp,
  round(sum(net_bps)::numeric,2) as total_net_bps_6bp
from tmp_v15_r7_results
group by cap
order by cap;

-- Independent calendar-year behavior.
select
  cap,
  extract(year from entry_at)::int as year,
  count(*) as trades,
  round(avg(net_bps)::numeric,3) as avg_net_6bp,
  round(avg((net_bps>0)::int::numeric),4) as win_rate_6bp,
  round((sum(net_bps) filter(where net_bps>0)/nullif(abs(sum(net_bps) filter(where net_bps<0)),0))::numeric,3) as pf_6bp
from tmp_v15_r7_results
where extract(year from entry_at)>=2023
group by cap,extract(year from entry_at)
order by cap,year;

-- Admitted-rank diagnostics for the 10-slot ceiling.
select
  case
    when candidate_rank<=3 then '1-3'
    when candidate_rank<=5 then '4-5'
    else '6-10+'
  end as rank_group,
  count(*) as trades,
  round(avg(net_bps)::numeric,3) as avg_net_6bp,
  round(avg((net_bps>0)::int::numeric),4) as win_rate_6bp,
  round((sum(net_bps) filter(where net_bps>0)/nullif(abs(sum(net_bps) filter(where net_bps<0)),0))::numeric,3) as pf_6bp,
  round(sum(net_bps)::numeric,2) as total_net_bps_6bp
from tmp_v15_r7_results
where cap=10
group by 1
order by 1;

rollback;
