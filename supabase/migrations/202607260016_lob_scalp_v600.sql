-- Trading-booooo v6.0.0-LOB — order-book-authoritative ultra-short spot scalper.
-- Deployment intentionally returns to PAPER. LIVE_LIMITED is not activated by this migration.

alter table public.trading_settings
  add column if not exists lob_max_holding_seconds integer not null default 180,
  add column if not exists lob_absolute_max_holding_seconds integer not null default 300,
  add column if not exists lob_scan_interval_seconds integer not null default 15,
  add column if not exists lob_min_net_ev_bps numeric not null default 0.01,
  add column if not exists lob_max_book_age_ms integer not null default 2500,
  add column if not exists lob_max_spread_bps numeric not null default 30,
  add column if not exists lob_min_bid_depth_ratio numeric not null default 0.35;

alter table public.trading_settings drop constraint if exists trading_settings_strategy_check;
alter table public.trading_settings add constraint trading_settings_strategy_check
  check (strategy in ('TREND', 'SCALP', 'LOB_SCALP')) not valid;
alter table public.trading_settings validate constraint trading_settings_strategy_check;

alter table public.trading_settings drop constraint if exists trading_settings_scalp_strategy_profile_ck;
alter table public.trading_settings add constraint trading_settings_scalp_strategy_profile_ck
  check (scalp_strategy_profile in ('LOB_SCALP','HF_SCALP','INTRADAY_SCALP')) not valid;
alter table public.trading_settings validate constraint trading_settings_scalp_strategy_profile_ck;

alter table public.trading_settings drop constraint if exists trading_settings_full_scan_interval_seconds_check;
alter table public.trading_settings add constraint trading_settings_full_scan_interval_seconds_check
  check (full_scan_interval_seconds between 10 and 3600) not valid;
alter table public.trading_settings validate constraint trading_settings_full_scan_interval_seconds_check;


-- Remove legacy throughput ceilings that conflict with the user's unlimited-trade policy.
-- Technical rate limits and duplicate/reconciliation guards remain enforced by runtime code.
alter table public.trading_settings drop constraint if exists trading_settings_max_daily_entries_check;
alter table public.trading_settings add constraint trading_settings_max_daily_entries_check
  check (max_daily_entries between 1 and 1000000) not valid;
alter table public.trading_settings validate constraint trading_settings_max_daily_entries_check;

alter table public.trading_settings drop constraint if exists trading_settings_max_daily_entries_per_exchange_check;
alter table public.trading_settings add constraint trading_settings_max_daily_entries_per_exchange_check
  check (max_daily_entries_per_exchange between 1 and 1000000) not valid;
alter table public.trading_settings validate constraint trading_settings_max_daily_entries_per_exchange_check;

alter table public.trading_settings drop constraint if exists trading_settings_entry_ttl_seconds_check;
alter table public.trading_settings add constraint trading_settings_entry_ttl_seconds_check
  check (entry_ttl_seconds between 5 and 900) not valid;
alter table public.trading_settings validate constraint trading_settings_entry_ttl_seconds_check;

alter table public.trading_settings drop constraint if exists trading_settings_monitor_interval_seconds_check;
alter table public.trading_settings add constraint trading_settings_monitor_interval_seconds_check
  check (monitor_interval_seconds between 5 and 300) not valid;
alter table public.trading_settings validate constraint trading_settings_monitor_interval_seconds_check;

alter table public.trading_settings drop constraint if exists trading_settings_max_new_entries_per_scan_ck;
alter table public.trading_settings add constraint trading_settings_max_new_entries_per_scan_ck
  check (max_new_entries_per_scan between 1 and 20) not valid;
alter table public.trading_settings validate constraint trading_settings_max_new_entries_per_scan_ck;

alter table public.trading_settings drop constraint if exists trading_settings_scalp_holding_ck;
alter table public.trading_settings add constraint trading_settings_scalp_holding_ck
  check (scalp_average_holding_minutes between 0.1 and 1440) not valid;
alter table public.trading_settings validate constraint trading_settings_scalp_holding_ck;

alter table public.trading_settings drop constraint if exists trading_settings_lob_holding_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_scan_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_cost_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_book_ck;
alter table public.trading_settings add constraint trading_settings_lob_holding_ck
  check (lob_max_holding_seconds between 1 and 300 and lob_absolute_max_holding_seconds between lob_max_holding_seconds and 300) not valid,
  add constraint trading_settings_lob_scan_ck
  check (lob_scan_interval_seconds between 10 and 60) not valid,
  add constraint trading_settings_lob_cost_ck
  check (lob_min_net_ev_bps between 0 and 100) not valid,
  add constraint trading_settings_lob_book_ck
  check (lob_max_book_age_ms between 100 and 10000 and lob_max_spread_bps between 1 and 100 and lob_min_bid_depth_ratio between 0.05 and 1) not valid;
alter table public.trading_settings validate constraint trading_settings_lob_holding_ck;
alter table public.trading_settings validate constraint trading_settings_lob_scan_ck;
alter table public.trading_settings validate constraint trading_settings_lob_cost_ck;
alter table public.trading_settings validate constraint trading_settings_lob_book_ck;

-- Defaults for a freshly inserted singleton settings row.
alter table public.trading_settings alter column strategy set default 'LOB_SCALP';
alter table public.trading_settings alter column scalp_strategy_profile set default 'LOB_SCALP';
alter table public.trading_settings alter column max_daily_entries set default 1000000;
alter table public.trading_settings alter column max_daily_entries_per_exchange set default 1000000;
alter table public.trading_settings alter column max_new_entries_per_scan set default 20;
alter table public.trading_settings alter column full_scan_interval_seconds set default 15;
alter table public.trading_settings alter column monitor_interval_seconds set default 5;
alter table public.trading_settings alter column entry_ttl_seconds set default 20;
alter table public.trading_settings alter column scalp_daily_loss_pct set default 30;
alter table public.trading_settings alter column scalp_max_single_loss_pct set default 5;
alter table public.trading_settings alter column scalp_max_holding_minutes set default 3;
alter table public.trading_settings alter column scalp_safety_ttl_minutes set default 5;

-- User-selected absolute risk ceilings. No daily trade-count cap is applied by LOB_SCALP.
update public.trading_settings
   set strategy = 'LOB_SCALP',
       scalp_strategy_profile = 'LOB_SCALP',
       scalp_daily_loss_pct = 30,
       scalp_max_single_loss_pct = 5,
       scalp_max_holding_minutes = 3,
       scalp_safety_ttl_minutes = 5,
       scalp_average_holding_minutes = 2,
       scalp_size_fraction = 1,
       scalp_rate_relaxation = 0,
       scalp_exploration_per_day = 0,
       scalp_exploration_per_scan = 0,
       lob_max_holding_seconds = 180,
       lob_absolute_max_holding_seconds = 300,
       lob_scan_interval_seconds = 15,
       full_scan_interval_seconds = 15,
       monitor_interval_seconds = 5,
       entry_ttl_seconds = 20,
       max_new_entries_per_scan = 20,
       max_daily_entries = 1000000,
       max_daily_entries_per_exchange = 1000000,
       mode = 'PAPER',
       version = coalesce(version, 0) + 1,
       updated_at = now()
 where id = 1;
