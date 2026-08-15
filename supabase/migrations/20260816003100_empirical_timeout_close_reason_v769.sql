-- Evidence-only repair: LAUSDT exceeded pinned 600s timeout; live exit labels collapsed to STOP. No entry/TP/SL/EV changes.

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
  v_pre_t1_protected_stop numeric;
  v_absolute_max_holding_seconds numeric;
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
      'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'PRE_T1_PROFIT_PROTECTION_EXIT',
      'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT'
    ) then p.metadata->>'pending_exit_reason'
    else coalesce(
      nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
      nullif(p.metadata->>'pending_exit_reason', ''),
      ''
    )
  end;
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));
  v_held_seconds := greatest(0, extract(epoch from (now() - coalesce(p.opened_at, p.created_at, now()))));
  v_absolute_max_holding_seconds := greatest(1, coalesce(nullif(p.metadata->>'absolute_max_holding_seconds', '')::numeric, 600));
  v_executable_net_allowed := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,executable_net_allowed}', '')::boolean,
    nullif(p.metadata#>>'{exit_policy_quote,allowed}', '')::boolean,
    false
  );
  v_expected_net_profit_quote := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,expected_net_profit_quote}', '')::numeric,
    0
  );
  v_pre_t1_protected_stop := coalesce(
    nullif(p.metadata#>>'{profit_protection,protected_stop_price}', '')::numeric,
    0
  );

  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif v_approved_reason in ('HALF_HOLD_ABSOLUTE_TIMEOUT', 'POST180_MAX_HOLD_TIMEOUT') then
    if v_held_seconds + 0.001 < v_absolute_max_holding_seconds then
      raise exception using errcode='23514', message=format('ABSOLUTE_TIMEOUT_TOO_EARLY market=%s held_seconds=%s required_seconds=%s', p.market, round(v_held_seconds,3), round(v_absolute_max_holding_seconds,3));
    end if;
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
    if v_approved_reason = 'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT' then
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

create or replace function public.normalize_lob_exit_reason_v704(p_raw text,p_fallback text)
returns text language sql immutable parallel safe as $$
select case
  when upper(coalesce(p_raw,'')) in ('HALF_HOLD_ABSOLUTE_TIMEOUT','POST180_MAX_HOLD_TIMEOUT') or upper(coalesce(p_raw,'')) like '%ABSOLUTE_TIMEOUT%' then 'TIMEOUT'
  when upper(coalesce(p_raw,'')) in ('HALF_HOLD_TAKE_PROFIT_5','FUTURES_HALF_TAKE_PROFIT_ROE_15') then 'TARGET_1'
  when upper(coalesce(p_raw,'')) in ('RESIDUAL_TAKE_PROFIT_10','FUTURES_RESIDUAL_TAKE_PROFIT_ROE_30') then 'TARGET_2'
  when upper(coalesce(p_raw,'')) in ('PRE_T1_PROFIT_PROTECTION_EXIT','FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT') then 'PROFIT_PROTECTION'
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
$$;
