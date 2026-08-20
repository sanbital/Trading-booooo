create or replace function public.enforce_lob_planned_stop_v724()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_strategy text;
  v_stop_text text;
  v_stop_bps numeric;
  v_entry numeric;
  v_tick numeric;
  v_planned_stop numeric;
begin
  v_strategy := upper(coalesce(
    new.metadata#>>'{lob_signal,strategy}',
    new.metadata#>>'{scalp_signal,strategy}',
    ''
  ));
  if v_strategy <> 'LOB_SCALP' then
    return new;
  end if;

  v_stop_text := coalesce(
    nullif(new.metadata#>>'{lob_signal,stop_bps}', ''),
    nullif(new.metadata#>>'{scalp_signal,stop_bps}', '')
  );
  if v_stop_text is null or v_stop_text !~ '^[0-9]+([.][0-9]+)?$' then
    return new;
  end if;

  v_stop_bps := v_stop_text::numeric;
  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  v_tick := nullif(new.tick_size, 0);

  if v_stop_bps < 6 or v_stop_bps > 200 or coalesce(v_entry, 0) <= 0 or coalesce(v_tick, 0) <= 0 then
    return new;
  end if;

  v_planned_stop := floor((v_entry * (1 - v_stop_bps / 10000)) / v_tick) * v_tick;
  if v_planned_stop > 0 then
    -- Long-only spot route: a higher stop is tighter. Never allow the legacy -3%/-5%
    -- emergency boundary to replace the scanner's executable planned stop.
    new.stop_price := greatest(coalesce(new.stop_price, 0), v_planned_stop);
    new.metadata := jsonb_set(
      coalesce(new.metadata, '{}'::jsonb),
      '{planned_stop_enforcement}',
      jsonb_build_object(
        'revision', '7.2.4-LOB-PLANNED-STOP',
        'stop_bps', v_stop_bps,
        'planned_stop_price', v_planned_stop,
        'enforced_at', now()
      ),
      true
    );
  end if;
  return new;
end;
$function$;

drop trigger if exists trading_positions_lob_planned_stop_v724 on public.trading_positions;
create trigger trading_positions_lob_planned_stop_v724
before insert or update of average_entry_price, planned_entry_price, stop_price, tick_size, metadata
on public.trading_positions
for each row execute function public.enforce_lob_planned_stop_v724();

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
  v_remaining_qty numeric;
  v_qty numeric;
  v_exit_fee_rate numeric;
  v_quote_price numeric;
  v_quote_at timestamptz;
  v_guarded_fill_price numeric;
  v_total_unrecovered_cost numeric;
  v_unrecovered_cost numeric;
  v_exit_proceeds numeric;
  v_guarded_net numeric;
  v_guarded_net_return_pct numeric;
  v_drawdown_pct numeric;
  v_purpose text;
  v_requested_reason text;
  v_approved_reason text;
  v_policy_revision text;
  v_soft_qualified boolean;
  v_soft_age numeric;
  v_soft_required numeric;
  v_target numeric;
  v_target_reached boolean;
  v_min_profit_quote numeric;
  v_order_type text;
  v_requested_price numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  v_purpose := upper(coalesce(new.purpose, ''));
  v_order_type := upper(coalesce(new.order_type, ''));
  v_requested_price := greatest(0, coalesce(new.requested_price, 0));

  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.is_paper is distinct from false then
    return new;
  end if;

  v_strategy := upper(coalesce(
    p.metadata#>>'{lob_signal,strategy}',
    p.metadata#>>'{scalp_signal,strategy}',
    ''
  ));
  if v_strategy <> 'LOB_SCALP' then
    return new;
  end if;

  v_held_seconds := greatest(
    0,
    extract(epoch from (now() - coalesce(p.opened_at, p.created_at, now())))
  );
  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  v_remaining_qty := greatest(coalesce(p.remaining_quantity, 0), 0);
  v_qty := least(greatest(coalesce(new.requested_volume, 0), 0), v_remaining_qty);
  v_target := coalesce(nullif(p.target_1, 0), nullif(p.target_2, 0));
  v_exit_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_min_profit_quote := case when lower(p.exchange) = 'upbit' then 1 else 0.01 end;
  v_total_unrecovered_cost := greatest(
    0,
    coalesce(p.realized_cost_quote, 0) + coalesce(p.paid_fees_quote, 0) -
    coalesce(p.realized_proceeds_quote, 0)
  );
  v_unrecovered_cost := case
    when v_remaining_qty > 0
      then v_total_unrecovered_cost * v_qty / v_remaining_qty
    else 0
  end;

  if v_purpose in ('TARGET_1', 'TARGET_2') then
    if v_order_type = 'MARKET' or v_order_type not like 'LIMIT%' then
      raise exception using errcode='23514', message=format(
        'V724_TARGET_REQUIRES_PROTECTED_LIMIT market=%s purpose=%s order_type=%s',
        new.market, v_purpose, v_order_type
      );
    end if;
    if v_qty <= 0 or v_requested_price <= 0 then
      raise exception using errcode='23514', message=format(
        'V724_TARGET_MISSING_PRICE_OR_QUANTITY market=%s purpose=%s price=%s qty=%s',
        new.market, v_purpose, v_requested_price, v_qty
      );
    end if;
    if coalesce(v_target, 0) > 0 and v_requested_price < v_target then
      raise exception using errcode='23514', message=format(
        'V724_TARGET_PRICE_BELOW_PLAN market=%s requested=%s target=%s',
        new.market, v_requested_price, v_target
      );
    end if;

    v_exit_proceeds := v_requested_price * v_qty * (1 - v_exit_fee_rate);
    v_guarded_net := round(v_exit_proceeds - v_unrecovered_cost, 8);
    if v_guarded_net <= v_min_profit_quote then
      raise exception using errcode='23514', message=format(
        'V724_TARGET_NET_NOT_POSITIVE market=%s purpose=%s protected_net=%s required=%s price=%s qty=%s allocated_cost=%s remaining_qty=%s',
        new.market, v_purpose, v_guarded_net, v_min_profit_quote,
        v_requested_price, v_qty, round(v_unrecovered_cost, 8), v_remaining_qty
      );
    end if;
    return new;
  end if;

  v_quote_price := nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric;
  v_quote_at := nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz;
  v_requested_reason := coalesce(p.metadata#>>'{exit_policy_quote,requested_reason}', '');
  v_approved_reason := coalesce(p.metadata#>>'{exit_policy_quote,approved_reason}', '');
  v_policy_revision := coalesce(p.metadata#>>'{exit_policy_quote,revision}', '');
  v_soft_qualified := coalesce(
    (p.metadata#>>'{exit_policy_quote,reversal_qualified}')::boolean,
    false
  );
  v_soft_age := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,soft_signal_age_seconds}', '')::numeric,
    0
  );
  v_soft_required := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,soft_signal_required_seconds}', '')::numeric,
    0
  );

  if coalesce(v_entry, 0) <= 0 or v_qty <= 0 or coalesce(v_quote_price, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'V724_EXIT_BLOCK_MISSING_ECONOMICS market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;
  if v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
    raise exception using errcode='23514', message=format(
      'V724_EXIT_BLOCK_STALE_QUOTE market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  v_guarded_fill_price := v_quote_price;
  v_exit_proceeds := v_guarded_fill_price * v_qty * (1 - v_exit_fee_rate);
  v_guarded_net := round(v_exit_proceeds - v_unrecovered_cost, 8);
  v_guarded_net_return_pct := case
    when v_unrecovered_cost > 0
      then round(v_guarded_net / v_unrecovered_cost * 100, 8)
    else 0
  end;
  v_drawdown_pct := (v_quote_price / v_entry - 1) * 100;
  v_target_reached := coalesce(v_target, 0) > 0 and v_quote_price >= v_target;

  -- A scanner-derived planned stop is real risk control and is valid at any age.
  -- The quote must be fresh and at/below the stop stored on the position; this does not
  -- open a generic pre-180 discretionary sell path.
  if v_purpose = 'STOP'
     and v_requested_reason in ('lob:STOP_HIT', 'lob:planned-stop')
     and coalesce(p.stop_price, 0) > 0
     and v_quote_price <= p.stop_price then
    return new;
  end if;

  if v_held_seconds < 180 then
    if v_policy_revision in (
         '7.1.8-PRE180-TARGET-REVERSAL',
         '7.1.9-EXECUTABLE-NET-PARITY', '7.1.9-POST180-RECOVERY-SHADOW', '7.2.0-POST180-MINUS2-HARD-STOP',
         '7.2.4-LOB-PLANNED-STOP'
       )
       and v_purpose = 'STOP'
       and v_requested_reason in ('lob:SIGNAL_REVERSAL', 'lob:LOB_INVALIDATION')
       and v_approved_reason = v_requested_reason
       and v_soft_qualified then
      return new;
    end if;
    if v_held_seconds >= 60
       and v_policy_revision = '7.1.7-FINAL-EXIT-POLICY'
       and v_purpose = 'STOP'
       and v_requested_reason in ('lob:SIGNAL_REVERSAL', 'lob:LOB_INVALIDATION')
       and v_approved_reason = v_requested_reason
       and v_soft_qualified then
      return new;
    end if;
    if v_held_seconds >= 60
       and v_purpose = 'STOP'
       and v_requested_reason in ('lob:SIGNAL_REVERSAL', 'lob:LOB_INVALIDATION')
       and v_soft_qualified
       and v_soft_required in (30, 50)
       and v_soft_age >= v_soft_required then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V724_PRE180_EXIT_BLOCKED market=%s purpose=%s held=%s reason=%s net=%s age=%s required=%s',
      new.market, v_purpose, round(v_held_seconds, 3), v_requested_reason,
      v_guarded_net, round(v_soft_age, 3), round(v_soft_required, 3)
    );
  end if;

  if v_policy_revision in (
       '7.1.7-FINAL-EXIT-POLICY',
       '7.1.8-PRE180-TARGET-REVERSAL',
       '7.1.9-EXECUTABLE-NET-PARITY', '7.1.9-POST180-RECOVERY-SHADOW', '7.2.0-POST180-MINUS2-HARD-STOP',
       '7.2.4-LOB-PLANNED-STOP'
     )
     and v_approved_reason = 'POSITIVE_NET_AFTER_180S' then
    if v_purpose = 'STOP' and v_guarded_net > 0 then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V724_POSITIVE_NET_EXIT_MISMATCH market=%s purpose=%s guarded_net=%s qty=%s allocated_cost=%s',
      new.market, v_purpose, v_guarded_net, v_qty, round(v_unrecovered_cost, 8)
    );
  end if;

  if v_policy_revision in (
       '7.1.7-FINAL-EXIT-POLICY',
       '7.1.8-PRE180-TARGET-REVERSAL',
       '7.1.9-EXECUTABLE-NET-PARITY', '7.1.9-POST180-RECOVERY-SHADOW', '7.2.0-POST180-MINUS2-HARD-STOP',
       '7.2.4-LOB-PLANNED-STOP'
     )
     and v_approved_reason = 'HARD_STOP_MINUS_2_AFTER_180S' then
    if v_purpose = 'STOP' and v_guarded_net_return_pct <= -2 then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V724_MINUS2_EXIT_MISMATCH market=%s purpose=%s guarded_net_return_pct=%s',
      new.market, v_purpose, v_guarded_net_return_pct
    );
  end if;

  if v_guarded_net > v_min_profit_quote then
    raise exception using errcode='23514', message=format(
      'V724_POST180_PROFIT_MUST_USE_APPROVED_PATH market=%s purpose=%s guarded_net=%s',
      new.market, v_purpose, v_guarded_net
    );
  end if;

  if v_drawdown_pct <= -2 then
    if v_purpose <> 'STOP' then
      raise exception using errcode='23514', message=format(
        'V724_MINUS2_EXIT_MUST_BE_STOP market=%s purpose=%s drawdown_pct=%s',
        new.market, v_purpose, round(v_drawdown_pct, 6)
      );
    end if;
    return new;
  end if;

  raise exception using errcode='23514', message=format(
    'V724_POST180_HOLD market=%s purpose=%s held=%s guarded_net=%s drawdown_pct=%s',
    new.market, v_purpose, round(v_held_seconds, 3),
    v_guarded_net, round(v_drawdown_pct, 6)
  );
end;
$function$;

-- Re-evaluate any currently managed LOB positions against the scanner-derived stop.
update public.trading_positions
set stop_price = stop_price
where state in ('ENTRY_PENDING', 'OPEN', 'EXITING')
  and upper(coalesce(
    metadata#>>'{lob_signal,strategy}',
    metadata#>>'{scalp_signal,strategy}',
    ''
  )) = 'LOB_SCALP';
