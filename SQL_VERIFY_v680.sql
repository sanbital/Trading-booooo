-- Trading-booooo v6.8.0 deployment verification
-- Read-only: this file does not change model, capital, orders or positions.

-- 1. Current immutable production policy and validation phase.
select jsonb_pretty(public.get_lob_policy_status()) as policy_status;

-- 2. Exactly one champion and at most one alternate must exist.
select
  count(*) filter (where status = 'CHAMPION') as champion_count,
  count(*) filter (where status in ('CHALLENGER', 'CONTROL')) as alternate_count,
  count(*) filter (where status = 'ROLLED_BACK') as rollback_count,
  count(*) filter (where status = 'REJECTED') as rejected_count
from public.lob_policy_versions;

-- 3. Version history. A policy version is not a sample count.
select
  version,
  status,
  parent_version,
  engine_version,
  source_online_version,
  traffic_fraction,
  evaluation_started_at,
  promoted_at,
  confirmed_at,
  evaluated_at,
  retired_at,
  decision_reason,
  metrics
from public.lob_policy_versions
order by version desc;

-- 4. Current evaluation dataset sizes.
with dataset as (
  select public.get_lob_policy_evaluation_dataset() as value
)
select
  value ->> 'phase' as phase,
  value ->> 'since' as cohort_since,
  value ->> 'baseline_version' as baseline_version,
  value ->> 'candidate_version' as candidate_version,
  jsonb_array_length(coalesce(value -> 'baseline_trades', '[]'::jsonb))
    as baseline_trades,
  jsonb_array_length(coalesce(value -> 'candidate_trades', '[]'::jsonb))
    as candidate_trades,
  jsonb_array_length(coalesce(value -> 'baseline_exposures', '[]'::jsonb))
    as baseline_scans,
  jsonb_array_length(coalesce(value -> 'candidate_exposures', '[]'::jsonb))
    as candidate_scans
from dataset;

-- 5. Full-size cohort comparison by policy.
select
  o.policy_version,
  o.policy_lane,
  o.exchange,
  count(*) as trades,
  round(100 * avg(o.profitable::int), 2) as profitable_rate_pct,
  round(avg(o.net_bps), 3) as mean_net_bps,
  round(
    sum(o.realized_cost_quote * o.net_bps) /
      nullif(sum(o.realized_cost_quote), 0),
    3
  ) as notional_weighted_net_bps,
  round(avg(o.realized_cost_quote), 4) as mean_notional_quote,
  round(avg(o.held_seconds), 2) as mean_hold_seconds
from public.lob_online_outcomes o
where o.policy_version is not null
group by o.policy_version, o.policy_lane, o.exchange
order by o.policy_version desc, o.exchange;

-- 6. Opportunity and trade-rate ledger by policy.
select
  e.policy_version,
  e.policy_lane,
  count(*) as assigned_scans,
  sum(e.candidate_count) as candidates,
  sum(e.entry_attempts) as entry_attempts,
  sum(e.reservations) as reservations,
  round(sum(e.reservations)::numeric / nullif(count(*), 0), 4)
    as reservations_per_scan,
  min(e.assigned_at) as first_assignment,
  max(e.assigned_at) as last_assignment
from public.lob_policy_cycle_exposures e
group by e.policy_version, e.policy_lane
order by e.policy_version desc;

-- 7. Verify that new entries carry a real policy version and entry-pinned exit settings.
select
  p.id,
  p.exchange,
  p.market,
  p.state,
  p.created_at,
  p.metadata #>> '{lob_signal,policy,version}' as policy_version,
  p.metadata #>> '{lob_signal,policy,lane}' as policy_lane,
  p.metadata #>> '{lob_signal,coin_learning,profile_version}' as coin_profile_version,
  p.metadata #>> '{lob_signal,coin_learning,soft_exit_grace_seconds}'
    as soft_exit_grace_seconds,
  p.metadata #>> '{lob_signal,coin_learning,soft_exit_confirmations}'
    as soft_exit_confirmations
from public.trading_positions p
where p.metadata ? 'lob_signal'
order by p.created_at desc
limit 30;

-- 8. Capital authority must remain at the operator-approved configuration.
select
  id,
  mode,
  strategy,
  scalp_position_slots,
  scalp_size_fraction,
  upbit_allocation_mode,
  upbit_allocation_value,
  upbit_reserve_quote,
  binance_allocation_mode,
  binance_allocation_value,
  binance_reserve_quote,
  max_open_positions,
  max_open_positions_per_exchange
from public.trading_settings
where id = 1;
