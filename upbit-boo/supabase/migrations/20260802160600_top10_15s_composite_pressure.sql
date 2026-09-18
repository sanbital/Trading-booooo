-- Canonical 15-second Top-10 composite-pressure admission policy.
-- The previous v7.0.5 constraint only admitted the legacy long observation window.
alter table public.trading_settings
  drop constraint if exists trading_settings_lob_observation_v705;

alter table public.trading_settings
  add constraint trading_settings_lob_observation_v705
  check (lob_observation_window_ms between 15000 and 60000);

update public.trading_settings
set
  lob_observation_window_ms = 15000,
  lob_max_gainer_rank = 10,
  lob_live_admission_revision = '7.3.7-15S-TOP10-COMPOSITE-PRESSURE',
  lob_model_revision = '7.3.7-15S-TOP10-COMPOSITE-PRESSURE',
  updated_at = now()
where id = 1;
