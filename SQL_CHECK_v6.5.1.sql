-- Trading-booooo v6.5.1-GUARD
-- Run each section separately in Supabase SQL Editor and download the result as CSV.

-- ============================================================================
-- A. Identify which cycle produced "only Upbit KRW spot markets are allowed"
-- ============================================================================

select started_at, kind, status, error, summary
from public.trading_cycle_runs
where started_at > now() - interval '12 hours'
  and (
    coalesce(error, '') ilike '%only Upbit KRW spot markets are allowed%'
    or summary::text ilike '%only Upbit KRW spot markets are allowed%'
  )
order by started_at desc;

select created_at, code, cycle_id, position_id, order_id, message, details
from public.trading_events
where created_at > now() - interval '12 hours'
  and (
    message ilike '%only Upbit KRW spot markets are allowed%'
    or details::text ilike '%only Upbit KRW spot markets are allowed%'
  )
order by created_at desc;

-- Interpretation:
--   failed MONITOR + ENGINE_ERROR_NO_PAUSE => a tracked position/reconciliation path
--   successful SCAN + ENTRY_ERROR          => one malformed scanner candidate only

-- ============================================================================
-- B. Find every malformed route, including whitespace/case/cross-exchange rows
-- ============================================================================

select 'trading_positions' as source, id::text, exchange, market, state as status,
       created_at, updated_at
from public.trading_positions
where not (
  (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{2,20}$')
  or (exchange = 'binance' and market ~ '^[A-Z0-9]{2,24}USDT$')
)
union all
select 'trading_orders', id::text, exchange, market, state,
       created_at, updated_at
from public.trading_orders
where not (
  (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{2,20}$')
  or (exchange = 'binance' and market ~ '^[A-Z0-9]{2,24}USDT$')
)
union all
select 'scanner_candidates', id::text, exchange, market, decision,
       created_at, null::timestamptz
from public.scanner_candidates
where created_at > now() - interval '7 days'
  and not (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{2,20}$')
    or (exchange = 'binance' and market ~ '^[A-Z0-9]{2,24}USDT$')
  )
order by created_at desc;

-- Do not delete or update any returned row until its source and active order/position state
-- are reviewed. v6.5.1 isolates the bad row so healthy positions keep running.

-- ============================================================================
-- C. Closed live LOB trades: prediction versus realized excursion
-- This is the correct 180-second model dataset. The legacy scanner_signal_outcomes table
-- uses a minimum one-hour bucket and must not be used to fit LOB movement constants.
-- ============================================================================

select
  p.id,
  p.candidate_id,
  p.exchange,
  p.market,
  p.opened_at,
  p.closed_at,
  round(extract(epoch from (p.closed_at - p.opened_at))::numeric, 3) as held_seconds,
  p.close_reason,
  p.average_entry_price,
  p.peak_price,
  p.trough_price,
  p.realized_cost_quote,
  p.realized_proceeds_quote,
  p.paid_fees_quote,
  p.realized_pnl_quote,
  case when p.realized_cost_quote > 0
    then round((p.realized_pnl_quote / p.realized_cost_quote * 10000)::numeric, 6)
  end as realized_net_bps,
  case when p.average_entry_price > 0 and p.peak_price is not null
    then round(((p.peak_price / p.average_entry_price - 1) * 10000)::numeric, 6)
  end as mfe_bps,
  case when p.average_entry_price > 0 and p.trough_price is not null
    then round(((1 - p.trough_price / p.average_entry_price) * 10000)::numeric, 6)
  end as mae_bps,
  p.t1_completed,
  p.metadata->'lob_signal'->>'pattern' as pattern,
  p.metadata->'lob_signal'->>'p_target' as predicted_p_target,
  p.metadata->'lob_signal'->>'neutral_win_rate' as predicted_neutral_win_rate,
  p.metadata->'lob_signal'->>'target_bps' as predicted_target_bps,
  coalesce(
    p.metadata->'lob_signal'->>'noise_adjusted_stop_bps',
    p.metadata->'lob_signal'->>'stop_bps'
  ) as predicted_stop_bps,
  p.metadata->'lob_signal'->>'ev_lower_bound_bps' as predicted_ev_lcb_bps,
  p.metadata->'lob_signal'->'traps' as traps,
  p.metadata->'lob_signal'->'features' as features,
  p.metadata->>'entry_bid_depth_quote' as entry_bid_depth_quote,
  p.metadata->>'maker_entry' as maker_entry
from public.trading_positions p
where p.state = 'CLOSED'
  and p.is_paper = false
  and p.closed_at > now() - interval '7 days'
  and p.metadata ? 'lob_signal'
order by p.closed_at;

-- ============================================================================
-- D. Why trades were rejected/stopped on the currently deployed v6.3.3
-- ============================================================================

select
  code,
  coalesce(
    details->>'reason',
    details->>'error',
    case
      when jsonb_typeof(details->'reasons') = 'array'
      then array_to_string(array(select jsonb_array_elements_text(details->'reasons')), ',')
    end,
    '-'
  ) as reason,
  count(*) as n,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from public.trading_events
where created_at > now() - interval '7 days'
  and code in (
    'LOB_CANDIDATE_DISCARD',
    'ENTRY_ERROR',
    'ENTRY_CIRCUIT_BLOCK',
    'ENGINE_ERROR_NO_PAUSE',
    'SAFETY_PAUSE',
    'MAKER_ENTRY_RESTED',
    'MARKET_DATA_UNAVAILABLE'
  )
group by 1, 2
order by n desc;

-- ============================================================================
-- E. Sample sufficiency before changing movement constants
-- ============================================================================

select
  coalesce(metadata->'lob_signal'->>'pattern', 'UNKNOWN') as pattern,
  count(*) as closed_trades,
  count(*) filter (where close_reason ilike '%TARGET%') as target_hits,
  round(avg(
    case when realized_cost_quote > 0
      then realized_pnl_quote / realized_cost_quote * 10000
    end
  )::numeric, 4) as mean_net_bps,
  round(avg(
    case when average_entry_price > 0 and peak_price is not null
      then (peak_price / average_entry_price - 1) * 10000
    end
  )::numeric, 4) as mean_mfe_bps,
  round(avg(
    case when average_entry_price > 0 and trough_price is not null
      then (1 - trough_price / average_entry_price) * 10000
    end
  )::numeric, 4) as mean_mae_bps
from public.trading_positions
where state = 'CLOSED'
  and is_paper = false
  and closed_at > now() - interval '7 days'
  and metadata ? 'lob_signal'
group by 1
order by closed_trades desc;
