create index if not exists exchange_trade_fills_bot_order_notification_idx
  on public.exchange_trade_fills (bot_order_id, executed_at)
  where bot_order_id is not null;
