-- v7.0.5: prove at least 30 seconds of live book/tape coverage before an entry.
--
-- The websocket collector runs for 32 seconds because the first frame arrives after the
-- socket opens and the final frame normally precedes timer expiry. The entry engine still
-- measures the actual first-to-last frame span and rejects anything below 30 seconds.

alter table public.trading_settings
  alter column lob_observation_window_ms set default 32000,
  alter column lob_search_base_observation_ms set default 32000,
  alter column lob_search_max_observation_ms set default 32000;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_adaptive_search_v704;
alter table public.trading_settings
  drop constraint if exists trading_settings_lob_adaptive_search_v705;
alter table public.trading_settings
  drop constraint if exists trading_settings_lob_observation_v704;
alter table public.trading_settings
  drop constraint if exists trading_settings_lob_observation_v705;

update public.trading_settings
set lob_observation_window_ms = 32000,
    lob_search_base_observation_ms = 32000,
    lob_search_max_observation_ms = 32000,
    version = version + 1,
    updated_at = now()
where id = 1;

alter table public.trading_settings
  add constraint trading_settings_lob_adaptive_search_v705 check (
    lob_search_base_finalists between 4 and 20
    and lob_search_max_finalists between lob_search_base_finalists and 20
    and lob_search_base_observation_ms between 32000 and 60000
    and lob_search_max_observation_ms
      between lob_search_base_observation_ms and 60000
    and lob_search_rotation_pool between lob_search_max_finalists and 120
    and lob_search_rotation_minutes between 1 and 30
    and lob_search_state_fresh_minutes between 5 and 120
  ) not valid;

alter table public.trading_settings
  add constraint trading_settings_lob_observation_v705 check (
    lob_observation_window_ms between 32000 and 60000
    and lob_search_base_observation_ms between 32000 and 60000
    and lob_search_max_observation_ms
      between lob_search_base_observation_ms and 60000
  ) not valid;

alter table public.trading_settings
  validate constraint trading_settings_lob_adaptive_search_v705;
alter table public.trading_settings
  validate constraint trading_settings_lob_observation_v705;

comment on column public.trading_settings.lob_observation_window_ms is
  'Requested live LOB/tape collection duration. Minimum 32s provides >=30s measured coverage.';
