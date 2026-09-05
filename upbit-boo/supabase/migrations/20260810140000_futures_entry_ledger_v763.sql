-- Trading-booooo v7.6.3 — futures entry ledger repair.
--
-- USDⓈ-M ENTRY fills were persisted in trading_fills, but an OPEN futures position could
-- retain realized_cost_quote = 0 and paid_fees_quote = 0 until exit reconciliation. The
-- common marked-PnL helper therefore treated the whole marked contract value as profit.
-- Keep the position's entry-cost ledger synchronized from authenticated fill rows so
-- account snapshots and daily/weekly risk rails see economic PnL, not contract notional.

create or replace function public.sync_futures_entry_ledger_v763()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_position_id uuid;
  v_exchange text;
  v_side text;
  v_purpose text;
  v_entry_cost numeric;
  v_entry_fee numeric;
begin
  select o.position_id, lower(coalesce(o.exchange, '')), upper(coalesce(o.side, '')), upper(coalesce(o.purpose, ''))
  into v_position_id, v_exchange, v_side, v_purpose
  from public.trading_orders o
  where o.id = new.order_id;

  if v_position_id is null
     or v_exchange <> 'binance_futures'
     or v_side <> 'BUY'
     or v_purpose <> 'ENTRY' then
    return new;
  end if;

  select
    coalesce(sum(coalesce(f.funds_quote, f.price * f.volume, 0)), 0),
    coalesce(sum(coalesce(f.fee_quote_estimate, 0)), 0)
  into v_entry_cost, v_entry_fee
  from public.trading_fills f
  join public.trading_orders o on o.id = f.order_id
  where o.position_id = v_position_id
    and lower(coalesce(o.exchange, '')) = 'binance_futures'
    and upper(coalesce(o.side, '')) = 'BUY'
    and upper(coalesce(o.purpose, '')) = 'ENTRY';

  if v_entry_cost > 0 then
    update public.trading_positions p
    set realized_cost_quote = v_entry_cost,
        -- Never erase fees already booked by a later exit/reconciliation path.
        paid_fees_quote = greatest(coalesce(p.paid_fees_quote, 0), v_entry_fee),
        updated_at = now()
    where p.id = v_position_id
      and lower(coalesce(p.exchange, '')) = 'binance_futures'
      and p.state in ('ENTRY_PENDING', 'OPEN', 'EXITING');
  end if;

  return new;
end;
$function$;

comment on function public.sync_futures_entry_ledger_v763() is
  'Synchronizes Binance futures entry notional and entry fees from durable fills so marked PnL cannot mistake notional for profit.';

drop trigger if exists trading_fills_sync_futures_entry_ledger_v763 on public.trading_fills;
create trigger trading_fills_sync_futures_entry_ledger_v763
after insert or update of funds_quote, fee_quote_estimate, price, volume on public.trading_fills
for each row execute function public.sync_futures_entry_ledger_v763();

-- Repair any currently open/exiting futures position immediately from its persisted ENTRY fills.
with entry_ledger as (
  select
    o.position_id,
    coalesce(sum(coalesce(f.funds_quote, f.price * f.volume, 0)), 0) as entry_cost,
    coalesce(sum(coalesce(f.fee_quote_estimate, 0)), 0) as entry_fee
  from public.trading_fills f
  join public.trading_orders o on o.id = f.order_id
  join public.trading_positions p on p.id = o.position_id
  where lower(coalesce(o.exchange, '')) = 'binance_futures'
    and upper(coalesce(o.side, '')) = 'BUY'
    and upper(coalesce(o.purpose, '')) = 'ENTRY'
    and lower(coalesce(p.exchange, '')) = 'binance_futures'
    and p.state in ('ENTRY_PENDING', 'OPEN', 'EXITING')
  group by o.position_id
)
update public.trading_positions p
set realized_cost_quote = e.entry_cost,
    paid_fees_quote = greatest(coalesce(p.paid_fees_quote, 0), e.entry_fee),
    updated_at = now()
from entry_ledger e
where p.id = e.position_id
  and e.entry_cost > 0;

do $verify$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'trading_fills'
      and t.tgname = 'trading_fills_sync_futures_entry_ledger_v763'
      and not t.tgisinternal
  ) then
    raise exception 'FUTURES_ENTRY_LEDGER_TRIGGER_MISSING';
  end if;

  if exists (
    select 1
    from public.trading_positions p
    where lower(coalesce(p.exchange, '')) = 'binance_futures'
      and p.state in ('OPEN', 'EXITING')
      and coalesce(p.initial_quantity, 0) > 0
      and coalesce(p.realized_cost_quote, 0) <= 0
      and exists (
        select 1
        from public.trading_orders o
        join public.trading_fills f on f.order_id = o.id
        where o.position_id = p.id
          and upper(coalesce(o.side, '')) = 'BUY'
          and upper(coalesce(o.purpose, '')) = 'ENTRY'
      )
  ) then
    raise exception 'FUTURES_OPEN_POSITION_ENTRY_COST_NOT_REPAIRED';
  end if;
end;
$verify$;
