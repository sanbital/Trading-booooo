-- Missing exchange fee/price details are unknown; zero is a real monetary value.
-- Apply before V18 executor rollout. No order, position quantity, or control changes.
alter table public.v11_long_regime_positions
  alter column entry_fee_usdt drop not null,
  alter column realized_pnl_usdt drop not null;

-- Rollback keeps these columns nullable until every pending receipt is reconciled.
-- Never backfill unknown fees or PnL with zero to restore a NOT NULL constraint.
