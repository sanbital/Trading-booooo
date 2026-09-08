-- V17 fill attribution.
--
-- Diagnosis (2026-09-08 14:17Z ~ 22:17Z, 85 futures fills):
--   * every fill carried source='UNCLASSIFIED', accounting_status='UNMATCHED_INVENTORY',
--     bot_order_id IS NULL, position_id IS NULL;
--   * 0 of 85 matched public.trading_orders, which is the only table
--     enforce_futures_fill_order_attribution() consults;
--   * 85 of 85 matched public.v11_long_regime_orders on exchange_order_id.
-- The trigger predates the V17 lane and was never taught that V17 writes its orders and
-- positions to the v11_long_regime_* tables. 'UNCLASSIFIED' is simply the column default
-- surviving the fall-through, which is why the string appears nowhere in the codebase.
--
-- exchange_trade_fills.bot_order_id and .position_id are foreign keys into
-- trading_orders / trading_positions, so a V17 id cannot be written into them. Two
-- dedicated nullable columns carry the V17 attribution instead; the legacy columns and
-- every existing consumer keep their current meaning.
--
-- This changes accounting only. It does not touch order placement, exit logic or any
-- trading decision.

alter table public.exchange_trade_fills
  add column if not exists v17_order_id uuid
    references public.v11_long_regime_orders(id) on delete set null,
  add column if not exists v17_position_id uuid
    references public.v11_long_regime_positions(id) on delete set null;

create index if not exists exchange_trade_fills_v17_position_id_idx
  on public.exchange_trade_fills (v17_position_id)
  where v17_position_id is not null;

create or replace function public.enforce_futures_fill_order_attribution()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_order public.trading_orders%rowtype;
  v_v17 public.v11_long_regime_orders%rowtype;
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

-- Backfill the fills that fell through while the trigger was unaware of the V17 lane.
-- Only rows with no legacy attribution are touched, so nothing already accounted moves.
update public.exchange_trade_fills f
set v17_order_id = o.id,
    v17_position_id = o.position_id,
    client_order_id = coalesce(nullif(f.client_order_id,''), o.client_order_id),
    source = 'AUTOMATED',
    accounting_status = case when o.position_id is not null then 'PENDING'
                             else f.accounting_status end,
    updated_at = now()
from public.v11_long_regime_orders o
where f.exchange = 'binance_futures'
  and f.bot_order_id is null
  and f.position_id is null
  and f.v17_order_id is null
  and o.exchange_order_id is not null
  and o.exchange_order_id = f.exchange_order_id
  and o.symbol = f.market;
