begin;

-- v7.5.3 keeps the user-selected percentage thresholds unchanged for normal trades:
--   first 50% at +5% or -4%; a +5% winner keeps residual +10% / -4%.
-- When the first tranche is instead stopped at -4%, that position enters recovery mode.
-- Its residual is authorized only when selling the whole remainder produces strictly
-- positive TOTAL position net PnL after all already-paid fees plus the new sell fee.

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

  new.stop_price := v_entry * 0.96;
  new.target_1 := v_entry * 1.05;
  new.target_2 := v_entry * 1.10;
  new.t1_allocation_pct := 50;
  new.t1_completed := v_residual_stage;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.5.3-RECOVERY-NET-POSITIVE',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'first_tranche_ratio', 0.5,
      'residual_ratio', 0.5,
      'first_take_profit_pct', 5,
      'first_stop_loss_pct', -4,
      'residual_take_profit_pct', 10,
      'residual_stop_loss_pct', -4,
      'winner_residual_mode', 'TP10_OR_SL4',
      'loss_residual_mode', 'TOTAL_NET_POSITIVE',
      'recovery_trigger_reason', 'HALF_HOLD_STOP_LOSS_4',
      'recovery_exit_reason', 'RECOVERY_NET_POSITIVE_EXIT',
      'recovery_percentage_thresholds_enabled', false,
      'residual_exit_enabled', true,
      'protected_stop_loss_enabled', true,
      'non_threshold_exit_enabled', false,
      'return_basis', 'EXECUTABLE_TOTAL_NET_PNL_AFTER_FEES_AND_SLIPPAGE_SAFETY',
      'stage', case when v_residual_stage then 'RESIDUAL' else 'FIRST_TRANCHE' end,
      'enforced_at', now()
    )
  );
  return new;
end;
$function$;

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
  v_recovery_mode boolean;
  v_approved_reason text;
  v_projected_net_pnl_quote numeric;
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
  v_recovery_mode := lower(coalesce(p.metadata#>>'{recovery_exit,enabled}', 'false')) = 'true';
  v_approved_reason := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
    nullif(p.metadata->>'pending_exit_reason', ''),
    ''
  );
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));

  if v_residual_stage then
    if v_recovery_mode then
      if v_approved_reason <> 'RECOVERY_NET_POSITIVE_EXIT' then
        raise exception using errcode='23514', message=format(
          'RECOVERY_EXIT_REASON_REQUIRED market=%s approved_reason=%s',
          p.market, v_approved_reason
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    else
      if v_net_return_pct < 9.999 and v_net_return_pct > -3.999 then
        raise exception using errcode='23514', message=format(
          'RESIDUAL_THRESHOLD_NOT_REACHED market=%s net_return_pct=%s',
          p.market, round(v_net_return_pct, 6)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    end if;
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

  if v_residual_stage and v_recovery_mode then
    v_projected_net_pnl_quote :=
      coalesce(p.realized_proceeds_quote, 0)
      + new.requested_volume * v_price * (1 - v_fee_rate)
      - coalesce(p.realized_cost_quote, 0)
      - coalesce(p.paid_fees_quote, 0);
    if v_projected_net_pnl_quote <= 0 then
      raise exception using errcode='23514', message=format(
        'RECOVERY_TOTAL_NET_NOT_POSITIVE market=%s projected_net_pnl_quote=%s',
        p.market, round(v_projected_net_pnl_quote, 8)
      );
    end if;
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

comment on function public.enforce_residual_exit_position_policy_v751() is
  'v7.5.3: first 50% TP5/SL4; +5 winner residual TP10/SL4; -4 loser residual exits at strictly positive total net PnL';
comment on function public.guard_residual_sell_order_v751() is
  'v7.5.3 guard: recovery residual requires RECOVERY_NET_POSITIVE_EXIT and projected total net PnL > 0';

update public.trading_positions
set updated_at = now()
where state in ('OPEN','EXITING')
  and coalesce(initial_quantity, 0) > 0;

do $verify$
declare
  v_guard text := pg_get_functiondef('public.guard_residual_sell_order_v751()'::regprocedure);
  v_policy text := pg_get_functiondef('public.enforce_residual_exit_position_policy_v751()'::regprocedure);
begin
  if position('RECOVERY_EXIT_REASON_REQUIRED' in v_guard) = 0 then
    raise exception 'RECOVERY_EXIT_REASON_GUARD_MISSING';
  end if;
  if position('RECOVERY_TOTAL_NET_NOT_POSITIVE' in v_guard) = 0 then
    raise exception 'RECOVERY_TOTAL_NET_GUARD_MISSING';
  end if;
  if position('v_projected_net_pnl_quote <= 0' in v_guard) = 0 then
    raise exception 'RECOVERY_PROJECTED_NET_CHECK_MISSING';
  end if;
  if position('loss_residual_mode' in v_policy) = 0 or
     position('TOTAL_NET_POSITIVE' in v_policy) = 0 then
    raise exception 'RECOVERY_POSITION_POLICY_METADATA_MISSING';
  end if;
end;
$verify$;

commit;
