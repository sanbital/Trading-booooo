begin;

-- Replace the v7.1.3 guards so the database enforces the same state machine as the engine.
drop trigger if exists zz_trading_positions_exit_policy_v713 on public.trading_positions;
drop trigger if exists zz_trading_orders_lob_exit_guard_v713 on public.trading_orders;
drop function if exists public.enforce_v713_net1_minus3_position_policy();
drop function if exists public.guard_lob_sell_order_v713();

create or replace function public.enforce_v714_volatility_aware_position_policy()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_qty numeric;
  v_fee_rate numeric;
  v_shortfall_bps numeric;
  v_entry_cost numeric;
  v_min_target numeric;
begin
  if new.is_paper is distinct from false or new.state <> 'OPEN' then
    return new;
  end if;

  if upper(coalesce(new.metadata#>>'{lob_signal,strategy}', new.metadata#>>'{scalp_signal,strategy}', '')) <> 'LOB_SCALP' then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  v_qty := greatest(coalesce(nullif(new.remaining_quantity, 0), nullif(new.initial_quantity, 0), 0), 0);
  if coalesce(v_entry, 0) <= 0 then
    return new;
  end if;

  v_fee_rate := case when lower(new.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_shortfall_bps := case when lower(new.exchange) = 'upbit' then 20 else 50 end;

  new.stop_price := v_entry * 0.97;
  new.max_holding_at := 'infinity'::timestamptz;

  if v_qty > 0 then
    v_entry_cost := v_entry * v_qty * (1 + v_fee_rate);
    v_min_target := ((v_entry_cost + 1) / (v_qty * (1 - v_fee_rate)))
                    / (1 - v_shortfall_bps / 10000.0);
    new.target_1 := greatest(coalesce(nullif(new.target_1, 0), v_min_target), v_min_target);
    new.target_2 := greatest(coalesce(nullif(new.target_2, 0), new.target_1), new.target_1, v_min_target);
  end if;

  new.trailing_stop := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.1.4-VOLATILITY-AWARE-EXIT',
    'pre_60_exit_rule', 'TARGET_ONLY',
    'seconds_60_to_180_exit_rule', 'TARGET_OR_PERSISTENT_REVERSAL',
    'post_180_exit_rule', 'GUARDED_NET_POSITIVE_OR_DRAWDOWN_LTE_MINUS_3PCT',
    'reversal_timer_starts_after_seconds', 60,
    'signal_reversal_required_seconds', 30,
    'lob_invalidation_required_seconds', 50,
    'hard_stop_return_pct', -3,
    'minimum_post_180_net_quote', 0,
    'target_shortfall_safety_bps', v_shortfall_bps,
    'timeout_loss_exit_enabled', false,
    'trail_exit_enabled', false,
    'lob_invalidation_exit_enabled', true,
    'policy_enforced_at', now()
  );
  return new;
end;
$function$;

create trigger zz_trading_positions_exit_policy_v714
before insert or update on public.trading_positions
for each row execute function public.enforce_v714_volatility_aware_position_policy();

create or replace function public.guard_lob_sell_order_v714()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_strategy text;
  v_held_seconds numeric;
  v_entry numeric;
  v_qty numeric;
  v_fee_rate numeric;
  v_shortfall_bps numeric;
  v_quote_price numeric;
  v_quote_at timestamptz;
  v_guarded_fill_price numeric;
  v_guarded_net numeric;
  v_drawdown_pct numeric;
  v_purpose text;
  v_requested_reason text;
  v_soft_qualified boolean;
  v_soft_age numeric;
  v_soft_required numeric;
  v_target numeric;
  v_target_reached boolean;
  v_is_resting_target boolean;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  v_purpose := upper(coalesce(new.purpose, ''));
  if v_purpose = 'EMERGENCY' then
    return new;
  end if;

  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.is_paper is distinct from false then
    return new;
  end if;

  v_strategy := upper(coalesce(p.metadata#>>'{lob_signal,strategy}', p.metadata#>>'{scalp_signal,strategy}', ''));
  if v_strategy <> 'LOB_SCALP' then
    return new;
  end if;

  v_held_seconds := greatest(0, extract(epoch from (now() - coalesce(p.opened_at, p.created_at, now()))));
  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  v_qty := least(greatest(coalesce(new.requested_volume, 0), 0), greatest(coalesce(p.remaining_quantity, 0), 0));
  v_target := coalesce(nullif(p.target_1, 0), nullif(p.target_2, 0));

  -- A resting limit target may be placed at entry; it cannot fill below the approved target.
  v_is_resting_target := v_purpose in ('TARGET_1', 'TARGET_2')
    and upper(coalesce(new.order_type, '')) <> 'MARKET'
    and coalesce(new.requested_price, 0) >= coalesce(v_target, 0)
    and coalesce(v_target, 0) > 0;
  if v_is_resting_target then
    return new;
  end if;

  v_quote_price := nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric;
  v_quote_at := nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz;
  v_requested_reason := coalesce(p.metadata#>>'{exit_policy_quote,requested_reason}', '');
  v_soft_qualified := coalesce((p.metadata#>>'{exit_policy_quote,reversal_qualified}')::boolean, false);
  v_soft_age := coalesce(nullif(p.metadata#>>'{exit_policy_quote,soft_signal_age_seconds}', '')::numeric, 0);
  v_soft_required := coalesce(nullif(p.metadata#>>'{exit_policy_quote,soft_signal_required_seconds}', '')::numeric, 0);

  if coalesce(v_entry, 0) <= 0 or v_qty <= 0 or coalesce(v_quote_price, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'V714_EXIT_BLOCK_MISSING_ECONOMICS market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;
  if v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
    raise exception using errcode='23514', message=format(
      'V714_EXIT_BLOCK_STALE_QUOTE market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  v_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_shortfall_bps := case when lower(p.exchange) = 'upbit' then 20 else 50 end;
  v_guarded_fill_price := v_quote_price * (1 - v_shortfall_bps / 10000.0);
  v_guarded_net := v_guarded_fill_price * v_qty * (1 - v_fee_rate)
                   - v_entry * v_qty * (1 + v_fee_rate);
  v_drawdown_pct := (v_quote_price / v_entry - 1) * 100;
  v_target_reached := coalesce(v_target, 0) > 0 and v_quote_price >= v_target;

  if v_held_seconds < 60 then
    if v_purpose in ('TARGET_1', 'TARGET_2') and v_target_reached then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V714_PRE60_SELL_LOCK market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  if v_held_seconds < 180 then
    if v_purpose in ('TARGET_1', 'TARGET_2') and v_target_reached then
      return new;
    end if;
    if v_purpose = 'STOP'
       and v_requested_reason in ('lob:SIGNAL_REVERSAL', 'lob:LOB_INVALIDATION')
       and v_soft_qualified
       and v_soft_required in (30, 50)
       and v_soft_age >= v_soft_required then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V714_60_180_EXIT_BLOCKED market=%s purpose=%s held=%s reason=%s age=%s required=%s',
      new.market, v_purpose, round(v_held_seconds, 3), v_requested_reason,
      round(v_soft_age, 3), round(v_soft_required, 3)
    );
  end if;

  if v_guarded_net > 0 then
    if v_purpose not in ('TARGET_1', 'TARGET_2') then
      raise exception using errcode='23514', message=format(
        'V714_POST180_PROFIT_MUST_BE_TARGET market=%s purpose=%s guarded_net=%s',
        new.market, v_purpose, round(v_guarded_net, 8)
      );
    end if;
    return new;
  end if;

  if v_drawdown_pct <= -3 then
    if v_purpose <> 'STOP' then
      raise exception using errcode='23514', message=format(
        'V714_MINUS3_EXIT_MUST_BE_STOP market=%s purpose=%s drawdown_pct=%s',
        new.market, v_purpose, round(v_drawdown_pct, 6)
      );
    end if;
    return new;
  end if;

  raise exception using errcode='23514', message=format(
    'V714_POST180_HOLD market=%s purpose=%s held=%s guarded_net=%s drawdown_pct=%s',
    new.market, v_purpose, round(v_held_seconds, 3), round(v_guarded_net, 8), round(v_drawdown_pct, 6)
  );
end;
$function$;

drop trigger if exists trading_orders_target_fee_net_guard_v722 on public.trading_orders;
create trigger zz_trading_orders_lob_exit_guard_v714
before insert on public.trading_orders
for each row execute function public.guard_lob_sell_order_v714();

update public.trading_positions
set updated_at = now()
where is_paper is false and state = 'OPEN'
  and upper(coalesce(metadata#>>'{lob_signal,strategy}', metadata#>>'{scalp_signal,strategy}', '')) = 'LOB_SCALP';

update public.trading_settings
set lob_max_holding_seconds = 180,
    lob_absolute_max_holding_seconds = 180,
    lob_profit_protect_enabled = false,
    scalp_max_single_loss_pct = 3,
    version = version + 1,
    updated_at = now()
where id = 1;

commit;
