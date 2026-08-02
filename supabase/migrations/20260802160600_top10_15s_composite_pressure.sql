-- Canonical 15-second Top-10 composite-pressure admission policy.
begin;
update public.trading_settings
set
  lob_observation_window_ms = 15000,
  lob_max_gainer_rank = 10,
  lob_live_admission_revision = '7.3.7-15S-TOP10-COMPOSITE-PRESSURE',
  lob_model_revision = '7.3.7-15S-TOP10-COMPOSITE-PRESSURE',
  updated_at = now()
where id = 1;
commit;
