-- Trading-booooo v6.8.1 deployment verification (read only)

-- 1. Accounting columns and latest corrected closes.
select
  id,
  exchange,
  market,
  closed_at,
  initial_quantity,
  residual_quantity,
  residual_value_quote,
  residual_fee_base,
  realized_cost_quote,
  realized_proceeds_quote,
  paid_fees_quote,
  realized_pnl_quote,
  accounting_version,
  metadata #>> '{exit_residual_accounting,quality}' as accounting_quality
from public.trading_positions
where state = 'CLOSED'
order by closed_at desc
limit 50;

-- 2. Online learner must contain only verified labels.
select
  accounting_version,
  accounting_quality,
  count(*) as outcomes,
  round(avg(net_bps), 2) as avg_net_bps,
  round(sum(residual_value_quote), 8) as total_residual_value_quote,
  max(closed_at) as latest_close
from public.lob_online_outcomes
group by accounting_version, accounting_quality
order by latest_close desc;

-- 3. Any legacy-unverified position is deliberately absent from outcomes.
select
  count(*) as unverified_closed_positions,
  count(o.position_id) as accidentally_learned_unverified
from public.trading_positions p
left join public.lob_online_outcomes o on o.position_id = p.id
where p.state = 'CLOSED'
  and p.metadata #>> '{exit_residual_accounting,quality}' = 'LEGACY_UNVERIFIED';

-- 4. Dust distortion diagnostic after deployment.
select
  position_id,
  exchange,
  market,
  round(net_bps, 2) as net_bps,
  round(mae_bps, 2) as mae_bps,
  round((abs(net_bps) - mae_bps)::numeric, 2) as loss_beyond_mae_bps,
  round(residual_value_quote, 8) as residual_value_quote,
  accounting_quality,
  closed_at
from public.lob_online_outcomes
where net_bps < 0
order by closed_at desc
limit 50;

-- 5. Existing Pareto policy and capital authority remain unchanged.
select jsonb_pretty(public.get_lob_policy_status()) as policy_status;
select
  id,
  mode,
  strategy,
  scalp_position_slots,
  max_new_entries_per_scan,
  scalp_size_fraction,
  upbit_allocation_mode,
  binance_allocation_mode
from public.trading_settings
where id = 1;
