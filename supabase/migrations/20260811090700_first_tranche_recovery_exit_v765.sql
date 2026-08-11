-- Trading-booooo v7.6.5 — first-tranche 180-minute recovery exit.
--
-- Spot and futures share the same stale-position principle:
--   * normal first-tranche TP/SL remain authoritative (+5/-4 price; +15/-12 ROE futures)
--   * if the first TP has not happened after 180 minutes, do not force a loss exit
--   * exit 100% at the first order-time executable quote whose fees/slippage-adjusted net
--     profit is strictly positive
--   * emergency liquidation always bypasses price thresholds and releases 100%

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
  v_levels record;
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
  select * into v_levels
  from public.position_exit_levels_v760(new.exchange, new.leverage, v_entry);

  new.stop_price := v_levels.stop_price;
  new.target_1 := v_levels.target_1;
  new.target_2 := null;
  new.t1_allocation_pct := 50;
  new.t1_completed := v_residual_stage;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := case
    when v_levels.futures then 4.5 / v_levels.leverage
    else 1.5
  end;
  new.metadata := (coalesce(new.metadata, '{}'::jsonb) - 'recovery_exit') || jsonb_build_object(
    'exit_policy_revision', '7.6.0-BINANCE-FUTURES',
    'exit_policy_profile', 'PROTECTED_TRAIL_RECOVERY180M_V2',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'first_tranche_ratio', 0.5,
      'residual_ratio', 0.5,
      'hard_stop_sell_fraction', 1,
      'leverage', v_levels.leverage,
      'basis', case when v_levels.futures then 'RETURN_ON_MARGIN' else 'RETURN_ON_PRICE' end,
      'first_take_profit_pct', v_levels.first_tp_pct,
      'first_stop_loss_pct', v_levels.first_sl_pct,
      'first_take_profit_roe_pct', case when v_levels.futures then 15 else null end,
      'first_stop_loss_roe_pct', case when v_levels.futures then -12 else null end,
      'residual_profit_floor_pct', case when v_levels.futures then 9 / v_levels.leverage else 3 end,
      'residual_trailing_drawdown_pct', case when v_levels.futures then 4.5 / v_levels.leverage else 1.5 end,
      'residual_profit_floor_roe_pct', case when v_levels.futures then 9 else null end,
      'residual_trailing_drawdown_roe_pct', case when v_levels.futures then 4.5 else null end,
      'residual_mode', 'PROTECTED_TRAILING',
      'residual_sell_fraction', 1,
      'stale_recovery_after_seconds', 10800,
      'stale_recovery_rule', 'FIRST_TRANCHE_EXECUTABLE_NET_POSITIVE',
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
  v_gross_roe_pct numeric;
  v_peak_price numeric;
  v_peak_return_pct numeric;
  v_peak_roe_pct numeric;
  v_protect_pct numeric;
  v_protect_roe_pct numeric;
  v_protected_qty numeric;
  v_sellable_qty numeric;
  v_requested_qty numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
  v_approved_reason text;
  v_min_exit_notional numeric;
  v_futures boolean;
  v_leverage numeric;
  v_held_seconds numeric;
  v_executable_net_allowed boolean;
  v_expected_net_profit_quote numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;
  select * into p from public.trading_positions where id = new.position_id for update;
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

  v_futures := lower(coalesce(p.exchange, '')) = 'binance_futures';
  v_leverage := case when v_futures
    then least(20, greatest(1, coalesce(nullif(p.leverage, 0), 3))) else 1 end;
  v_gross_return_pct := (v_price / v_entry - 1) * 100;
  v_gross_roe_pct := v_gross_return_pct * v_leverage;
  v_peak_price := greatest(v_price, coalesce(nullif(p.peak_price, 0), v_price));
  v_peak_return_pct := (v_peak_price / v_entry - 1) * 100;
  v_peak_roe_pct := v_peak_return_pct * v_leverage;
  v_protect_pct := greatest(3, v_peak_return_pct - 1.5);
  v_protect_roe_pct := greatest(9, v_peak_roe_pct - 4.5);
  v_step := greatest(0, coalesce(p.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, p.initial_quantity * 0.00000001);
  v_protected_qty := greatest(0, p.initial_quantity * 0.5);
  v_residual_stage := p.remaining_quantity <= v_protected_qty + v_tolerance;
  v_approved_reason := case
    when coalesce(p.metadata->>'pending_exit_reason', '') in (
      'STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M'
    ) then p.metadata->>'pending_exit_reason'
    else coalesce(
      nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
      nullif(p.metadata->>'pending_exit_reason', ''),
      ''
    )
  end;
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));
  v_held_seconds := greatest(0, extract(epoch from (now() - coalesce(p.opened_at, p.created_at, now()))));
  v_executable_net_allowed := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,executable_net_allowed}', '')::boolean,
    nullif(p.metadata#>>'{exit_policy_quote,allowed}', '')::boolean,
    false
  );
  v_expected_net_profit_quote := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,expected_net_profit_quote}', '')::numeric,
    0
  );

  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif v_residual_stage then
    if v_futures then
      if v_approved_reason <> 'FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT' then
        raise exception using errcode='23514', message=format(
          'FUTURES_PROTECTED_TRAIL_REASON_REQUIRED market=%s approved_reason=%s', p.market, v_approved_reason
        );
      end if;
      if v_gross_roe_pct > v_protect_roe_pct + 0.001 then
        raise exception using errcode='23514', message=format(
          'FUTURES_PROTECTED_TRAIL_NOT_REACHED market=%s roe=%s protect_roe=%s peak_roe=%s',
          p.market, round(v_gross_roe_pct, 6), round(v_protect_roe_pct, 6), round(v_peak_roe_pct, 6)
        );
      end if;
    else
      if v_approved_reason <> 'RESIDUAL_PROTECTED_TRAIL_EXIT' then
        raise exception using errcode='23514', message=format(
          'SPOT_PROTECTED_TRAIL_REASON_REQUIRED market=%s approved_reason=%s', p.market, v_approved_reason
        );
      end if;
      if v_gross_return_pct > v_protect_pct + 0.001 then
        raise exception using errcode='23514', message=format(
          'SPOT_PROTECTED_TRAIL_NOT_REACHED market=%s return=%s protect=%s peak=%s',
          p.market, round(v_gross_return_pct, 6), round(v_protect_pct, 6), round(v_peak_return_pct, 6)
        );
      end if;
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif v_futures then
    if v_approved_reason = 'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M' then
      if v_held_seconds < 10800 then
        raise exception using errcode='23514', message=format(
          'STALE_RECOVERY_TOO_EARLY market=%s held_seconds=%s', p.market, round(v_held_seconds, 3)
        );
      end if;
      if not v_executable_net_allowed or v_expected_net_profit_quote <= 0 then
        raise exception using errcode='23514', message=format(
          'STALE_RECOVERY_REQUIRES_POSITIVE_NET market=%s allowed=%s expected_net=%s',
          p.market, v_executable_net_allowed, round(v_expected_net_profit_quote, 8)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    elsif v_gross_roe_pct >= 14.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
    elsif v_gross_roe_pct <= -11.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity);
    else
      raise exception using errcode='23514', message=format(
        'FUTURES_FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_roe_pct=%s leverage=%s',
        p.market, round(v_gross_roe_pct, 6), v_leverage
      );
    end if;
  else
    if v_approved_reason = 'STALE_RECOVERY_NET_POSITIVE_EXIT_180M' then
      if v_held_seconds < 10800 then
        raise exception using errcode='23514', message=format(
          'STALE_RECOVERY_TOO_EARLY market=%s held_seconds=%s', p.market, round(v_held_seconds, 3)
        );
      end if;
      if not v_executable_net_allowed or v_expected_net_profit_quote <= 0 then
        raise exception using errcode='23514', message=format(
          'STALE_RECOVERY_REQUIRES_POSITIVE_NET market=%s allowed=%s expected_net=%s',
          p.market, v_executable_net_allowed, round(v_expected_net_profit_quote, 8)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    elsif v_gross_return_pct >= 4.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
    elsif v_gross_return_pct <= -3.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity);
    else
      raise exception using errcode='23514', message=format(
        'FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_return_pct=%s',
        p.market, round(v_gross_return_pct, 6)
      );
    end if;
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

