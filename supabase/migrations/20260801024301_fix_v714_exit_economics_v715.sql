-- Reconstructed from supabase_migrations.schema_migrations.statements.
-- This migration was applied directly to the database and never committed, which is how
-- v7.3.0 came to rebuild the sell guard from a stale source and silently revert it.
-- Recorded here so the repository matches what actually ran. The filename carries the
-- applied version, so a full ordered replay still ends on the newest definition.

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
  v_exit_fee_rate numeric;
  v_entry_fee_rate numeric;
  v_quote_price numeric;
  v_quote_at timestamptz;
  v_guarded_fill_price numeric;
  v_entry_cost numeric;
  v_exit_proceeds numeric;
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

  -- The first 60 seconds are an absolute bot-side sell lock.
  if v_held_seconds < 60 then
    raise exception using errcode='23514', message=format(
      'V715_PRE60_ABSOLUTE_SELL_LOCK market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

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
      'V715_EXIT_BLOCK_MISSING_ECONOMICS market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;
  if v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
    raise exception using errcode='23514', message=format(
      'V715_EXIT_BLOCK_STALE_QUOTE market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  v_exit_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  -- Binance buy commission is paid in base and is already reflected in remaining quantity/average entry.
  -- Upbit buy commission is paid in quote and must be included once.
  v_entry_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0 end;

  -- exit_policy_quote.price is already the quantity-aware executable bid/average sell price.
  -- Do not apply a second synthetic 20/50bp haircut.
  v_guarded_fill_price := v_quote_price;
  v_entry_cost := v_entry * v_qty * (1 + v_entry_fee_rate);
  v_exit_proceeds := v_guarded_fill_price * v_qty * (1 - v_exit_fee_rate);
  v_guarded_net := v_exit_proceeds - v_entry_cost;
  v_drawdown_pct := (v_quote_price / v_entry - 1) * 100;
  v_target_reached := coalesce(v_target, 0) > 0 and v_quote_price >= v_target;

  if v_held_seconds < 180 then
    if v_purpose in ('TARGET_1', 'TARGET_2') and v_target_reached and v_guarded_net > 0 then
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
      'V715_60_180_EXIT_BLOCKED market=%s purpose=%s held=%s reason=%s net=%s age=%s required=%s',
      new.market, v_purpose, round(v_held_seconds, 3), v_requested_reason,
      round(v_guarded_net, 8), round(v_soft_age, 3), round(v_soft_required, 3)
    );
  end if;

  if v_guarded_net > 0 then
    if v_purpose not in ('TARGET_1', 'TARGET_2') then
      raise exception using errcode='23514', message=format(
        'V715_POST180_PROFIT_MUST_BE_TARGET market=%s purpose=%s guarded_net=%s',
        new.market, v_purpose, round(v_guarded_net, 8)
      );
    end if;
    return new;
  end if;

  if v_drawdown_pct <= -3 then
    if v_purpose <> 'STOP' then
      raise exception using errcode='23514', message=format(
        'V715_MINUS3_EXIT_MUST_BE_STOP market=%s purpose=%s drawdown_pct=%s',
        new.market, v_purpose, round(v_drawdown_pct, 6)
      );
    end if;
    return new;
  end if;

  raise exception using errcode='23514', message=format(
    'V715_POST180_HOLD market=%s purpose=%s held=%s guarded_net=%s drawdown_pct=%s',
    new.market, v_purpose, round(v_held_seconds, 3), round(v_guarded_net, 8), round(v_drawdown_pct, 6)
  );
end;
$function$;

create or replace function public.enforce_v714_volatility_aware_position_policy()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_qty numeric;
  v_exit_fee_rate numeric;
  v_entry_fee_rate numeric;
  v_entry_cost numeric;
  v_profit_buffer_quote numeric;
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

  v_exit_fee_rate := case when lower(new.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_entry_fee_rate := case when lower(new.exchange) = 'upbit' then 0.0005 else 0 end;
  v_profit_buffer_quote := case when lower(new.exchange) = 'upbit' then 1 else 0.01 end;

  new.stop_price := v_entry * 0.97;
  new.max_holding_at := 'infinity'::timestamptz;

  if v_qty > 0 then
    v_entry_cost := v_entry * v_qty * (1 + v_entry_fee_rate);
    v_min_target := (v_entry_cost + v_profit_buffer_quote) / (v_qty * (1 - v_exit_fee_rate));
    new.target_1 := greatest(coalesce(nullif(new.target_1, 0), v_min_target), v_min_target);
    new.target_2 := greatest(coalesce(nullif(new.target_2, 0), new.target_1), new.target_1, v_min_target);
  end if;

  new.trailing_stop := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.1.5-EXECUTABLE-NET-EXIT',
    'active_exit_revision', '7.1.5-EXECUTABLE-NET-EXIT',
    'pre_60_exit_rule', 'ABSOLUTE_NO_AUTOMATED_SELL',
    'seconds_60_to_180_exit_rule', 'NET_POSITIVE_TARGET_OR_PERSISTENT_REVERSAL',
    'post_180_exit_rule', 'EXECUTABLE_NET_POSITIVE_OR_DRAWDOWN_LTE_MINUS_3PCT',
    'reversal_timer_starts_after_seconds', 60,
    'signal_reversal_required_seconds', 30,
    'lob_invalidation_required_seconds', 50,
    'hard_stop_return_pct', -3,
    'minimum_post_180_net_quote', 0,
    'target_profit_buffer_quote', v_profit_buffer_quote,
    'synthetic_exit_haircut_bps', 0,
    'entry_fee_double_count_protection', true,
    'timeout_loss_exit_enabled', false,
    'trail_exit_enabled', false,
    'lob_invalidation_exit_enabled', true,
    'policy_enforced_at', now()
  );
  return new;
end;
$function$;

-- Re-evaluate all currently open live LOB positions under the corrected economics.
update public.trading_positions
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('v715_recalculation_requested_at', now())
where is_paper is false
  and state = 'OPEN'
  and upper(coalesce(metadata#>>'{lob_signal,strategy}', metadata#>>'{scalp_signal,strategy}', '')) = 'LOB_SCALP';
