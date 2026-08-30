-- V10 closed-live-ledger operational context.
--
-- This is not an OOS Bull backtest. It replays the already executed, closed,
-- non-paper P10 Bull LONG ledger. BASE/STRESS retain recorded fills/slippage,
-- add back persisted paid fees, and replace them with 14/23 bps of the
-- persisted entry-notional proxy. Historical futures funding is not
-- reconstructed. These positions predate V10 and are context only, not a
-- signal-level V10 counterfactual replay.

with p as (
  select
    tp.*,
    tp.realized_pnl_quote + tp.paid_fees_quote
      - 0.0014 * coalesce(
        nullif(tp.metadata ->> 'notional_quote', '')::numeric,
        tp.realized_cost_quote
      ) as base_pnl,
    tp.realized_pnl_quote + tp.paid_fees_quote
      - 0.0023 * coalesce(
        nullif(tp.metadata ->> 'notional_quote', '')::numeric,
        tp.realized_cost_quote
      ) as stress_pnl
  from public.trading_positions tp
  where not tp.is_paper
    and tp.state = 'CLOSED'
    and tp.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
    and tp.position_side = 'LONG'
),
curve as (
  select
    p.*,
    sum(p.realized_pnl_quote) over (order by p.closed_at, p.id) as net_curve,
    sum(p.base_pnl) over (order by p.closed_at, p.id) as base_curve,
    sum(p.stress_pnl) over (order by p.closed_at, p.id) as stress_curve
  from p
),
drawdown as (
  select
    curve.*,
    curve.net_curve - max(curve.net_curve) over (
      order by curve.closed_at, curve.id
      rows between unbounded preceding and current row
    ) as net_dd,
    curve.base_curve - max(curve.base_curve) over (
      order by curve.closed_at, curve.id
      rows between unbounded preceding and current row
    ) as base_dd,
    curve.stress_curve - max(curve.stress_curve) over (
      order by curve.closed_at, curve.id
      rows between unbounded preceding and current row
    ) as stress_dd
  from curve
)
select
  count(*) as trades,
  min(opened_at) as first_open,
  max(closed_at) as last_close,
  extract(epoch from (max(closed_at) - min(opened_at))) / 3600 as wall_hours,
  sum(extract(epoch from (closed_at - opened_at)) / 3600) as exposure_hours,
  sum(extract(epoch from (closed_at - opened_at)) / 3600)
    / nullif(extract(epoch from (max(closed_at) - min(opened_at))) / 3600, 0)
    as average_concurrent_exposure,
  count(*) / (
    extract(epoch from (max(closed_at) - min(opened_at))) / 86400
  ) as trades_per_day,
  sum(coalesce(
    nullif(metadata ->> 'notional_quote', '')::numeric,
    realized_cost_quote
  )) as turnover_entry_notional,
  sum(realized_pnl_quote) as position_ledger_fee_net_quote,
  sum(base_pnl) as base_overlay_quote,
  sum(stress_pnl) as stress_overlay_quote,
  min(net_dd) as realized_max_drawdown_quote,
  min(base_dd) as base_max_drawdown_quote,
  min(stress_dd) as stress_max_drawdown_quote
from drawdown;
