-- Trading-booooo v6.9.0 post-deploy verification
-- Run in Supabase SQL Editor after migration 202607270022.

-- 1. Versioned settings and conservative execution calibration.
select
  id,
  strategy,
  scalp_position_slots,
  max_new_entries_per_scan,
  scalp_unmeasured_latency_ms,
  scalp_unmeasured_latency_penalty_bps,
  scalp_latency_source,
  scalp_latency_samples,
  scalp_latency_p95_ms,
  scalp_ev_bias_source,
  scalp_ev_bias_samples,
  scalp_ev_bias_penalty_bps,
  scalp_ev_bias_measured_at,
  updated_at
from public.trading_settings
where id = 1;

-- 2. Immutable champion/challenger policy definitions and staged traffic.
select
  version,
  status,
  parent_version,
  engine_version,
  traffic_fraction,
  policy_definition ->> 'family' as policy_family,
  policy_definition,
  source_online_version,
  evaluation_started_at,
  promoted_at,
  confirmed_at,
  decision_reason,
  updated_at
from public.lob_policy_versions
order by version desc
limit 20;

-- 3. Governance summary. Challenger should start at 0.15 and move to 0.50 only after EXPAND.
select jsonb_pretty(public.get_lob_policy_status()) as governance_status;

-- 4. Verify only accounting-clean live outcomes are eligible to vote.
select
  accounting_quality,
  policy_lane,
  count(*) as outcomes,
  count(*) filter (where policy_version is not null) as versioned_outcomes,
  round(avg(net_bps)::numeric, 2) as avg_net_bps,
  max(closed_at) as latest_closed_at
from public.lob_online_outcomes
group by accounting_quality, policy_lane
order by latest_closed_at desc nulls last;

-- 5. Confirm fixed 3-slot denominator and evidence-sized orders in new entry snapshots.
select
  opened_at,
  exchange,
  market,
  entry_snapshot #>> '{policy,version}' as policy_version,
  entry_snapshot #>> '{policy,lane}' as policy_lane,
  entry_snapshot #>> '{policy,definition,family}' as policy_family,
  (entry_snapshot ->> 'slots')::numeric as slots,
  (entry_snapshot #>> '{risk_sizing,slotCap}')::numeric as slot_cap,
  (entry_snapshot #>> '{risk_sizing,sizeFraction}')::numeric as size_fraction,
  entry_snapshot #>> '{evidence_sizing,cappedBy}' as evidence_cap,
  (entry_snapshot #>> '{evidence_sizing,qualityScore}')::numeric as quality_score,
  (entry_snapshot ->> 'latency_penalty_bps')::numeric as latency_penalty_bps,
  entry_snapshot ->> 'latency_penalty_source' as latency_penalty_source,
  (entry_snapshot ->> 'forecast_bias_penalty_bps')::numeric as forecast_bias_penalty_bps,
  entry_snapshot ->> 'forecast_bias_source' as forecast_bias_source,
  engine_version
from public.lob_online_outcomes
where engine_version = '6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION'
order by opened_at desc
limit 50;

-- 6. Slot concentration invariant: one order should never exceed 1/3 of strategy exposure
-- when scalp_position_slots=3. Small rounding differences are tolerated.
select
  position_id,
  market,
  opened_at,
  (entry_snapshot #>> '{risk_sizing,notionalQuote}')::numeric as order_quote,
  (entry_snapshot #>> '{risk_sizing,totalExposureCap}')::numeric as exposure_cap,
  round((
    (entry_snapshot #>> '{risk_sizing,notionalQuote}')::numeric /
    nullif((entry_snapshot #>> '{risk_sizing,totalExposureCap}')::numeric, 0)
  )::numeric, 4) as exposure_fraction,
  case
    when (entry_snapshot #>> '{risk_sizing,notionalQuote}')::numeric <=
         (entry_snapshot #>> '{risk_sizing,totalExposureCap}')::numeric / 3 + 1
      then 'PASS'
    else 'CHECK'
  end as fixed_three_slot_check
from public.lob_online_outcomes
where engine_version = '6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION'
  and entry_snapshot #>> '{risk_sizing,totalExposureCap}' is not null
order by opened_at desc
limit 100;

-- 7. EV calibration by blocks after enough clean v6.9 closes exist.
with numbered as (
  select
    row_number() over (order by opened_at) as rn,
    net_bps,
    profitable,
    (entry_snapshot ->> 'ev_lower_bound_bps')::numeric as predicted_ev_lcb_bps,
    opened_at,
    closed_at
  from public.lob_online_outcomes
  where engine_version = '6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION'
    and accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')
), blocks as (
  select *, ((rn - 1) / 20) + 1 as trade_block from numbered
)
select
  trade_block,
  count(*) as trades,
  round(100.0 * count(*) filter (where profitable) / nullif(count(*), 0), 2) as win_rate_pct,
  round(avg(net_bps)::numeric, 2) as realized_avg_net_bps,
  round(avg(predicted_ev_lcb_bps)::numeric, 2) as predicted_avg_ev_lcb_bps,
  round(avg(net_bps - predicted_ev_lcb_bps)::numeric, 2) as forecast_residual_bps,
  min(opened_at) as first_trade,
  max(closed_at) as latest_trade
from blocks
group by trade_block
order by trade_block;
