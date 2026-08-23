-- The exchange-fill reconciliation RPC pre-dates futures SHORT support and assumes
-- BUY=entry / SELL=exit. Keep that exact LONG contract while making SHORT settlement
-- use SELL=entry / BUY=exit. This migration changes no position data.

create or replace function public.settle_futures_position_from_exchange_fills(
  p_position_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  p public.trading_positions%rowtype;
  v_position_side text;
  v_entry_side text;
  v_exit_side text;
  v_entry_qty numeric := 0;
  v_entry_quote numeric := 0;
  v_entry_fee numeric := 0;
  v_exit_qty numeric := 0;
  v_exit_quote numeric := 0;
  v_exit_fee numeric := 0;
  v_buy_qty numeric := 0;
  v_sell_qty numeric := 0;
  v_exited numeric := 0;
  v_entry_price numeric := 0;
  v_realized_entry_quote numeric := 0;
  v_realized_exit_quote numeric := 0;
  v_allocated_entry_fee numeric := 0;
  v_allocated_exit_fee numeric := 0;
  v_pnl numeric := 0;
  v_margin_cost numeric := 0;
  v_return numeric := 0;
  v_closed boolean := false;
begin
  select *
  into p
  from public.trading_positions
  where id = p_position_id
  for update;

  if not found or lower(coalesce(p.exchange, '')) <> 'binance_futures' then
    return jsonb_build_object('ok', false, 'reason', 'NOT_FUTURES_POSITION');
  end if;

  v_position_side := case
    when upper(coalesce(p.position_side, '')) = 'SHORT' then 'SHORT'
    else 'LONG'
  end;
  v_entry_side := case when v_position_side = 'SHORT' then 'SELL' else 'BUY' end;
  v_exit_side := case when v_position_side = 'SHORT' then 'BUY' else 'SELL' end;

  -- P10/S096 has an atomic direction-aware accounting owner that also updates the
  -- signal claim and pending-exit metadata. Letting this generic fallback close an
  -- in-flight P10 position first would strand that state even if its arithmetic matched.
  if coalesce(p.strategy_key, '') = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
     and upper(coalesce(p.state, '')) <> 'CLOSED' then
    return jsonb_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'P10_ACCOUNTING_OWNER',
      'position_side', v_position_side,
      'entry_side', v_entry_side,
      'exit_side', v_exit_side
    );
  end if;

  select
    coalesce(sum(f.quantity) filter (where upper(f.side) = v_entry_side), 0),
    coalesce(sum(f.quote_amount) filter (where upper(f.side) = v_entry_side), 0),
    coalesce(sum(coalesce(f.fee_quote_amount, 0)) filter (
      where upper(f.side) = v_entry_side
    ), 0),
    coalesce(sum(f.quantity) filter (where upper(f.side) = v_exit_side), 0),
    coalesce(sum(f.quote_amount) filter (where upper(f.side) = v_exit_side), 0),
    coalesce(sum(coalesce(f.fee_quote_amount, 0)) filter (
      where upper(f.side) = v_exit_side
    ), 0),
    coalesce(sum(f.quantity) filter (where upper(f.side) = 'BUY'), 0),
    coalesce(sum(f.quantity) filter (where upper(f.side) = 'SELL'), 0)
  into
    v_entry_qty,
    v_entry_quote,
    v_entry_fee,
    v_exit_qty,
    v_exit_quote,
    v_exit_fee,
    v_buy_qty,
    v_sell_qty
  from public.exchange_trade_fills f
  where f.exchange = 'binance_futures'
    and f.position_id = p_position_id;

  if v_entry_qty <= 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'ENTRY_FILL_MISSING',
      'position_side', v_position_side,
      'entry_side', v_entry_side,
      'exit_side', v_exit_side
    );
  end if;

  v_exited := least(v_entry_qty, v_exit_qty);
  v_entry_price := v_entry_quote / v_entry_qty;
  v_realized_entry_quote := v_entry_price * v_exited;
  v_realized_exit_quote := case
    when v_exit_qty > 0 then v_exit_quote * v_exited / v_exit_qty
    else 0
  end;
  v_allocated_entry_fee := v_entry_fee * v_exited / v_entry_qty;
  v_allocated_exit_fee := case
    when v_exit_qty > 0 then v_exit_fee * v_exited / v_exit_qty
    else 0
  end;
  v_pnl := case
    when v_position_side = 'SHORT'
      then v_realized_entry_quote - v_realized_exit_quote
    else v_realized_exit_quote - v_realized_entry_quote
  end - v_allocated_entry_fee - v_allocated_exit_fee;
  v_margin_cost := case
    when coalesce(p.leverage, 1) > 0
      then v_realized_entry_quote / p.leverage
    else v_realized_entry_quote
  end;
  v_return := case when v_margin_cost > 0 then v_pnl / v_margin_cost * 100 else 0 end;
  v_closed := v_exit_qty + greatest(1e-10, v_entry_qty * 1e-7) >= v_entry_qty;

  update public.trading_positions
  set realized_cost_quote = v_realized_entry_quote,
      -- For LONG this remains sale proceeds. For SHORT it is the BUY-to-close notional;
      -- realized_pnl_quote is the canonical signed economic result for both directions.
      realized_proceeds_quote = v_realized_exit_quote,
      paid_fees_quote = v_allocated_entry_fee + v_allocated_exit_fee,
      realized_pnl_quote = v_pnl,
      realized_return_pct = v_return,
      remaining_quantity = case
        when v_closed then 0
        else greatest(0, v_entry_qty - v_exit_qty)
      end,
      state = case when v_closed then 'CLOSED' else state end,
      closed_at = case when v_closed then coalesce(closed_at, now()) else closed_at end,
      close_reason = case
        when v_closed then coalesce(close_reason, 'EXCHANGE_FUTURES_FILL_RECONCILED')
        else close_reason
      end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'futures_fill_settlement', jsonb_build_object(
          'revision', '8.0.0-DIRECTION-AWARE-FUTURES-FILL-SETTLEMENT',
          'position_side', v_position_side,
          'entry_side', v_entry_side,
          'exit_side', v_exit_side,
          'entry_quantity', v_entry_qty,
          'exit_quantity', v_exit_qty,
          'buy_quantity', v_buy_qty,
          'sell_quantity', v_sell_qty,
          'entry_price', v_entry_price,
          'fees_quote', v_allocated_entry_fee + v_allocated_exit_fee,
          'realized_pnl_quote', v_pnl,
          'realized_return_pct', v_return,
          'settled_at', now()
        )
      ),
      updated_at = now()
  where id = p_position_id;

  if v_closed then
    update public.trading_orders o
    set state = 'APPLIED',
        completed_at = coalesce(o.completed_at, now()),
        updated_at = now()
    where o.position_id = p_position_id
      and upper(coalesce(o.side, '')) = v_exit_side
      and upper(coalesce(o.state, '')) = 'EXCHANGE_DONE'
      and upper(coalesce(o.purpose, '')) <> 'ENTRY'
      and (
        upper(coalesce(o.position_effect, '')) = 'CLOSE'
        or o.position_effect is null
      )
      and (
        o.position_side is null
        or upper(o.position_side) = v_position_side
      )
      and coalesce(o.executed_volume, 0) > 0
      and exists (
        select 1
        from (
          select coalesce(sum(f.quantity), 0) as fill_qty
          from public.exchange_trade_fills f
          where f.exchange = 'binance_futures'
            and f.position_id = p_position_id
            and upper(coalesce(f.side, '')) = v_exit_side
            and (
              f.bot_order_id = o.id
              or (
                o.exchange_order_id is not null
                and f.exchange_order_id = o.exchange_order_id
              )
            )
        ) attributed
        where abs(attributed.fill_qty - coalesce(o.executed_volume, 0))
          <= greatest(1e-10, abs(coalesce(o.executed_volume, 0)) * 1e-7)
      );
  end if;

  return jsonb_build_object(
    'ok', true,
    'closed', v_closed,
    'position_side', v_position_side,
    'entry_side', v_entry_side,
    'exit_side', v_exit_side,
    'entry_quantity', v_entry_qty,
    'exit_quantity', v_exit_qty,
    'realized_pnl_quote', v_pnl,
    'realized_return_pct', v_return,
    -- Preserve the legacy response keys for existing LONG callers and diagnostics.
    'buy_quantity', v_buy_qty,
    'sell_quantity', v_sell_qty
  );
end;
$function$;

comment on function public.settle_futures_position_from_exchange_fills(uuid) is
  'Direction-aware Binance USD-M fill reconciliation: LONG BUY/SELL, SHORT SELL/BUY; service role only.';

revoke all on function public.settle_futures_position_from_exchange_fills(uuid)
  from public, anon, authenticated;
grant execute on function public.settle_futures_position_from_exchange_fills(uuid)
  to service_role;
