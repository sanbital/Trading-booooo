-- v7.5.0: keep 50% of every position permanently; only the tradable half may exit
-- at +5% take-profit or -4% stop-loss. This database layer is the final authority,
-- so no stale runtime or emergency path can liquidate the protected half.

create or replace function public.enforce_half_hold_position_policy_v750()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(new.initial_quantity, 0) <= 0 then
    return new;
  end if;

  new.stop_price := v_entry * 0.96;
  new.target_1 := v_entry * 1.05;
  new.target_2 := null;
  new.t1_allocation_pct := 50;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.5.0-HALF-HOLD-TP5-SL4',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'protected_ratio', 0.5,
      'tradable_ratio', 0.5,
      'take_profit_pct', 5,
      'stop_loss_pct', -4,
      'protected_stop_loss_enabled', false,
      'non_threshold_exit_enabled', false,
      'enforced_at', now()
    )
  );
  return new;
end;
$function$;

drop trigger if exists zzzzz_trading_positions_half_hold_v750 on public.trading_positions;
create trigger zzzzz_trading_positions_half_hold_v750
before insert or update on public.trading_positions
for each row execute function public.enforce_half_hold_position_policy_v750();

create or replace function public.guard_half_hold_sell_order_v750()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_price numeric;
  v_quote_at timestamptz;
  v_return_pct numeric;
  v_protected_qty numeric;
  v_sellable_qty numeric;
  v_requested_qty numeric;
  v_step numeric;
  v_min_exit_notional numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select * into p
  from public.trading_positions
  where id = new.position_id
  for update;

  if not found then
    raise exception using errcode='23514', message='HALF_HOLD_POSITION_NOT_FOUND';
  end if;
  if p.state not in ('OPEN','EXITING') then
    raise exception using errcode='23514', message=format(
      'HALF_HOLD_POSITION_NOT_SELLABLE state=%s market=%s', p.state, p.market
    );
  end if;

  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(p.initial_quantity, 0) <= 0 then
    raise exception using errcode='23514', message='HALF_HOLD_INVALID_POSITION_BASIS';
  end if;

  v_price := coalesce(
    nullif(new.requested_price, 0),
    nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,executable_vwap}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,sell_price}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,executable_price}', '')::numeric
  );
  v_quote_at := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz,
    nullif(p.metadata#>>'{live_mark,measured_at}', '')::timestamptz
  );

  if coalesce(v_price, 0) <= 0 then
    raise exception using errcode='23514', message='HALF_HOLD_MISSING_EXECUTABLE_PRICE';
  end if;
  if new.requested_price is null and (v_quote_at is null or now() - v_quote_at > interval '30 seconds') then
    raise exception using errcode='23514', message='HALF_HOLD_STALE_EXECUTABLE_PRICE';
  end if;

  v_return_pct := (v_price / v_entry - 1) * 100;
  if v_return_pct < 4.999 and v_return_pct > -3.999 then
    raise exception using errcode='23514', message=format(
      'HALF_HOLD_THRESHOLD_NOT_REACHED market=%s return_pct=%s',
      p.market, round(v_return_pct, 6)
    );
  end if;

  v_protected_qty := greatest(0, p.initial_quantity * 0.5);
  v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));
  v_step := greatest(0, coalesce(p.quantity_step, 0));

  if v_step > 0 then
    v_sellable_qty := floor((v_sellable_qty + v_step * 0.000000001) / v_step) * v_step;
  end if;
  new.requested_volume := least(v_requested_qty, v_sellable_qty);

  if coalesce(new.requested_volume, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'HALF_HOLD_PROTECTED_FLOOR_REACHED market=%s protected_qty=%s remaining_qty=%s',
      p.market, v_protected_qty, p.remaining_quantity
    );
  end if;

  -- Entry sizing keeps the existing internal 90 USDT floor. Exit sizing uses the
  -- exchange's executable floor so a 50% Binance tranche is not rewritten to 100%.
  v_min_exit_notional := case when lower(p.exchange) = 'upbit' then 5000 else 5 end;
  if new.requested_volume * v_price < v_min_exit_notional then
    raise exception using errcode='23514', message=format(
      'HALF_HOLD_EXIT_BELOW_EXCHANGE_MINIMUM market=%s notional=%s minimum=%s',
      p.market, round(new.requested_volume * v_price, 8), v_min_exit_notional
    );
  end if;

  new.requested_notional_quote := new.requested_volume * v_price;
  return new;
end;
$function$;

drop trigger if exists zz_trading_orders_lob_exit_guard_v714 on public.trading_orders;
drop trigger if exists zzzzz_trading_orders_half_hold_v750 on public.trading_orders;
create trigger zzzzz_trading_orders_half_hold_v750
before insert on public.trading_orders
for each row execute function public.guard_half_hold_sell_order_v750();

update public.trading_positions
set updated_at = now()
where state in ('OPEN','EXITING');
