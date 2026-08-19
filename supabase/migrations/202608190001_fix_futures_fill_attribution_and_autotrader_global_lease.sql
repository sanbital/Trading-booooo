-- Prevent Binance futures fills from crossing position lifecycles and serialize
-- market-autotrader scan/monitor executions through one DB lease.

begin;

create table if not exists public.ops_futures_fill_attribution_audit (
  audit_id bigserial primary key,
  repaired_at timestamptz not null default now(),
  fill_id uuid not null,
  market text not null,
  exchange_trade_id bigint,
  exchange_order_id text,
  old_bot_order_id uuid,
  old_position_id uuid,
  new_bot_order_id uuid,
  new_position_id uuid,
  old_row jsonb not null
);

create or replace function public.enforce_futures_fill_order_attribution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.trading_orders%rowtype;
begin
  if new.exchange <> 'binance_futures' then
    return new;
  end if;

  select o.* into v_order
  from public.trading_orders o
  where o.exchange = 'binance_futures'
    and o.market = new.market
    and o.exchange_order_id is not null
    and o.exchange_order_id = new.exchange_order_id
  order by o.created_at desc
  limit 1;

  if found then
    new.bot_order_id := v_order.id;
    new.position_id := v_order.position_id;
    new.client_order_id := coalesce(nullif(new.client_order_id, ''), v_order.identifier);
    new.source := 'AUTOMATED';
    if new.position_id is not null then
      new.accounting_status := 'PENDING';
    end if;
  else
    -- Never infer a futures lifecycle from symbol/time alone. An unmatched fill
    -- stays unassigned until an exact exchange-order link exists.
    new.bot_order_id := null;
    new.position_id := null;
    new.source := 'MANUAL';
    new.accounting_status := 'UNMATCHED_INVENTORY';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_futures_fill_order_attribution
  on public.exchange_trade_fills;
create trigger trg_enforce_futures_fill_order_attribution
before insert or update of exchange_order_id, bot_order_id, position_id
on public.exchange_trade_fills
for each row
execute function public.enforce_futures_fill_order_attribution();

create or replace function public.acquire_trading_lease(
  p_name text,
  p_owner uuid,
  p_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := case
    when p_name in ('autotrader-monitor', 'autotrader-scan') then 'autotrader-engine'
    else p_name
  end;
begin
  insert into public.trading_leases(name, owner, acquired_at, expires_at)
  values (
    v_name,
    p_owner,
    now(),
    now() + make_interval(secs => greatest(10, p_seconds))
  )
  on conflict (name) do update
    set owner = excluded.owner,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    where public.trading_leases.expires_at < now()
       or public.trading_leases.owner = excluded.owner;

  return exists (
    select 1
    from public.trading_leases
    where name = v_name and owner = p_owner
  );
end;
$$;

create or replace function public.release_trading_lease(
  p_name text,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := case
    when p_name in ('autotrader-monitor', 'autotrader-scan') then 'autotrader-engine'
    else p_name
  end;
begin
  delete from public.trading_leases
  where name = v_name and owner = p_owner;
  return found;
end;
$$;

commit;
