-- Remove unapproved hidden financial sizing caps.
-- The operator allocation controls (ALL/FIXED and reserve) are the sole exposure ceiling.

alter table public.trading_settings alter column max_position_pct set default 100;
alter table public.trading_settings alter column risk_per_trade_pct set default 100;
alter table public.trading_settings alter column max_order_krw set default 1000000000;
alter table public.trading_settings alter column max_daily_buy_krw set default 10000000000;
alter table public.trading_settings alter column max_order_usdt set default 10000000;
alter table public.trading_settings alter column max_daily_buy_usdt set default 100000000;
alter table public.trading_settings alter column scalp_per_order_pct set default 100;
alter table public.trading_settings alter column max_open_positions set default 20;
alter table public.trading_settings alter column max_open_positions_per_exchange set default 10;
alter table public.trading_settings alter column max_daily_entries set default 50;
alter table public.trading_settings alter column max_daily_entries_per_exchange set default 25;

alter table public.trading_settings drop constraint if exists trading_settings_max_position_pct_check;
alter table public.trading_settings add constraint trading_settings_max_position_pct_check check (max_position_pct between 0.1 and 100);
alter table public.trading_settings drop constraint if exists trading_settings_risk_per_trade_pct_check;
alter table public.trading_settings add constraint trading_settings_risk_per_trade_pct_check check (risk_per_trade_pct between 0.05 and 100);

update public.trading_settings
set max_position_pct = 100,
    risk_per_trade_pct = 100,
    max_order_krw = 1000000000,
    max_daily_buy_krw = 10000000000,
    max_order_usdt = 10000000,
    max_daily_buy_usdt = 100000000,
    scalp_per_order_pct = 100,
    max_open_positions = 20,
    max_open_positions_per_exchange = 10,
    max_daily_entries = 50,
    max_daily_entries_per_exchange = 25,
    scalp_max_consecutive_losses = 50,
    version = coalesce(version, 0) + 1,
    updated_at = now()
where id = 1;
