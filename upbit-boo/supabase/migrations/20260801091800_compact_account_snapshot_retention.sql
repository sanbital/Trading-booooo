-- Compact account snapshot retention without touching live trading reads.
-- Raw JSON snapshots remain available for 26 hours; numeric hourly summaries remain for 30 days.
-- Cleanup only removes raw rows whose hourly summary already exists, in 250-row SKIP LOCKED batches.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create schema if not exists trading_internal;
revoke all on schema trading_internal from public;
revoke all on schema trading_internal from anon, authenticated;

create table if not exists public.trading_account_hourly (
  exchange text not null,
  bucket_at timestamptz not null,
  captured_at timestamptz not null,
  quote_currency text not null,
  total_equity_quote numeric not null,
  available_quote numeric not null,
  locked_quote numeric not null,
  bot_open_cost_quote numeric not null,
  bot_unrealized_pnl_quote numeric not null,
  capital_base_quote numeric not null,
  managed_capital_quote numeric not null,
  managed_available_quote numeric not null,
  protected_reserve_quote numeric not null,
  allocation_mode text not null,
  source text not null,
  samples integer not null check (samples > 0),
  primary key (exchange, bucket_at)
);

comment on table public.trading_account_hourly is
  'Compact hourly account history. No balances/prices JSON. Retained for 30 days.';

alter table public.trading_account_hourly enable row level security;
revoke all on table public.trading_account_hourly from anon, authenticated;
grant select on table public.trading_account_hourly to service_role;

create or replace function trading_internal.rollup_account_hours(
  p_from timestamptz,
  p_to timestamptz
)
returns integer
language plpgsql
set search_path = pg_catalog
set statement_timeout = '15s'
as $$
declare
  v_rows integer := 0;
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'invalid rollup window';
  end if;

  with base as (
    select
      s.id,
      s.exchange,
      date_trunc('hour', s.captured_at) as bucket_at,
      s.captured_at,
      s.quote_currency,
      s.total_equity_quote,
      s.available_quote,
      s.locked_quote,
      s.bot_open_cost_quote,
      s.bot_unrealized_pnl_quote,
      s.capital_base_quote,
      s.managed_capital_quote,
      s.managed_available_quote,
      s.protected_reserve_quote,
      s.allocation_mode,
      s.source,
      count(*) over (
        partition by s.exchange, date_trunc('hour', s.captured_at)
      )::integer as samples
    from public.trading_account_snapshots s
    where s.captured_at >= p_from
      and s.captured_at < p_to
  ),
  latest as (
    select distinct on (exchange, bucket_at)
      exchange,
      bucket_at,
      captured_at,
      quote_currency,
      total_equity_quote,
      available_quote,
      locked_quote,
      bot_open_cost_quote,
      bot_unrealized_pnl_quote,
      capital_base_quote,
      managed_capital_quote,
      managed_available_quote,
      protected_reserve_quote,
      allocation_mode,
      source,
      samples
    from base
    order by exchange, bucket_at, captured_at desc, id desc
  ),
  upserted as (
    insert into public.trading_account_hourly (
      exchange,
      bucket_at,
      captured_at,
      quote_currency,
      total_equity_quote,
      available_quote,
      locked_quote,
      bot_open_cost_quote,
      bot_unrealized_pnl_quote,
      capital_base_quote,
      managed_capital_quote,
      managed_available_quote,
      protected_reserve_quote,
      allocation_mode,
      source,
      samples
    )
    select
      exchange,
      bucket_at,
      captured_at,
      quote_currency,
      total_equity_quote,
      available_quote,
      locked_quote,
      bot_open_cost_quote,
      bot_unrealized_pnl_quote,
      capital_base_quote,
      managed_capital_quote,
      managed_available_quote,
      protected_reserve_quote,
      allocation_mode,
      source,
      samples
    from latest
    on conflict (exchange, bucket_at) do update
    set
      captured_at = excluded.captured_at,
      quote_currency = excluded.quote_currency,
      total_equity_quote = excluded.total_equity_quote,
      available_quote = excluded.available_quote,
      locked_quote = excluded.locked_quote,
      bot_open_cost_quote = excluded.bot_open_cost_quote,
      bot_unrealized_pnl_quote = excluded.bot_unrealized_pnl_quote,
      capital_base_quote = excluded.capital_base_quote,
      managed_capital_quote = excluded.managed_capital_quote,
      managed_available_quote = excluded.managed_available_quote,
      protected_reserve_quote = excluded.protected_reserve_quote,
      allocation_mode = excluded.allocation_mode,
      source = excluded.source,
      samples = excluded.samples
    returning 1
  )
  select count(*)::integer into v_rows from upserted;

  return v_rows;
end;
$$;

create or replace function trading_internal.prune_account_snapshots(
  p_batch integer default 250
)
returns integer
language plpgsql
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_deleted integer := 0;
begin
  if p_batch < 1 or p_batch > 1000 then
    raise exception 'p_batch must be between 1 and 1000';
  end if;

  with doomed as (
    select s.id
    from public.trading_account_snapshots s
    where s.captured_at < now() - interval '26 hours'
      and exists (
        select 1
        from public.trading_account_hourly h
        where h.exchange = s.exchange
          and h.bucket_at = date_trunc('hour', s.captured_at)
      )
    order by s.captured_at asc, s.id asc
    limit p_batch
    for update of s skip locked
  )
  delete from public.trading_account_snapshots s
  using doomed
  where s.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function trading_internal.prune_account_hourly(
  p_batch integer default 1000
)
returns integer
language plpgsql
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_deleted integer := 0;
begin
  if p_batch < 1 or p_batch > 5000 then
    raise exception 'p_batch must be between 1 and 5000';
  end if;

  with doomed as (
    select h.exchange, h.bucket_at
    from public.trading_account_hourly h
    where h.bucket_at < date_trunc('hour', now() - interval '30 days')
    order by h.bucket_at asc, h.exchange asc
    limit p_batch
    for update skip locked
  )
  delete from public.trading_account_hourly h
  using doomed
  where h.exchange = doomed.exchange
    and h.bucket_at = doomed.bucket_at;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function trading_internal.rollup_account_hours(timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function trading_internal.prune_account_snapshots(integer)
  from public, anon, authenticated;
revoke all on function trading_internal.prune_account_hourly(integer)
  from public, anon, authenticated;

select cron.schedule(
  'trading-account-raw-retention',
  '*/5 * * * *',
  $$select trading_internal.prune_account_snapshots(250);$$
);

select cron.schedule(
  'trading-account-hourly-rollup',
  '7 * * * *',
  $$select trading_internal.rollup_account_hours(
      date_trunc('hour', now()) - interval '2 hours',
      date_trunc('hour', now())
    );$$
);

select cron.schedule(
  'trading-account-hourly-retention',
  '17 3 * * *',
  $$select trading_internal.prune_account_hourly(1000);$$
);

select cron.schedule(
  'trading-cron-log-retention',
  '47 3 * * *',
  $$delete from cron.job_run_details
    where end_time < now() - interval '7 days';$$
);
