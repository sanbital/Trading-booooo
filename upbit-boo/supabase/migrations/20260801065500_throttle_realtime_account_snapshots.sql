-- Keep the 2-second trading monitor cadence while reducing heavyweight telemetry writes.
-- Historical/backfill rows are intentionally exempt so recovery and audit imports remain exact.
create or replace function public.throttle_realtime_account_snapshots()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.captured_at < now() - interval '2 minutes' then
    return new;
  end if;

  if exists (
    select 1
    from public.trading_account_snapshots s
    where s.exchange = new.exchange
      and s.captured_at <= new.captured_at
      and s.captured_at > new.captured_at - interval '30 seconds'
  ) then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists throttle_realtime_account_snapshots
  on public.trading_account_snapshots;

create trigger throttle_realtime_account_snapshots
before insert on public.trading_account_snapshots
for each row execute function public.throttle_realtime_account_snapshots();

comment on function public.throttle_realtime_account_snapshots() is
  'Limits live account telemetry to one full JSON snapshot per exchange per 30 seconds without changing the trading monitor cadence.';
