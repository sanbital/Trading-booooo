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
  v_quote_price numeric;
  v_quote_at timestamptz;
  v_guarded_fill_price numeric;
  v_unrecovered_cost numeric;
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

  v_strategy := upper(coalesce(p.metadata#>>'{lob_signal,strategy}', p.metadata#>>'{scalp_signal,strategy}', ''));
  if v_strategy <> 'LOB_SCALP' then
    return new;
  end if;

  v_held_seconds := greatest(0, extract(epoch from (now() - coalesce(p.opened_at, p.created_at, now()))));
  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  v_qty := least(greatest(coalesce(new.requested_volume, 0), 0), greatest(coalesce(p.remaining_quantity, 0), 0));
  v_target := coalesce(nullif(p.target_1, 0), nullif(p.target_2, 0));
  v_exit_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_min_profit_quote := case when lower(p.exchange) = 'upbit' then 1 else 0.01 end;

  -- The first 60 seconds are an absolute bot-side sell lock, including targets.
  if v_held_seconds < 60 then
    raise exception using errcode='23514', message=format(
      'V716_PRE60_ABSOLUTE_SELL_LOCK market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  -- A profit-labelled exit is never allowed to cross the spread as MARKET.
  -- The requested LIMIT price itself must guarantee strictly positive whole-position
  -- economics using the exact exchange-funded entry cost already persisted on the row.
  if v_purpose in ('TARGET_1', 'TARGET_2') then
    if v_order_type = 'MARKET' or v_order_type not like 'LIMIT%' then
      raise exception using errcode='23514', message=format(
        'V716_TARGET_REQUIRES_PROTECTED_LIMIT market=%s purpose=%s order_type=%s',
        new.market, v_purpose, v_order_type
      );
    end if;
    if v_qty <= 0 or v_requested_price <= 0 then
      raise exception using errcode='23514', message=format(
        'V716_TARGET_MISSING_PRICE_OR_QUANTITY market=%s purpose=%s price=%s qty=%s',
        new.market, v_purpose, v_requested_price, v_qty
      );
    end if;
    if coalesce(v_target, 0) > 0 and v_requested_price < v_target then
      raise exception using errcode='23514', message=format(
        'V716_TARGET_PRICE_BELOW_PLAN market=%s requested=%s target=%s',
        new.market, v_requested_price, v_target
      );
    end if;

    v_unrecovered_cost := greatest(
      0,
      coalesce(p.realized_cost_quote, 0) + coalesce(p.paid_fees_quote, 0) -
      coalesce(p.realized_proceeds_quote, 0)
    );
    v_exit_proceeds := v_requested_price * v_qty * (1 - v_exit_fee_rate);
    v_guarded_net := v_exit_proceeds - v_unrecovered_cost;
    if v_guarded_net <= v_min_profit_quote then
      raise exception using errcode='23514', message=format(
        'V716_TARGET_NET_NOT_POSITIVE market=%s purpose=%s protected_net=%s required=%s price=%s qty=%s unrecovered_cost=%s',
        new.market, v_purpose, round(v_guarded_net, 8), v_min_profit_quote,
        v_requested_price, v_qty, round(v_unrecovered_cost, 8)
      );
    end if;
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
      'V716_EXIT_BLOCK_MISSING_ECONOMICS market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;
  if v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
    raise exception using errcode='23514', message=format(
      'V716_EXIT_BLOCK_STALE_QUOTE market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  v_guarded_fill_price := v_quote_price;
  v_unrecovered_cost := greatest(
    0,
    coalesce(p.realized_cost_quote, 0) + coalesce(p.paid_fees_quote, 0) -
    coalesce(p.realized_proceeds_quote, 0)
  );
  v_exit_proceeds := v_guarded_fill_price * v_qty * (1 - v_exit_fee_rate);
  v_guarded_net := v_exit_proceeds - v_unrecovered_cost;
  v_drawdown_pct := (v_quote_price / v_entry - 1) * 100;
  v_target_reached := coalesce(v_target, 0) > 0 and v_quote_price >= v_target;

  if v_held_seconds < 180 then
    if v_purpose = 'STOP'
       and v_requested_reason in ('lob:SIGNAL_REVERSAL', 'lob:LOB_INVALIDATION')
       and v_soft_qualified
       and v_soft_required in (30, 50)
       and v_soft_age >= v_soft_required then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V716_60_180_EXIT_BLOCKED market=%s purpose=%s held=%s reason=%s net=%s age=%s required=%s',
      new.market, v_purpose, round(v_held_seconds, 3), v_requested_reason,
      round(v_guarded_net, 8), round(v_soft_age, 3), round(v_soft_required, 3)
    );
  end if;

  if v_guarded_net > v_min_profit_quote then
    raise exception using errcode='23514', message=format(
      'V716_POST180_PROFIT_MUST_USE_PROTECTED_TARGET market=%s purpose=%s guarded_net=%s',
      new.market, v_purpose, round(v_guarded_net, 8)
    );
  end if;

  if v_drawdown_pct <= -3 then
    if v_purpose <> 'STOP' then
      raise exception using errcode='23514', message=format(
        'V716_MINUS3_EXIT_MUST_BE_STOP market=%s purpose=%s drawdown_pct=%s',
        new.market, v_purpose, round(v_drawdown_pct, 6)
      );
    end if;
    return new;
  end if;

  raise exception using errcode='23514', message=format(
    'V716_POST180_HOLD market=%s purpose=%s held=%s guarded_net=%s drawdown_pct=%s',
    new.market, v_purpose, round(v_held_seconds, 3), round(v_guarded_net, 8), round(v_drawdown_pct, 6)
  );
end;
$function$;
