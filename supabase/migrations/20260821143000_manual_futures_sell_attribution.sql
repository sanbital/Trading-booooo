-- Manual Binance Futures exits must remain part of the bot position ledger.
--
-- The exchange sync already supplies a temporal fallback position_id for manual
-- futures SELL fills. The attribution guard used to erase that id whenever the
-- exchange order id did not belong to trading_orders, leaving the real exit as
-- UNMATCHED_INVENTORY. Preserve a safe existing attribution, infer one only from
-- positive live-at-fill inventory, and immediately settle the position from the
-- exchange fill ledger.

create or replace function public.enforce_futures_fill_order_attribution()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.trading_orders%rowtype;
  v_position_id uuid;
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
    return new;
  end if;

  new.bot_order_id := null;
  new.client_order_id := null;
  new.source := 'MANUAL';
  v_position_id := null;

  if upper(coalesce(new.side,'')) = 'SELL'
     and coalesce(new.quantity,0) > 0
     and new.executed_at is not null then

    -- Attribution is immutable across idempotent upserts, including after the
    -- position is fully closed and no positive outstanding inventory remains.
    if tg_op = 'UPDATE'
       and old.position_id is not null
       and old.exchange = 'binance_futures'
       and old.market = new.market
       and old.exchange_trade_id = new.exchange_trade_id then
      select p.id into v_position_id
      from public.trading_positions p
      where p.id = old.position_id
        and p.exchange = 'binance_futures'
        and p.market = new.market
        and coalesce(p.is_paper,false) = false
        and p.opened_at is not null
        and p.opened_at <= new.executed_at
        and (p.closed_at is null or p.closed_at >= new.executed_at)
      limit 1;
    end if;

    -- A newly supplied position id is accepted only while linked inventory is
    -- still positive at the exchange fill time.
    if v_position_id is null and new.position_id is not null then
      select p.id into v_position_id
      from public.trading_positions p
      where p.id = new.position_id
        and p.exchange = 'binance_futures'
        and p.market = new.market
        and coalesce(p.is_paper,false) = false
        and p.opened_at is not null
        and p.opened_at <= new.executed_at
        and (p.closed_at is null or p.closed_at >= new.executed_at)
        and coalesce((
          select sum(case when upper(f.side)='BUY' then f.quantity else -f.quantity end)
          from public.exchange_trade_fills f
          where f.exchange='binance_futures'
            and f.position_id=p.id
        ),0) > greatest(
          coalesce((
            select sum(f.quantity)
            from public.exchange_trade_fills f
            where f.exchange='binance_futures'
              and f.position_id=p.id
              and upper(f.side)='BUY'
          ),0) * 1e-7,
          1e-10
        )
      limit 1;
    end if;

    if v_position_id is null then
      perform pg_advisory_xact_lock(hashtext('manual-futures-sell:' || new.market));
      select p.id into v_position_id
      from public.trading_positions p
      where p.exchange = 'binance_futures'
        and p.market = new.market
        and coalesce(p.is_paper,false) = false
        and p.opened_at is not null
        and p.opened_at <= new.executed_at
        and (p.closed_at is null or p.closed_at >= new.executed_at)
        and coalesce((
          select sum(case when upper(f.side)='BUY' then f.quantity else -f.quantity end)
          from public.exchange_trade_fills f
          where f.exchange='binance_futures'
            and f.position_id=p.id
        ),0) > greatest(
          coalesce((
            select sum(f.quantity)
            from public.exchange_trade_fills f
            where f.exchange='binance_futures'
              and f.position_id=p.id
              and upper(f.side)='BUY'
          ),0) * 1e-7,
          1e-10
        )
      order by p.opened_at desc, p.created_at desc
      limit 1;
    end if;
  end if;

  new.position_id := v_position_id;
  new.accounting_status := case
    when v_position_id is not null then 'PENDING'
    else 'UNMATCHED_INVENTORY'
  end;
  return new;
end;
$function$;

create or replace function public.settle_manual_futures_sell_fill_v1()
returns trigger
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
  v_pos public.trading_positions%rowtype;
  v_last_sell_at timestamptz;
  v_manual_sell_qty numeric := 0;
  v_buy_qty numeric := 0;
begin
  if lower(coalesce(new.exchange,'')) <> 'binance_futures'
     or upper(coalesce(new.side,'')) <> 'SELL'
     or upper(coalesce(new.source,'')) <> 'MANUAL'
     or new.position_id is null then
    return new;
  end if;

  perform set_config('trading_boooo.allow_closed_rewrite','on',true);
  perform public.settle_futures_position_from_exchange_fills(new.position_id);

  select * into v_pos
  from public.trading_positions
  where id=new.position_id;

  select
    max(f.executed_at) filter (where upper(f.side)='SELL'),
    coalesce(sum(f.quantity) filter (
      where upper(f.side)='SELL' and upper(coalesce(f.source,''))='MANUAL'
    ),0),
    coalesce(sum(f.quantity) filter (where upper(f.side)='BUY'),0)
  into v_last_sell_at,v_manual_sell_qty,v_buy_qty
  from public.exchange_trade_fills f
  where f.exchange='binance_futures'
    and f.position_id=new.position_id;

  if found and v_pos.state='CLOSED' and v_manual_sell_qty > 0 then
    update public.trading_positions
       set closed_at = coalesce(v_last_sell_at, closed_at),
           close_reason = 'MANUAL_EXCHANGE_SELL',
           metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'display_data_status','MANUAL_EXCHANGE_SELL_RECONCILED',
             'manual_exit_reconciliation', jsonb_build_object(
               'revision','8.0.1-MANUAL-FUTURES-SELL-LEDGER',
               'reconciled_at',now(),
               'manual_sell_quantity',v_manual_sell_qty,
               'exchange_entry_quantity',v_buy_qty,
               'last_manual_sell_at',v_last_sell_at
             )
           ),
           updated_at=now()
     where id=new.position_id;
  end if;

  update public.exchange_trade_fills
     set accounting_status='ACCOUNTED',
         updated_at=now()
   where id=new.id
     and accounting_status is distinct from 'ACCOUNTED';

  return new;
end;
$function$;

-- Remove the short-lived redundant pre-attribution helper if this migration is
-- applied onto a database that received the production hotfix directly.
drop trigger if exists trg_attach_manual_futures_sell_fill_v1 on public.exchange_trade_fills;
drop function if exists public.attach_manual_futures_sell_fill_v1();

drop trigger if exists trg_settle_manual_futures_sell_fill_v1 on public.exchange_trade_fills;
create trigger trg_settle_manual_futures_sell_fill_v1
after insert or update of position_id on public.exchange_trade_fills
for each row execute function public.settle_manual_futures_sell_fill_v1();