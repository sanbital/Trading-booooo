do $$
begin
  if to_regclass('public.trading_settings') is null then
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trading_settings'
      and column_name = 'scalp_daily_loss_pct'
  ) then
    execute 'update public.trading_settings set scalp_daily_loss_pct = 20 where id = 1';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trading_settings'
      and column_name = 'scalp_max_single_loss_pct'
  ) then
    execute 'update public.trading_settings set scalp_max_single_loss_pct = 5 where id = 1';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trading_settings'
      and column_name = 'lob_max_holding_seconds'
  ) then
    execute 'update public.trading_settings set lob_max_holding_seconds = 300 where id = 1';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trading_settings'
      and column_name = 'lob_absolute_max_holding_seconds'
  ) then
    execute 'update public.trading_settings set lob_absolute_max_holding_seconds = 300 where id = 1';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trading_settings'
      and column_name = 'version'
  ) then
    execute 'update public.trading_settings set version = coalesce(version, 0) + 1 where id = 1';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trading_settings'
      and column_name = 'updated_at'
  ) then
    execute 'update public.trading_settings set updated_at = now() where id = 1';
  end if;
end $$;
