-- 1) 최근 실거래별 실제 종료 원인·손절폭·보유시간·LOB 판단값
select
  p.id,
  p.exchange,
  p.market,
  p.opened_at,
  p.closed_at,
  round(extract(epoch from (p.closed_at - p.opened_at))::numeric, 3) as held_seconds,
  p.average_entry_price,
  p.stop_price,
  p.target_1,
  round(
    p.realized_proceeds_quote / nullif(p.initial_quantity, 0),
    8
  ) as approximate_average_exit_price,
  p.realized_cost_quote,
  p.realized_pnl_quote,
  round(
    case when p.realized_cost_quote > 0
      then p.realized_pnl_quote / p.realized_cost_quote * 10000
    end,
    3
  ) as net_bps,
  p.close_reason,
  p.metadata ->> 'pending_exit_reason' as detailed_exit_reason,
  p.metadata #>> '{lob_signal,pattern}' as pattern,
  p.metadata #>> '{lob_signal,stop_bps}' as planned_stop_bps,
  p.metadata #>> '{lob_signal,noise_adjusted_stop_bps}' as noise_adjusted_stop_bps,
  p.metadata #>> '{lob_signal,features,noiseBandBps}' as observed_noise_bps,
  p.metadata #>> '{lob_signal,coin_learning,profile_version}' as online_profile_version,
  p.metadata #> '{lob_signal,coin_learning}' as coin_learning
from public.trading_positions p
where p.state = 'CLOSED'
  and not p.is_paper
  and p.opened_at >= now() - interval '12 hours'
order by p.opened_at desc;

-- 2) 3초·18초 거래 당시 이벤트. LOB_INVALIDATION, SIGNAL_REVERSAL, STOP_HIT,
--    SLOT_ROTATION_EXIT 중 무엇이 실제로 발동했는지 확정한다.
select
  e.created_at,
  e.position_id,
  p.exchange,
  p.market,
  e.code,
  e.message,
  e.details
from public.trading_events e
join public.trading_positions p on p.id = e.position_id
where p.opened_at >= now() - interval '12 hours'
  and (
    e.code in (
      'LOB_EXIT',
      'SLOT_ROTATION_EXIT',
      'POSITION_CLOSED',
      'EXIT_ERROR',
      'LOB_ONLINE_PROFILE_UPDATED',
      'LOB_ONLINE_LEARNING_DEFERRED'
    )
    or e.code like '%STOP%'
  )
order by e.created_at desc;

-- 3) 거래 종료 즉시 증가하는 코인×패턴 온라인 프로필
select
  exchange,
  market,
  pattern,
  version,
  samples,
  profitable_trades,
  round(profitable_trades::numeric / nullif(samples, 0) * 100, 2) as profitable_rate_pct,
  target_hits,
  early_exit_losses,
  round(ewma_net_bps, 3) as ewma_net_bps,
  round(ewma_hold_seconds, 3) as ewma_hold_seconds,
  round(ewma_profitable_mae_bps, 3) as profitable_mae_bps,
  exit_counts,
  updated_at
from public.lob_market_profiles
order by updated_at desc, exchange, market, pattern;

-- 4) 현재 자본 슬롯. v6.7 배포 후 6이어야 한다.
select
  strategy,
  scalp_position_slots,
  scalp_scan_universe,
  max_new_entries_per_scan,
  updated_at
from public.trading_settings
where id = 1;
