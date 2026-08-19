-- v7.6.13: A futures order may reach EXCHANGE_DONE before the position settlement RPC
-- reconstructs accounting from authenticated exchange fills. Once that reconstruction is
-- complete, leaving the order in EXCHANGE_DONE makes a fully-settled historical SELL look
-- pending forever. Terminalize only orders whose own attributed fills prove the recorded
-- executed volume; no exchange side effect is performed here.

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
          'revision','7.6.13-FUTURES-FILL-SETTLEMENT',
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

  if v_closed then
    update public.trading_orders o
    set state='APPLIED',
        completed_at=coalesce(o.completed_at,now()),
        updated_at=now()
    where o.position_id=p_position_id
      and upper(coalesce(o.side,''))='SELL'
      and upper(coalesce(o.state,''))='EXCHANGE_DONE'
      and coalesce(o.executed_volume,0)>0
      and exists (
        select 1
        from (
          select coalesce(sum(f.quantity),0) as fill_qty
          from public.exchange_trade_fills f
          where f.exchange='binance_futures'
            and f.position_id=p_position_id
            and (
              f.bot_order_id=o.id
              or (o.exchange_order_id is not null and f.exchange_order_id=o.exchange_order_id)
            )
        ) q
        where abs(q.fill_qty-coalesce(o.executed_volume,0))
              <= greatest(1e-10,abs(coalesce(o.executed_volume,0))*1e-7)
      );
  end if;

  return jsonb_build_object(
    'ok',true,
    'closed',v_closed,
    'realized_pnl_quote',v_pnl,
    'realized_return_pct',v_return,
    'buy_quantity',v_buy_qty,
    'sell_quantity',v_sell_qty
  );
end;
$$;

-- One pre-v7.6.13 historical row is already position-settled but remained EXCHANGE_DONE.
-- Repair exactly that ledger row only after proving the closed position, full execution,
-- and exchange-fill attribution. This does not touch position PnL or submit an order.
do $$
declare
  v_order constant uuid := '1f2ab022-67e9-4b65-b522-db2093c7fa07'::uuid;
  v_position constant uuid := 'ad436603-09cf-4336-9197-93b819d49dd6'::uuid;
  v_fill_qty numeric := 0;
  v_order_qty numeric := 0;
  v_state text;
  v_pos_state text;
  v_remaining numeric;
begin
  select state,coalesce(executed_volume,0)
  into v_state,v_order_qty
  from public.trading_orders
  where id=v_order and position_id=v_position
    and upper(coalesce(side,''))='SELL'
    and purpose='STOP'
    and exchange_order_id='7850620195';

  if not found then
    raise exception 'FUTURES_TERMINALIZATION_ORDER_MISSING';
  end if;

  if upper(coalesce(v_state,''))='APPLIED' then
    return;
  end if;

  if upper(coalesce(v_state,''))<>'EXCHANGE_DONE' or abs(v_order_qty-363.2)>0.00000001 then
    raise exception 'FUTURES_TERMINALIZATION_ORDER_PRECONDITION_FAILED: state %, qty %',v_state,v_order_qty;
  end if;

  select state,coalesce(remaining_quantity,0)
  into v_pos_state,v_remaining
  from public.trading_positions
  where id=v_position and exchange='binance_futures' and market='ETHFIUSDT';

  if upper(coalesce(v_pos_state,''))<>'CLOSED' or abs(v_remaining)>0.00000001 then
    raise exception 'FUTURES_TERMINALIZATION_POSITION_PRECONDITION_FAILED: state %, remaining %',v_pos_state,v_remaining;
  end if;

  select coalesce(sum(quantity),0)
  into v_fill_qty
  from public.exchange_trade_fills
  where exchange='binance_futures'
    and position_id=v_position
    and side='SELL'
    and (bot_order_id=v_order or exchange_order_id='7850620195');

  if abs(v_fill_qty-v_order_qty)>greatest(1e-10,abs(v_order_qty)*1e-7) then
    raise exception 'FUTURES_TERMINALIZATION_FILL_PRECONDITION_FAILED: fill %, order %',v_fill_qty,v_order_qty;
  end if;

  update public.trading_orders
  set state='APPLIED',completed_at=coalesce(completed_at,now()),updated_at=now()
  where id=v_order and state='EXCHANGE_DONE';

  if not found then
    raise exception 'FUTURES_TERMINALIZATION_UPDATE_LOST_RACE';
  end if;
end $$;
