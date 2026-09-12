create or replace function public.enforce_position_ops_metrics()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cfg public.trading_ops_invariants%rowtype;
  entry_price numeric;
  peak_ret numeric;
  realized_ret numeric;
  v_leverage numeric := 1;
begin
  select * into cfg from public.trading_ops_invariants where id = 1;
  if not found then raise exception 'trading_ops_invariants row 1 missing'; end if;

  if new.opened_at is not null and new.state in ('ENTRY_PENDING','OPEN','EXITING','RECONCILING') then
    new.absolute_max_holding_at := new.opened_at + make_interval(secs => cfg.absolute_max_holding_seconds);
    new.max_holding_at := new.absolute_max_holding_at;
    new.metadata := coalesce(new.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'absolute_max_holding_seconds', cfg.absolute_max_holding_seconds,
        'absolute_max_holding_at', new.absolute_max_holding_at,
        'engine_revision_guard', cfg.canonical_engine_revision,
        'absolute_timeout_revision', '7.4.0-ABSOLUTE-600S'
      );
  end if;

  if lower(coalesce(new.exchange,'')) = 'binance_futures' then
    v_leverage := greatest(1, coalesce(nullif(new.leverage,0), 3));
  end if;

  entry_price := nullif(new.average_entry_price, 0);
  if entry_price is not null and new.peak_price is not null then
    peak_ret := ((new.peak_price / entry_price) - 1) * 100 * v_leverage;
    new.peak_return_pct := peak_ret;
  end if;

  if new.realized_cost_quote is not null and new.realized_cost_quote > 0
     and new.realized_pnl_quote is not null then
    realized_ret := (new.realized_pnl_quote / (new.realized_cost_quote / v_leverage)) * 100;
    new.realized_return_pct := realized_ret;
  end if;

  if peak_ret is not null and realized_ret is not null then
    new.profit_giveback_pct := greatest(0, peak_ret - realized_ret);
    new.profit_giveback_bps := greatest(0, peak_ret - realized_ret) * 100;
    new.mfe_capture_ratio := case when peak_ret > 0 then realized_ret / peak_ret else null end;
    new.metadata := coalesce(new.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'peak_return_pct', peak_ret,
        'realized_return_pct', realized_ret,
        'profit_giveback_pct', greatest(0, peak_ret - realized_ret),
        'profit_giveback_bps', greatest(0, peak_ret - realized_ret) * 100,
        'mfe_capture_ratio', case when peak_ret > 0 then realized_ret / peak_ret else null end,
        'profit_giveback_revision', case when lower(coalesce(new.exchange,''))='binance_futures' then '7.6.3-FUTURES-MARGIN-ROE' else '7.4.0-MFE-GIVEBACK' end
      );
  end if;

  return new;
end;
$function$;

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
  v_exchange_closed_at timestamptz;
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
    coalesce(sum(coalesce(fee_quote_amount,0)) filter (where upper(side)='SELL'),0),
    max(executed_at) filter (where upper(side)='SELL')
  into v_buy_qty,v_buy_quote,v_buy_fee,v_sell_qty,v_sell_quote,v_sell_fee,v_exchange_closed_at
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

  perform set_config('trading_boooo.allow_closed_rewrite','on',true);

  update public.trading_positions
  set realized_cost_quote=v_cost,
      realized_proceeds_quote=v_sell_quote,
      paid_fees_quote=v_alloc_buy_fee + v_sell_fee,
      realized_pnl_quote=v_pnl,
      realized_return_pct=v_return,
      remaining_quantity=case when v_closed then 0 else greatest(0,v_buy_qty-v_sell_qty) end,
      state=case when v_closed then 'CLOSED' else state end,
      closed_at=case when v_closed then coalesce(v_exchange_closed_at, closed_at, now()) else closed_at end,
      close_reason=case when v_closed then 'EXCHANGE_FUTURES_FILL_RECONCILED' else close_reason end,
      metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
        'futures_fill_settlement', jsonb_build_object(
          'revision','7.6.3-FUTURES-FILL-SETTLEMENT-R3',
          'buy_quantity',v_buy_qty,
          'sell_quantity',v_sell_qty,
          'entry_price',v_entry,
          'fees_quote',v_alloc_buy_fee+v_sell_fee,
          'realized_pnl_quote',v_pnl,
          'realized_return_pct',v_return,
          'exchange_closed_at',v_exchange_closed_at,
          'settled_at',now()
        )
      ),
      updated_at=now()
  where id=p_position_id;

  return jsonb_build_object('ok',true,'closed',v_closed,'realized_pnl_quote',v_pnl,'realized_return_pct',v_return,'buy_quantity',v_buy_qty,'sell_quantity',v_sell_qty,'exchange_closed_at',v_exchange_closed_at);
end;
$$;