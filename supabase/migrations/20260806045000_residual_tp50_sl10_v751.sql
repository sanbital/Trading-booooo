-- v7.5.1: staged half-hold policy.
-- Stage 1: sell at most 50% of the original position at +5% / -4%.
-- Stage 2: once only the residual half remains, sell all residual inventory at
-- executable net +50% / -10% versus the entry price.

create or replace function public.enforce_residual_exit_position_policy_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(new.initial_quantity, 0) <= 0 then
    return new;
  end if;

  v_step := greatest(0, coalesce(new.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, new.initial_quantity * 0.00000001);
  v_residual_stage := coalesce(new.remaining_quantity, new.initial_quantity) <=
    new.initial_quantity * 0.5 + v_tolerance;

  new.stop_price := case when v_residual_stage then v_entry * 0.90 else v_entry * 0.96 end;
  new.target_1 := v_entry * 1.05;
  new.target_2 := v_entry * 1.50;
  new.t1_allocation_pct := 50;
  new.t1_completed := v_residual_stage;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.5.1-RESIDUAL-TP50-SL10',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'first_tranche_ratio', 0.5,
      'residual_ratio', 0.5,
      'first_take_profit_pct', 5,
      'first_stop_loss_pct', -4,
      'residual_take_profit_pct', 50,
      'residual_stop_loss_pct', -10,
      'residual_exit_enabled', true,
      'protected_stop_loss_enabled', true,
      'non_threshold_exit_enabled', false,
      'return_basis', 'EXECUTABLE_PRICE_NET_OF_EXIT_FEE_VS_ENTRY_PRICE',
      'stage', case when v_residual_stage then 'RESIDUAL' else 'FIRST_TRANCHE' end,
      'enforced_at', now()
    )
  );
  return new;
end;
$function$;

drop trigger if exists zzzzz_trading_positions_half_hold_v750 on public.trading_positions;
drop trigger if exists zzzzz_trading_positions_residual_exit_v751 on public.trading_positions;
create trigger zzzzz_trading_positions_residual_exit_v751
before insert or update on public.trading_positions
for each row execute function public.enforce_residual_exit_position_policy_v751();

create or replace function public.guard_residual_sell_order_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_price numeric;
  v_quote_at timestamptz;
  v_gross_return_pct numeric;
  v_net_return_pct numeric;
  v_fee_rate numeric;
  v_protected_qty numeric;
  v_sellable_qty numeric;
  v_requested_qty numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
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
    raise exception using errcode='23514', message='RESIDUAL_POLICY_POSITION_NOT_FOUND';
  end if;
  if p.state not in ('OPEN','EXITING') then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_POSITION_NOT_SELLABLE state=%s market=%s', p.state, p.market
    );
  end if;

  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(p.initial_quantity, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_INVALID_POSITION_BASIS';
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
    raise exception using errcode='23514', message='RESIDUAL_POLICY_MISSING_EXECUTABLE_PRICE';
  end if;
  if new.requested_price is null and (v_quote_at is null or now() - v_quote_at > interval '30 seconds') then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_STALE_EXECUTABLE_PRICE';
  end if;

  v_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_gross_return_pct := (v_price / v_entry - 1) * 100;
  v_net_return_pct := (v_price * (1 - v_fee_rate) / v_entry - 1) * 100;
  v_step := greatest(0, coalesce(p.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, p.initial_quantity * 0.00000001);
  v_protected_qty := greatest(0, p.initial_quantity * 0.5);
  v_residual_stage := p.remaining_quantity <= v_protected_qty + v_tolerance;
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));

  if v_residual_stage then
    if v_net_return_pct < 49.999 and v_net_return_pct > -9.999 then
      raise exception using errcode='23514', message=format(
        'RESIDUAL_THRESHOLD_NOT_REACHED market=%s net_return_pct=%s',
        p.market, round(v_net_return_pct, 6)
      );
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity);
  else
    if v_gross_return_pct < 4.999 and v_gross_return_pct > -3.999 then
      raise exception using errcode='23514', message=format(
        'FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_return_pct=%s',
        p.market, round(v_gross_return_pct, 6)
      );
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
  end if;

  if v_step > 0 then
    v_sellable_qty := floor((v_sellable_qty + v_step * 0.000000001) / v_step) * v_step;
  end if;
  new.requested_volume := least(v_requested_qty, v_sellable_qty);

  if coalesce(new.requested_volume, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_NO_AUTHORIZED_QUANTITY market=%s residual_stage=%s remaining_qty=%s',
      p.market, v_residual_stage, p.remaining_quantity
    );
  end if;

  v_min_exit_notional := case when lower(p.exchange) = 'upbit' then 5000 else 5 end;
  if new.requested_volume * v_price < v_min_exit_notional then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_EXIT_BELOW_EXCHANGE_MINIMUM market=%s notional=%s minimum=%s',
      p.market, round(new.requested_volume * v_price, 8), v_min_exit_notional
    );
  end if;

  new.requested_notional_quote := new.requested_volume * v_price;
  return new;
end;
$function$;

drop trigger if exists zzzzz_trading_orders_half_hold_v750 on public.trading_orders;
drop trigger if exists zzzzz_trading_orders_residual_exit_v751 on public.trading_orders;
create trigger zzzzz_trading_orders_residual_exit_v751
before insert on public.trading_orders
for each row execute function public.guard_residual_sell_order_v751();

update public.trading_settings
set lob_live_admission_revision = '7.5.1-RESIDUAL-TP50-SL10',
    lob_model_revision = '7.5.1-RESIDUAL-TP50-SL10',
    version = version + 1,
    updated_at = now()
where id = 1;

update public.trading_positions
set updated_at = now()
where state in ('OPEN','EXITING');
