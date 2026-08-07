-- Canonical automated-trade notification outbox.
--
-- Production already applied this migration directly. Keeping it in git removes
-- schema drift and makes preview/new environments reproduce the live outbox.

create table if not exists public.trade_notification_outbox (
  id bigint generated always as identity primary key,
  bot_order_id uuid not null unique references public.trading_orders(id) on delete cascade,
  position_id uuid references public.trading_positions(id) on delete set null,
  exchange text not null,
  market text not null,
  side text not null check (side in ('BUY', 'SELL')),
  event_type text not null check (event_type in ('BUY', 'SELL_PARTIAL', 'SELL_CLOSE')),
  first_fill_at timestamptz not null,
  last_fill_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  send_attempts integer not null default 0,
  last_error text
);

create index if not exists trade_notification_outbox_pending_idx
  on public.trade_notification_outbox (sent_at, updated_at)
  where sent_at is null;

alter table public.trade_notification_outbox enable row level security;
revoke all on table public.trade_notification_outbox from public, anon, authenticated;
grant all on table public.trade_notification_outbox to service_role;

create or replace function public.enqueue_trade_notification_outbox()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.trading_orders%rowtype;
  v_event_type text;
begin
  if new.source <> 'AUTOMATED'
     or new.bot_order_id is null
     or new.position_id is null
     or new.accounting_status <> 'ACCOUNTED' then
    return new;
  end if;

  select * into v_order
  from public.trading_orders
  where id = new.bot_order_id;

  if not found then
    return new;
  end if;

  if new.side = 'BUY' then
    v_event_type := 'BUY';
  elsif new.side = 'SELL' then
    if coalesce(new.inventory_quantity_after, 0) <= 0 then
      v_event_type := 'SELL_CLOSE';
    else
      v_event_type := 'SELL_PARTIAL';
    end if;
  else
    return new;
  end if;

  insert into public.trade_notification_outbox (
    bot_order_id,
    position_id,
    exchange,
    market,
    side,
    event_type,
    first_fill_at,
    last_fill_at,
    updated_at
  ) values (
    new.bot_order_id,
    new.position_id,
    new.exchange,
    new.market,
    new.side,
    v_event_type,
    new.executed_at,
    new.executed_at,
    now()
  )
  on conflict (bot_order_id) do update set
    position_id = excluded.position_id,
    exchange = excluded.exchange,
    market = excluded.market,
    side = excluded.side,
    event_type = case
      when public.trade_notification_outbox.event_type = 'SELL_CLOSE' then 'SELL_CLOSE'
      when excluded.event_type = 'SELL_CLOSE' then 'SELL_CLOSE'
      else excluded.event_type
    end,
    first_fill_at = least(public.trade_notification_outbox.first_fill_at, excluded.first_fill_at),
    last_fill_at = greatest(public.trade_notification_outbox.last_fill_at, excluded.last_fill_at),
    updated_at = now();

  return new;
end;
$$;

revoke all on function public.enqueue_trade_notification_outbox() from public, anon, authenticated;

drop trigger if exists trg_exchange_trade_fills_notification_outbox
  on public.exchange_trade_fills;

create trigger trg_exchange_trade_fills_notification_outbox
after insert or update of accounting_status, bot_order_id, position_id, source, inventory_quantity_after
on public.exchange_trade_fills
for each row
execute function public.enqueue_trade_notification_outbox();
