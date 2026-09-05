-- Closed-position fill reconciliation and FK checks both filter by position_id.
-- The missing covering index made the verified hotfix backfill unnecessarily slow.
create index if not exists exchange_trade_fills_position_id_idx
  on public.exchange_trade_fills (position_id);
