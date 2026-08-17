-- Futures exit ownership cleanup:
--   * 180s failed mission -> permanent RECOVERY latch (runtime owns latching)
--   * RECOVERY -> full exit only on executable net profit > 0, or -12% ROE hard stop
--   * NORMAL +15% ROE -> 50% T1, then protected trailing residual
--   * NORMAL 180m empirical stale-giveback -> full exit for observed loser class
--   * t1_completed remains fill/action-derived; remaining quantity must never fabricate T1

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
  select * into v_levels
  from public.position_exit_levels_v760(new.exchange, new.leverage, v_entry);

  -- Futures T1 is an executed semantic action, not a quantity guess. The settlement RPC
  -- sets it only when p_action='TARGET_1'. Preserve that value through this BEFORE trigger.
  -- Spot keeps its legacy quantity-derived behavior in its own lane.
  v_residual_stage := case
    when v_levels.futures then coalesce(new.t1_completed, false)
    else coalesce(new.remaining_quantity, new.initial_quantity) <=
      new.initial_quantity * 0.5 + v_tolerance
  end;

  new.stop_price := v_levels.stop_price;
  new.target_1 := v_levels.target_1;
  new.target_2 := null;
  new.t1_allocation_pct := 50;
  new.t1_completed := case
    when v_levels.futures then coalesce(new.t1_completed, false)
    else v_residual_stage
  end;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := case
    when v_levels.futures then 4.5 / v_levels.leverage
    else 1.5
  end;

  -- Do NOT delete recovery_exit. It is a permanent pre-T1 state latch until the position
  -- closes. The prior trigger stripped it on every update, making runtime recovery impossible.
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.6.0-BINANCE-FUTURES',
    'exit_policy_profile', case
      when v_levels.futures then 'RECOVERY3M_GIVEBACK180M_V3'
      else 'PROTECTED_TRAIL_RECOVERY180M_V2'
    end,
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
      'recovery_latch_after_seconds', case when v_levels.futures then 180 else null end,
      'recovery_rule', case
        when v_levels.futures then 'PRE_T1_WHOLE_EXECUTABLE_NET_NONPOSITIVE_AT_3M'
        else null
      end,
      'recovery_exit_rule', case
        when v_levels.futures then 'FULL_POSITION_EXECUTABLE_NET_PNL_GT_0'
        else null
      end,
      'stale_giveback_after_seconds', case when v_levels.futures then 10800 else null end,
      'stale_giveback_min_peak_roe_pct', case
        when v_levels.futures then 2.13815789473683
        else null
      end,
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
  v_executable_net_return_pct numeric;
  v_pre_t1_protected_stop numeric;
  v_recovery_enabled boolean;
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
  -- Futures residual stage is semantic: only an actually applied TARGET_1 fill sets it.
  v_residual_stage := case
    when v_futures then coalesce(p.t1_completed, false)
    else p.remaining_quantity <= v_protected_qty + v_tolerance
  end;
  v_approved_reason := case
    when upper(coalesce(p.metadata->>'pending_exit_reason', '')) in (
      'HALF_HOLD_ABSOLUTE_TIMEOUT',
      'POST180_MAX_HOLD_TIMEOUT',
      'STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'PRE_T1_PROFIT_PROTECTION_EXIT',
      'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT',
      'FUTURES_RECOVERY_NET_POSITIVE_EXIT',
      'FUTURES_STALE_GIVEBACK_EXIT_180M'
    ) then upper(p.metadata->>'pending_exit_reason')
    else upper(coalesce(
      nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
      nullif(p.metadata->>'pending_exit_reason', ''),
      ''
    ))
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
  v_executable_net_return_pct := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,hard_stop_net_return_pct}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,fee_net_return_pct}', '')::numeric,
    0
  );
  v_pre_t1_protected_stop := coalesce(
    nullif(p.metadata#>>'{profit_protection,protected_stop_price}', '')::numeric,
    0
  );
  v_recovery_enabled := lower(coalesce(p.metadata#>>'{recovery_exit,enabled}', 'false')) = 'true';

  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif upper(coalesce(new.purpose, '')) = 'STOP'
        and not v_futures
        and v_approved_reason in ('HALF_HOLD_ABSOLUTE_TIMEOUT', 'POST180_MAX_HOLD_TIMEOUT')
        and v_held_seconds + 0.001 >= greatest(
          1,
          coalesce(nullif(p.metadata->>'absolute_max_holding_seconds', '')::numeric, 600)
        ) then
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
    if v_approved_reason = 'FUTURES_RECOVERY_NET_POSITIVE_EXIT' then
      if v_held_seconds < 180 then
        raise exception using errcode='23514', message=format(
          'FUTURES_RECOVERY_TOO_EARLY market=%s held_seconds=%s', p.market, round(v_held_seconds, 3)
        );
      end if;
      if not v_recovery_enabled then
        raise exception using errcode='23514', message=format(
          'FUTURES_RECOVERY_NOT_LATCHED market=%s', p.market
        );
      end if;
      if not v_executable_net_allowed or v_expected_net_profit_quote <= 0 then
        raise exception using errcode='23514', message=format(
          'FUTURES_RECOVERY_REQUIRES_POSITIVE_NET market=%s allowed=%s expected_net=%s',
          p.market, v_executable_net_allowed, round(v_expected_net_profit_quote, 8)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    elsif v_approved_reason = 'FUTURES_STALE_GIVEBACK_EXIT_180M' then
      if v_held_seconds < 10800 then
        raise exception using errcode='23514', message=format(
          'FUTURES_STALE_GIVEBACK_TOO_EARLY market=%s held_seconds=%s',
          p.market, round(v_held_seconds, 3)
        );
      end if;
      if v_peak_roe_pct + 0.000000001 < 2.13815789473683 then
        raise exception using errcode='23514', message=format(
          'FUTURES_STALE_GIVEBACK_PEAK_NOT_REACHED market=%s peak_roe=%s',
          p.market, round(v_peak_roe_pct, 9)
        );
      end if;
      if v_executable_net_return_pct > 0 then
        raise exception using errcode='23514', message=format(
          'FUTURES_STALE_GIVEBACK_NET_STILL_POSITIVE market=%s net_return=%s',
          p.market, round(v_executable_net_return_pct, 9)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    elsif v_approved_reason = 'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT' then
      if v_pre_t1_protected_stop <= v_entry then
        raise exception using errcode='23514', message=format(
          'FUTURES_PRE_T1_PROFIT_PROTECTION_NOT_EARNED market=%s entry=%s protected_stop=%s',
          p.market, round(v_entry, 12), round(v_pre_t1_protected_stop, 12)
        );
      end if;
      if v_price > v_pre_t1_protected_stop * 1.00001 then
        raise exception using errcode='23514', message=format(
          'FUTURES_PRE_T1_PROFIT_PROTECTION_NOT_HIT market=%s price=%s protected_stop=%s',
          p.market, round(v_price, 12), round(v_pre_t1_protected_stop, 12)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    elsif v_approved_reason = 'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M' then
      -- Legacy authorization for already-recorded historical semantics. New runtime code
      -- does not generate this reason.
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
    if v_approved_reason = 'PRE_T1_PROFIT_PROTECTION_EXIT' then
      if v_pre_t1_protected_stop <= v_entry then
        raise exception using errcode='23514', message=format(
          'PRE_T1_PROFIT_PROTECTION_NOT_EARNED market=%s entry=%s protected_stop=%s',
          p.market, round(v_entry, 12), round(v_pre_t1_protected_stop, 12)
        );
      end if;
      if v_price > v_pre_t1_protected_stop * 1.00001 then
        raise exception using errcode='23514', message=format(
          'PRE_T1_PROFIT_PROTECTION_NOT_HIT market=%s price=%s protected_stop=%s',
          p.market, round(v_price, 12), round(v_pre_t1_protected_stop, 12)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    elsif v_approved_reason = 'STALE_RECOVERY_NET_POSITIVE_EXIT_180M' then
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

create or replace function public.normalize_lob_exit_reason_v704(p_raw text, p_fallback text)
returns text
language sql
immutable parallel safe
as $function$
select case
  when upper(coalesce(p_raw,'')) in ('HALF_HOLD_ABSOLUTE_TIMEOUT','POST180_MAX_HOLD_TIMEOUT') or upper(coalesce(p_raw,'')) like '%ABSOLUTE_TIMEOUT%' then 'TIMEOUT'
  when upper(coalesce(p_raw,'')) in ('HALF_HOLD_TAKE_PROFIT_5','FUTURES_HALF_TAKE_PROFIT_ROE_15') then 'TARGET_1'
  when upper(coalesce(p_raw,'')) in ('RESIDUAL_TAKE_PROFIT_10','FUTURES_RESIDUAL_TAKE_PROFIT_ROE_30') then 'TARGET_2'
  when upper(coalesce(p_raw,'')) in ('PRE_T1_PROFIT_PROTECTION_EXIT','FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT','FUTURES_STALE_GIVEBACK_EXIT_180M') then 'PROFIT_PROTECTION'
  when upper(coalesce(p_raw,'')) in ('RESIDUAL_PROTECTED_TRAIL_EXIT','FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT') then 'TRAILING_PROFIT'
  when upper(coalesce(p_raw,'')) in ('STALE_RECOVERY_NET_POSITIVE_EXIT_180M','FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M','FUTURES_RECOVERY_NET_POSITIVE_EXIT','RECOVERY_NET_POSITIVE_EXIT') then 'RECOVERY_PROFIT'
  when upper(coalesce(p_raw,'')) in ('HALF_HOLD_STOP_LOSS_4','FUTURES_HALF_STOP_LOSS_ROE_12') or upper(coalesce(p_raw,'')) like '%MAX_SINGLE_LOSS%' then 'HARD_STOP'
  when upper(coalesce(p_raw,'')) like '%TARGET_2%' or upper(coalesce(p_fallback,''))='TARGET_2' then 'TARGET_2'
  when upper(coalesce(p_raw,'')) like '%TARGET_1%' or upper(coalesce(p_fallback,''))='TARGET_1' then 'TARGET_1'
  when upper(coalesce(p_raw,'')) like '%TARGET_HIT%' then 'TARGET'
  when upper(coalesce(p_raw,'')) like '%LOB_INVALIDATION%' then 'LOB_INVALIDATION'
  when upper(coalesce(p_raw,'')) like '%SIGNAL_REVERSAL%' then 'SIGNAL_REVERSAL'
  when upper(coalesce(p_raw,'')) like '%TIMEOUT%' or lower(coalesce(p_raw,'')) like '%maximum holding time%' then 'TIMEOUT'
  when upper(coalesce(p_raw,'')) like '%LIQUIDITY_EVENT%' or lower(coalesce(p_raw,'')) like 'rotation:%' then 'LIQUIDITY_EVENT'
  when upper(coalesce(p_raw,'')) like '%LOB_REVERSAL%' or lower(coalesce(p_raw,'')) like 'live_hold:%' then 'LOB_REVERSAL'
  when upper(coalesce(p_raw,'')) like '%RECONCILIATION%' then 'RECONCILIATION_FAILURE'
  when upper(coalesce(p_raw,'')) like '%EMERGENCY%' then 'RISK_EMERGENCY'
  when upper(coalesce(p_raw,'')) like '%STOP%' or upper(coalesce(p_fallback,''))='STOP' then 'STOP'
  else upper(coalesce(nullif(p_fallback,''),'UNKNOWN')) end
$function$;

-- Fail the migration if the state-machine invariants are not in the installed definitions.
do $verify$
declare
  v_position_guard text;
  v_sell_guard text;
begin
  select pg_get_functiondef('public.enforce_residual_exit_position_policy_v751()'::regprocedure)
    into v_position_guard;
  select pg_get_functiondef('public.guard_residual_sell_order_v751()'::regprocedure)
    into v_sell_guard;

  if v_position_guard not like '%recovery_latch_after_seconds%180%'
     or v_position_guard like '%metadata, ''{}''::jsonb) - ''recovery_exit''%'
     or v_position_guard not like '%coalesce(new.t1_completed, false)%' then
    raise exception 'FUTURES_RECOVERY3M_POSITION_GUARD_VERIFY_FAILED';
  end if;
  if v_sell_guard not like '%FUTURES_RECOVERY_NET_POSITIVE_EXIT%'
     or v_sell_guard not like '%FUTURES_STALE_GIVEBACK_EXIT_180M%'
     or v_sell_guard not like '%v_held_seconds < 180%'
     or v_sell_guard not like '%v_peak_roe_pct + 0.000000001 < 2.13815789473683%' then
    raise exception 'FUTURES_RECOVERY3M_SELL_GUARD_VERIFY_FAILED';
  end if;
end;
$verify$;
