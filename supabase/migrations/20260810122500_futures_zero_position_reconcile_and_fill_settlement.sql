create or replace function public.settle_futures_position_from_exchange_fills(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  p public.trading_positions%rowtype;
  v_buy_qty numeric := 0;
  v_buy_quote numeric := 0;
  v_buy_fee numeric := 0;
  v_sell_qty numeric := 0;
  v_sell_quote numeric := 0;
  v_sell_fee numeric := 0;
  v_sold numeric := 0;
  v_entry numeric := 0;
  v_cost numeric := 0;
  v_alloc_buy_fee numeric := 0;
  v_pnl numeric := 0;
  v_margin_cost numeric := 0;
  v_return numeric := 0;
  v_closed boolean := false;
begin
  select * into p from public.trading_positions where id=p_position_id for update;
  if not found or lower(coalesce(p.exchange,'')) <> 'binance_futures' then
    return jsonb_build_object('ok',false,'reason','NOT_FUTURES_POSITION');
  end if;

  select
    coalesce(sum(quantity) filter (where upper(side)='BUY'),0),
    coalesce(sum(quote_amount) filter (where upper(side)='BUY'),0),
    coalesce(sum(coalesce(fee_quote_amount,0)) filter (where upper(side)='BUY'),0),
    coalesce(sum(quantity) filter (where upper(side)='SELL'),0),
    coalesce(sum(quote_amount) filter (where upper(side)='SELL'),0),
    coalesce(sum(coalesce(fee_quote_amount,0)) filter (where upper(side)='SELL'),0)
  into v_buy_qty,v_buy_quote,v_buy_fee,v_sell_qty,v_sell_quote,v_sell_fee
  from public.exchange_trade_fills
  where exchange='binance_futures' and position_id=p_position_id;

  if v_buy_qty <= 0 then
    return jsonb_build_object('ok',false,'reason','ENTRY_FILL_MISSING');
  end if;

  v_sold := least(v_buy_qty, v_sell_qty);
  v_entry := v_buy_quote / v_buy_qty;
  v_cost := v_entry * v_sold;
  v_alloc_buy_fee := case when v_buy_qty > 0 then v_buy_fee * v_sold / v_buy_qty else 0 end;
  v_pnl := v_sell_quote - v_cost - v_alloc_buy_fee - v_sell_fee;
  v_margin_cost := case when coalesce(p.leverage,1) > 0 then v_cost / p.leverage else v_cost end;
  v_return := case when v_margin_cost > 0 then v_pnl / v_margin_cost * 100 else 0 end;
  v_closed := v_sell_qty + greatest(1e-10, v_buy_qty * 1e-7) >= v_buy_qty;

  update public.trading_positions
  set realized_cost_quote=v_cost,
      realized_proceeds_quote=v_sell_quote,
      paid_fees_quote=v_alloc_buy_fee + v_sell_fee,
      realized_pnl_quote=v_pnl,
      realized_return_pct=v_return,
      remaining_quantity=case when v_closed then 0 else greatest(0,v_buy_qty-v_sell_qty) end,
      state=case when v_closed then 'CLOSED' else state end,
      closed_at=case when v_closed then coalesce(closed_at, now()) else closed_at end,
      close_reason=case when v_closed then coalesce(close_reason,'EXCHANGE_FUTURES_FILL_RECONCILED') else close_reason end,
      metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
        'futures_fill_settlement', jsonb_build_object(
          'revision','7.6.3-FUTURES-FILL-SETTLEMENT',
          'buy_quantity',v_buy_qty,
          'sell_quantity',v_sell_qty,
          'entry_price',v_entry,
          'fees_quote',v_alloc_buy_fee+v_sell_fee,
          'realized_pnl_quote',v_pnl,
          'realized_return_pct',v_return,
          'settled_at',now()
        )
      ),
      updated_at=now()
  where id=p_position_id;

  return jsonb_build_object('ok',true,'closed',v_closed,'realized_pnl_quote',v_pnl,'realized_return_pct',v_return,'buy_quantity',v_buy_qty,'sell_quantity',v_sell_qty);
end;
$$;

create or replace function public.reconcile_futures_zero_positions_from_snapshots()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  r record;
  v_recent_count integer;
  v_zero_count integer;
  v_min_snapshot timestamptz;
begin
  if lower(coalesce(new.exchange,'')) <> 'binance_futures' then return new; end if;

  for r in
    select p.id,p.base_asset,p.opened_at,p.metadata
    from public.trading_positions p
    where p.exchange='binance_futures' and p.state in ('OPEN','EXITING') and coalesce(p.remaining_quantity,0)>0
      and not exists (
        select 1 from public.trading_orders o
        where o.position_id=p.id and upper(coalesce(o.side,''))='SELL'
          and o.state not in ('APPLIED','CANCELLED','REJECTED','ERROR')
      )
  loop
    with recent as (
      select captured_at,coalesce(balances,'[]'::jsonb) balances
      from public.trading_account_snapshots
      where exchange='binance_futures' and captured_at > r.opened_at
      order by captured_at desc limit 3
    )
    select count(*),
           count(*) filter (where not exists (
             select 1 from jsonb_array_elements(recent.balances) b
             where upper(coalesce(b->>'currency',b->>'asset',''))=upper(r.base_asset)
               and (coalesce(nullif(b->>'balance','')::numeric,0)+coalesce(nullif(b->>'locked','')::numeric,0)) > 0
           )),
           min(captured_at)
    into v_recent_count,v_zero_count,v_min_snapshot
    from recent;

    if v_recent_count=3 and v_zero_count=3 and v_min_snapshot > r.opened_at then
      update public.trading_positions
      set state='CLOSED',remaining_quantity=0,reserved_quote=0,reserved_quantity=0,reservation_expires_at=null,
          closed_at=coalesce(closed_at,new.captured_at),
          close_reason=coalesce(close_reason,'EXCHANGE_FUTURES_POSITION_ZERO_RECONCILED'),
          marked_pnl_quote=null,
          metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
            'exclude_from_learning',true,
            'display_data_status','EXCHANGE_FUTURES_POSITION_ZERO_RECONCILED',
            'futures_position_reconciliation',jsonb_build_object(
              'revision','7.6.3-FUTURES-ZERO-SNAPSHOT-RECONCILE',
              'confirmed_snapshot_count',3,
              'observed_quantity',0,
              'latest_snapshot_at',new.captured_at,
              'reconciled_at',now(),
              'reason','AUTHENTICATED_FUTURES_POSITION_ZERO'
            )
          ),
          updated_at=now()
      where id=r.id and state in ('OPEN','EXITING');
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trading_account_snapshots_futures_zero_reconcile on public.trading_account_snapshots;
create trigger trading_account_snapshots_futures_zero_reconcile
after insert on public.trading_account_snapshots
for each row when (lower(coalesce(new.exchange,''))='binance_futures')
execute function public.reconcile_futures_zero_positions_from_snapshots();
