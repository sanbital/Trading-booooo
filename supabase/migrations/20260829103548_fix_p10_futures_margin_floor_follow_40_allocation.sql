create or replace function public.guard_p10_order_v800()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_expected_side text;
  v_expected_effect text;
  v_leverage numeric;
  v_min_margin_usdt numeric := 50;
begin
  if coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' then
    return new;
  end if;
  if new.position_id is null then
    raise exception using errcode = '23514', message = 'P10_ORDER_POSITION_REQUIRED';
  end if;
  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.strategy_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' then
    raise exception using errcode = '23514', message = 'P10_ORDER_POSITION_MISMATCH';
  end if;
  v_expected_effect := case when new.purpose = 'ENTRY' then 'OPEN' else 'CLOSE' end;
  v_expected_side := case
    when p.position_side = 'SHORT' and v_expected_effect = 'OPEN' then 'SELL'
    when p.position_side = 'SHORT' then 'BUY'
    when v_expected_effect = 'OPEN' then 'BUY'
    else 'SELL'
  end;
  if new.position_side is distinct from p.position_side or
     new.position_effect is distinct from v_expected_effect or
     new.side is distinct from v_expected_side then
    raise exception using errcode = '23514', message = 'P10_ORDER_DIRECTION_MISMATCH';
  end if;
  if p.position_side = 'SHORT' and lower(p.exchange) <> 'binance_futures' then
    raise exception using errcode = '23514', message = 'P10_SPOT_SHORT_FORBIDDEN';
  end if;
  if lower(p.exchange) = 'binance_futures' and v_expected_effect = 'OPEN' then
    v_leverage := least(20, greatest(1, coalesce(nullif(p.leverage, 0), 3)));
    select least(50::numeric, greatest(1::numeric, coalesce(nullif(ts.binance_futures_allocation_usdt, 0), 50::numeric)))
      into v_min_margin_usdt
      from public.trading_settings ts
     where ts.id = 1;
    v_min_margin_usdt := coalesce(v_min_margin_usdt, 50::numeric);
    if coalesce(new.requested_notional_quote, 0) + 0.00000001 < v_min_margin_usdt * v_leverage then
      raise exception using errcode = '23514', message = 'P10_FUTURES_ENTRY_MARGIN_BELOW_CONFIGURED_MIN_USDT';
    end if;
  end if;
  return new;
end;
$function$;