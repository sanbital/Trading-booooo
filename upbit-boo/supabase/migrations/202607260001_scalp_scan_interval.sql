-- SCALP runtime cadence: allow and select a 60-second full scan interval.
alter table public.trading_settings
  drop constraint if exists trading_settings_full_scan_interval_seconds_check;

alter table public.trading_settings
  add constraint trading_settings_full_scan_interval_seconds_check
  check (full_scan_interval_seconds between 60 and 3600);

update public.trading_settings
set full_scan_interval_seconds = 60,
    updated_at = now(),
    version = version + 1
where id = 1
  and full_scan_interval_seconds > 60;