comment on function public.guard_residual_sell_order_v751() is
  'v7.6.5 protected-trailing guard with 180m first-tranche executable-net recovery and emergency bypass.';

update public.trading_positions
set metadata = metadata
where state in ('OPEN','EXITING') and lower(coalesce(exchange,'')) in ('binance','binance_futures');

do $verify$
declare
  v_guard text;
  v_enforce text;
begin
  select pg_get_functiondef(p.oid) into v_guard
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='guard_residual_sell_order_v751';
  select pg_get_functiondef(p.oid) into v_enforce
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='enforce_residual_exit_position_policy_v751';
  if position('STALE_RECOVERY_NET_POSITIVE_EXIT_180M' in coalesce(v_guard,'')) = 0
     or position('FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M' in coalesce(v_guard,'')) = 0
     or position('STALE_RECOVERY_REQUIRES_POSITIVE_NET' in coalesce(v_guard,'')) = 0
     or position('EMERGENCY' in coalesce(v_guard,'')) = 0 then
    raise exception 'V765_GUARD_NOT_INSTALLED';
  end if;
  if position('stale_recovery_after_seconds' in coalesce(v_enforce,'')) = 0
     or position('PROTECTED_TRAIL_RECOVERY180M_V2' in coalesce(v_enforce,'')) = 0 then
    raise exception 'V765_POLICY_METADATA_NOT_INSTALLED';
  end if;
end;
$verify$;
