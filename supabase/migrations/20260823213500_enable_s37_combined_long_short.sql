-- Explicit, auditable opt-in for the S37 SHORT half of the combined engine.
-- Existing LONG behavior and every sizing/leverage/slot setting remain unchanged.

alter table public.trading_settings
  add column if not exists binance_futures_short_enabled boolean not null default false;

comment on column public.trading_settings.binance_futures_short_enabled is
  'Allows only the exact S37-LIVE-1.0.0 Binance futures SHORT path; LONG is unaffected.';

update public.trading_settings
set binance_futures_short_enabled = true,
    updated_at = now()
where configured = true
  and mode = 'LIVE_LIMITED'
  and binance_futures_enabled = true;
