-- Upbit Boo runtime isolation bootstrap.
-- Run only after all copied Trading Boo migrations are applied to the NEW Upbit Boo Supabase project.
-- Never run this against the Original Trading Boo production project.

begin;

insert into public.trading_settings (id)
values (1)
on conflict (id) do nothing;

update public.trading_settings
set configured = false,
    mode = 'PAPER',
    pause_new_entries = false,
    emergency_liquidation = false,
    upbit_enabled = true,
    binance_enabled = false,
    updated_at = now()
where id = 1;

-- Futures support was added after the original spot schema. Keep this bootstrap compatible
-- with both schema generations while forcing it off when the column exists.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trading_settings'
      and column_name = 'binance_futures_enabled'
  ) then
    execute 'update public.trading_settings set binance_futures_enabled = false, updated_at = now() where id = 1';
  end if;
end $$;

commit;

-- Expected result: one isolated PAPER-mode Upbit lane and no Binance lane.
select id,
       configured,
       mode,
       pause_new_entries,
       emergency_liquidation,
       upbit_enabled,
       binance_enabled
from public.trading_settings
where id = 1;
