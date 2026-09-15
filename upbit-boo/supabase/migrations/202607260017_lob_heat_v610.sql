-- Trading-booooo v6.1.0-HEAT — heat-first ultra-short LOB runtime settings.
-- This is a new migration because v6.0.0 migration 202607260016 may already be applied.
-- v6.2: the mode reset that used to live here was removed. Re-arming after every deploy
-- was the largest single source of idle time for a strategy built on capital turnover.
-- See 202607260019_deploy_readiness_v620.sql.

alter table public.trading_settings drop constraint if exists trading_settings_full_scan_interval_seconds_check;
alter table public.trading_settings add constraint trading_settings_full_scan_interval_seconds_check
  check (full_scan_interval_seconds between 8 and 3600) not valid;
alter table public.trading_settings validate constraint trading_settings_full_scan_interval_seconds_check;

alter table public.trading_settings drop constraint if exists trading_settings_monitor_interval_seconds_check;
alter table public.trading_settings add constraint trading_settings_monitor_interval_seconds_check
  check (monitor_interval_seconds between 1 and 300) not valid;
alter table public.trading_settings validate constraint trading_settings_monitor_interval_seconds_check;

alter table public.trading_settings drop constraint if exists trading_settings_lob_scan_ck;
alter table public.trading_settings add constraint trading_settings_lob_scan_ck
  check (lob_scan_interval_seconds between 8 and 60) not valid;
alter table public.trading_settings validate constraint trading_settings_lob_scan_ck;

alter table public.trading_settings alter column full_scan_interval_seconds set default 12;
alter table public.trading_settings alter column monitor_interval_seconds set default 2;
alter table public.trading_settings alter column lob_scan_interval_seconds set default 12;
alter table public.trading_settings alter column lob_min_net_ev_bps set default 0;
alter table public.trading_settings alter column lob_max_book_age_ms set default 5000;
alter table public.trading_settings alter column lob_max_spread_bps set default 60;
alter table public.trading_settings alter column entry_ttl_seconds set default 20;
alter table public.trading_settings alter column scalp_maker_entry_ttl_seconds set default 8;
alter table public.trading_settings alter column scalp_maker_entry_drift_ticks set default 1;

update public.trading_settings
   set strategy = 'LOB_SCALP',
       scalp_strategy_profile = 'LOB_SCALP',
       scalp_daily_loss_pct = 30,
       scalp_max_single_loss_pct = 5,
       scalp_max_holding_minutes = 3,
       scalp_safety_ttl_minutes = 5,
       lob_max_holding_seconds = 180,
       lob_absolute_max_holding_seconds = 300,
       lob_scan_interval_seconds = 12,
       lob_min_net_ev_bps = 0,
       lob_max_book_age_ms = 5000,
       lob_max_spread_bps = 60,
       full_scan_interval_seconds = 12,
       monitor_interval_seconds = 2,
       entry_ttl_seconds = 20,
       scalp_maker_entry_ttl_seconds = 8,
       scalp_maker_entry_drift_ticks = 1,
       max_new_entries_per_scan = 20,
       max_daily_entries = 1000000,
       max_daily_entries_per_exchange = 1000000,
       version = coalesce(version, 0) + 1,
       updated_at = now()
 where id = 1;
