-- Trading-booooo — separate lifecycle PnL from pure unrealized PnL on account snapshots.
--
-- `bot_unrealized_pnl_quote` was written from the exposure ledger's marked NET figure, which
-- adds realized proceeds from partial exits to the marked remainder. On a position that had
-- already taken its T1 partial, that reported booked profit as if it were the value of the
-- contracts still open. The column now carries only side-aware (mark − entry) × remaining
-- quantity; the combined figure moves here so nothing that reads it is lost.
--
-- Additive and nullable: every existing reader keeps working, and rows written before the
-- engine deploy simply carry NULL.
alter table public.trading_account_snapshots
  add column if not exists bot_open_lifecycle_pnl_quote numeric;

comment on column public.trading_account_snapshots.bot_unrealized_pnl_quote is
  'Pure mark-to-market PnL of the remaining quantity only: side-aware (mark - entry) * remaining_quantity. Realized partial take-profit is never included.';

comment on column public.trading_account_snapshots.bot_open_lifecycle_pnl_quote is
  'Pure unrealized PnL plus the realized PnL already booked on those still-open rows. The lifecycle value of the open book, not its mark-to-market value.';
