do $$
begin
  if to_regclass('public.trading_settings') is null then return; end if;
  update public.trading_settings
  set scalp_daily_loss_pct = 20,
      scalp_max_single_loss_pct = 5,
      lob_observation_window_ms = 45000,
      lob_max_holding_seconds = 180,
      lob_absolute_max_holding_seconds = 180,
      lob_momentum_max_holding_seconds = 180,
      lob_rotation_enabled = false,
      version = coalesce(version, 0) + 1,
      updated_at = now()
  where id = 1;
end $$;
