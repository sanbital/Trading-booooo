-- V17 native stop fill attribution.
--
-- The exchange-resident stop closes a position through POST /fapi/v1/algoOrder. Binance
-- executes it as a separate market order whose id is the algo's actualOrderId, and that
-- order has no row in v11_long_regime_orders -- so 20260909000000 could not attribute it.
--
-- Observed live on 2026-09-08: EGLDUSDT closed by V17_NATIVE_STOP at 5.005 produced three
-- fills (7.9 + 1.1 + 15.4 = 24.4) under exchange order 9678930536, all UNCLASSIFIED /
-- UNMATCHED_INVENTORY. The position's exitProtection journal is the only link back, so the
-- trigger now consults it before falling through to trading_orders.
--
-- Accounting only. Realised PnL was already booked correctly on the position by the
-- protection reconciler; this fixes the fill ledger's attribution labels.

create or replace function public.enforce_futures_fill_order_attribution()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_order public.trading_orders%rowtype;
  v_v17 public.v11_long_regime_orders%rowtype;
  v_v17_position uuid;
  v_position_id uuid;
begin
  if new.exchange <> 'binance_futures' then
    return new;
  end if;

  -- V17 lane first: it is the lane that currently trades this account.
  select o.* into v_v17
  from public.v11_long_regime_orders o
  where o.exchange_order_id is not null
    and o.exchange_order_id = new.exchange_order_id
    and o.symbol = new.market
  order by o.created_at desc
  limit 1;

  if found then
    new.v17_order_id := v_v17.id;
    new.v17_position_id := v_v17.position_id;
    new.client_order_id := coalesce(nullif(new.client_order_id, ''), v_v17.client_order_id);
    -- The legacy FK columns stay null: a V17 id is not a trading_orders id.
    new.bot_order_id := null;
    new.position_id := null;
    new.source := 'AUTOMATED';
    new.accounting_status := case when v_v17.position_id is not null then 'PENDING'
                                  else 'UNMATCHED_INVENTORY' end;
    return new;
  end if;

  -- An exchange-resident stop (V17_NATIVE_STOP) closes the position through
  -- /fapi/v1/algoOrder. The resulting market order carries the algo's actualOrderId and
  -- has no row in v11_long_regime_orders, so the protection journal on the position is
  -- the only link back. Verified against EGLDUSDT order 9678930536 on 2026-09-08.
  if new.exchange_order_id is not null then
    select p.id into v_v17_position
    from public.v11_long_regime_positions p
    where p.symbol = new.market
      and exists (
        select 1
        from jsonb_array_elements(
          coalesce(p.metadata->'exitProtection'->'orders', '[]'::jsonb)) o
        where o->>'actualOrderId' = new.exchange_order_id)
    order by p.updated_at desc
    limit 1;

    if v_v17_position is not null then
      -- No v17_order_id exists for a native stop; the position carries the attribution.
      new.v17_order_id := null;
      new.v17_position_id := v_v17_position;
      new.bot_order_id := null;
      new.position_id := null;
      new.source := 'AUTOMATED';
      new.accounting_status := 'PENDING';
      return new;
    end if;
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

    -- Once a manual fill has been safely attributed, keep that attribution immutable
    -- across later idempotent upserts even after the position has fully closed.
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

    -- For a newly supplied Edge position id, require positive linked inventory at
    -- the fill instant. This prevents an unrelated manual sell from being attached.
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
  -- UNPROVEN_FUTURES_SOURCE_20260908: absence of a bot match does not prove manual ownership.
  if v_position_id is null then
    new.source := 'UNCLASSIFIED';
  end if;
  new.accounting_status := case when v_position_id is not null then 'PENDING' else 'UNMATCHED_INVENTORY' end;
  return new;
end;
$function$;

-- Backfill the native stop exits that fell through before this branch existed.
update public.exchange_trade_fills f
set v17_position_id = p.id,
    source = 'AUTOMATED',
    accounting_status = 'PENDING',
    updated_at = now()
from public.v11_long_regime_positions p
where f.exchange = 'binance_futures'
  and f.bot_order_id is null
  and f.position_id is null
  and f.v17_order_id is null
  and f.v17_position_id is null
  and f.exchange_order_id is not null
  and p.symbol = f.market
  and exists (
    select 1
    from jsonb_array_elements(
      coalesce(p.metadata->'exitProtection'->'orders', '[]'::jsonb)) o
    where o->>'actualOrderId' = f.exchange_order_id);
