-- Read-only, reproducible calculations for V21_POST_FILL_DRIFT_20260913_1.
-- The fixed cutoff prevents later trades from silently changing the reported result.
begin transaction read only;

create temporary table _v21_trade on commit drop as
select p.*,
       p.realized_pnl_usdt::numeric pnl,
       (p.entry_price*p.original_quantity)::numeric entry_notional,
       greatest(0,p.peak_price/p.entry_price-1)::numeric observed_mfe,
       (p.realized_pnl_usdt/nullif(p.entry_price*p.original_quantity,0))::numeric net_return,
       (p.metadata->'entryFeatures'->>'referenceClose')::numeric reference_close,
       (p.entry_price/nullif((p.metadata->'entryFeatures'->>'referenceClose')::numeric,0)-1)::numeric fill_drift
from public.v11_long_regime_positions p
where p.state='CLOSED'
  and p.closed_at<='2026-09-13T06:30:22.434605Z'
  and p.metadata->>'executionMode'='LEADER_MOMENTUM_V17';

-- A/B/D/E/F and deployment-patch cohorts. C is the same exact policy-stamped
-- population as B because V20 was audit-only and did not change QV3/R5 behaviour.
with windows as (
  select 'A_SINCE_20260909_084406_KST' cohort,t.* from _v21_trade t
    where entry_at>='2026-09-08T23:44:06Z'
  union all
  select 'B_QV3_STAMPED',t.* from _v21_trade t
    where entry_at>='2026-09-11T15:20:00Z'
      and metadata->'qv3'->>'version'='QV3_ENTRY_EXIT_TWO_1'
      and metadata->'qv3'->>'basis'='OPERATOR_OVERRIDE_PROTOCOL_DEFER_20260911'
      and (metadata->'qv3'->>'entryAt')::bigint=(extract(epoch from entry_at)*1000)::bigint
  union all
  select 'D_POST_V19',t.* from _v21_trade t where entry_at>='2026-09-12T11:40:56.988Z'
  union all
  select 'E_PREVIOUS_48H',t.* from _v21_trade t
    where entry_at>='2026-09-09T06:30:22.434605Z' and entry_at<'2026-09-11T06:30:22.434605Z'
  union all
  select 'F_LATEST_48H',t.* from _v21_trade t where entry_at>='2026-09-11T06:30:22.434605Z'
  union all
  select 'V39_PATCH',t.* from _v21_trade t where metadata->>'executorPatch'='V20-QV3-EVIDENCE-1'
), curve as (
  select cohort,id,closed_at,pnl,
         sum(pnl) over(partition by cohort order by closed_at,id) equity
  from windows
), drawdown as (
  select cohort,max(greatest(0,peak)-equity) max_closed_trade_drawdown
  from (
    select *,max(equity) over(partition by cohort order by closed_at,id rows unbounded preceding) peak
    from curve
  ) x group by cohort
)
select w.cohort,count(*) trades,count(*) filter(where pnl>0) wins,
       count(*) filter(where pnl<0) losses,sum(pnl) net_pnl,avg(pnl) expectancy,
       sum(pnl) filter(where pnl>0)/nullif(-sum(pnl) filter(where pnl<0),0) profit_factor,
       avg(pnl) filter(where pnl>0) average_win,
       percentile_cont(.5) within group(order by pnl) filter(where pnl>0) median_win,
       avg(pnl) filter(where pnl<0) average_loss,
       percentile_cont(.5) within group(order by pnl) filter(where pnl<0) median_loss,
       min(pnl) worst_trade,d.max_closed_trade_drawdown
from windows w join drawdown d using(cohort)
group by w.cohort,d.max_closed_trade_drawdown order by w.cohort;

-- QV3 MFE/giveback. peak_price is the bot-observed bid maximum, not a claim
-- about the exchange tick high or a fillable all-size price.
with q as (
  select * from _v21_trade
  where entry_at>='2026-09-11T15:20:00Z'
    and metadata->'qv3'->>'version'='QV3_ENTRY_EXIT_TWO_1'
)
select count(*) total,count(observed_mfe) mfe_available,
       sum(net_return)/nullif(sum(observed_mfe),0) aggregate_return_recovery,
       sum(net_return) filter(where pnl>0)/nullif(sum(observed_mfe) filter(where pnl>0),0) winner_only_recovery,
       sum(pnl)/nullif(sum(observed_mfe*entry_notional),0) amount_weighted_efficiency,
       count(*) filter(where pnl<0 and observed_mfe<.002) low_favorable_losses,
       count(*) filter(where pnl<0 and observed_mfe>0) positive_mfe_to_loss,
       avg((observed_mfe-net_return)*100) filter(where observed_mfe>0) average_giveback_pp,
       percentile_cont(.5) within group(order by (observed_mfe-net_return)*100)
         filter(where observed_mfe>0) median_giveback_pp,
       percentile_cont(.9) within group(order by (observed_mfe-net_return)*100)
         filter(where observed_mfe>0) p90_giveback_pp
from q;

-- Accepted rule: identical entries, immediate-exit overlay. The normal model
-- charges 25 bp adverse exit movement plus both 5 bp fees; stress doubles the
-- fees and charges 50 bp exit movement. These are simulations, not live fills.
with q as (
  select * from _v21_trade
  where entry_at>='2026-09-11T15:20:00Z'
    and metadata->'qv3'->>'version'='QV3_ENTRY_EXIT_TWO_1'
), threshold(t) as (values (.005::numeric),(.0075),(.01),(.0125),(.015),(.02)),
scored as (
  select t.t,q.*,-entry_notional*.0035 candidate_normal,-entry_notional*.007 candidate_stress
  from threshold t join q on abs(fill_drift)>t.t+1e-12
)
select t threshold,count(*) caught,count(*) filter(where pnl>0) winners_caught,
       count(*) filter(where pnl<0) losses_caught,sum(pnl) caught_actual_net,
       sum(candidate_normal-pnl) normal_delta,sum(candidate_stress-pnl) stress_delta,
       sum(pnl) filter(where pnl>0) winner_value_damaged
from scored group by t order by t;

-- Rejected acceleration entry filter. Blocking these rows would remove both
-- the losses and the winners; no replacement opportunity is invented.
select id,symbol,entry_at,pnl,
       (metadata->'entryFeatures'->>'dayReturn')::numeric day_return,
       (metadata->'entryFeatures'->>'return5m')::numeric return_5m,
       (metadata->'entryFeatures'->>'return15m')::numeric return_15m
from _v21_trade
where entry_at>='2026-09-11T15:20:00Z'
  and metadata->'qv3'->>'version'='QV3_ENTRY_EXIT_TWO_1'
  and (metadata->'entryFeatures'->>'dayReturn')::numeric>=.20
  and (metadata->'entryFeatures'->>'return5m')::numeric>=
      1.2*(metadata->'entryFeatures'->>'return15m')::numeric
order by entry_at;

-- Latest incident lifecycle export: order count, fill count, exact trade/order
-- identifiers and policy stamps remain queryable without altering the ledger.
select p.id position_id,p.signal_id,p.symbol,p.entry_at,p.closed_at,p.entry_price,p.exit_price,
       p.original_quantity,p.realized_pnl_usdt,p.exit_reason,
       p.metadata->>'executorPatch' executor_patch,
       p.metadata->>'leaderExitPolicyVersion' exit_policy,
       p.metadata->'qv3' qv3_stamp,
       jsonb_typeof(p.metadata->'qv3State'->'favorableCandle')='array' qv3_armed,
       (select jsonb_agg(jsonb_build_object('trade_id',f.exchange_trade_id,'order_id',f.exchange_order_id,
                'side',f.side,'price',f.price,'quantity',f.quantity,'fee_quote',f.fee_quote_amount,
                'executed_at',f.executed_at) order by f.executed_at,f.exchange_trade_id)
        from public.exchange_trade_fills f
        where coalesce(f.v17_position_id,f.position_id)=p.id) fills
from _v21_trade p
where p.id in (
 '4543d76c-dc55-4654-876b-f7834570176b','84a796de-c6cf-4f0f-ae9d-72743db9292b',
 '6646f8dd-8b1b-4b86-8dac-db7e7b9a6e96','91c496d2-5731-4244-a016-576a94f90216')
order by p.entry_at;

rollback;
