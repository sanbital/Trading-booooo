-- Adopt exchange-side manual BUY fills into the existing automatic exit engine.
-- Manual entries remain excluded from strategy learning/performance, but stop/TP are managed.

create or replace function public.manual_fill_quantum(p_value numeric)
returns numeric
language plpgsql
immutable
strict
as $$
declare
  v_text text;
  v_decimals integer;
begin
  if p_value <= 0 then
    return 1;
  end if;
  v_text := regexp_replace(p_value::text, '0+$', '');
  if position('.' in v_text) = 0 then
    return 1;
  end if;
  v_decimals := length(split_part(v_text, '.', 2));
  if v_decimals <= 0 then
    return 1;
  end if;
  return power(10::numeric, -v_decimals);
end;
$$;

create or replace function public.adopt_manual_trade_fill(p_fill_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fill public.exchange_trade_fills%rowtype;
  v_position public.trading_positions%rowtype;
  v_history public.trading_positions%rowtype;
  v_position_id uuid;
  v_order_id uuid;
  v_quote text;
  v_base text;
  v_received_qty numeric;
  v_tick numeric;
  v_step numeric;
  v_min_notional numeric;
  v_avg numeric;
  v_old_qty numeric;
  v_meta jsonb;
  v_fee_quality text;
begin
  select * into v_fill
  from public.exchange_trade_fills
  where id = p_fill_id
  for update;

  if not found then
    return null;
  end if;

  if upper(coalesce(v_fill.source, '')) <> 'MANUAL'
     or upper(coalesce(v_fill.side, '')) <> 'BUY'
     or v_fill.position_id is not null
     or v_fill.bot_order_id is not null
     or coalesce(v_fill.quantity, 0) <= 0
     or coalesce(v_fill.price, 0) <= 0 then
    return v_fill.position_id;
  end if;

  -- Do not adopt a fill that can already be proven to belong to a bot order.
  if v_fill.exchange_order_id is not null and exists (
    select 1
    from public.trading_orders o
    where o.exchange = v_fill.exchange
      and o.exchange_order_id = v_fill.exchange_order_id
  ) then
    return null;
  end if;
  if coalesce(v_fill.client_order_id, '') ~* '^tb[-_]' then
    return null;
  end if;

  v_quote := upper(coalesce(nullif(v_fill.quote_asset, ''), case when v_fill.exchange = 'upbit' then 'KRW' else 'USDT' end));
  v_base := upper(coalesce(nullif(v_fill.base_asset, ''), case when v_fill.exchange = 'upbit' then replace(v_fill.market, 'KRW-', '') else regexp_replace(v_fill.market, 'USDT$', '') end));
  v_received_qty := greatest(
    0::numeric,
    v_fill.quantity - case when upper(coalesce(v_fill.fee_asset, '')) = v_base then coalesce(v_fill.fee_amount, 0) else 0 end
  );
  if v_received_qty <= 0 then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_fill.exchange || ':' || v_fill.market));

  select * into v_position
  from public.trading_positions
  where exchange = v_fill.exchange
    and market = v_fill.market
    and state in ('ENTRY_PENDING','OPEN','EXITING','RECONCILING','RECONCILIATION_FAILED','MANUAL_INTERVENTION_REQUIRED')
  order by created_at desc
  limit 1
  for update;

  if found then
    if v_position.state <> 'OPEN' then
      return null;
    end if;

    v_old_qty := greatest(0::numeric, coalesce(v_position.remaining_quantity, 0));
    if v_old_qty + v_received_qty <= 0 then
      return null;
    end if;
    v_avg := (
      coalesce(v_position.average_entry_price, v_position.planned_entry_price) * v_old_qty
      + v_fill.price * v_received_qty
    ) / (v_old_qty + v_received_qty);

    v_meta := coalesce(v_position.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'manual_augmented', true,
        'acquisition_source', 'MIXED_BOT_MANUAL',
        'management_scope', 'AUTO_EXIT',
        'auto_exit_enabled', true,
        'exclude_from_learning', true,
        'exclude_from_performance', true,
        'manual_last_fill_id', v_fill.id,
        'manual_last_fill_at', v_fill.executed_at,
        'engine_revision_guard', '7.5.2-RESIDUAL-TP10-SL4',
        'exit_policy_revision', '7.5.2-RESIDUAL-TP10-SL4',
        'half_hold_policy', jsonb_build_object(
          'enabled', true,
          'stage', 'FIRST_TRANCHE',
          'first_stop_loss_pct', -4,
          'first_take_profit_pct', 5,
          'first_tranche_ratio', 0.5,
          'residual_ratio', 0.5,
          'residual_exit_enabled', true,
          'residual_stop_loss_pct', -4,
          'residual_take_profit_pct', 10,
          'non_threshold_exit_enabled', false,
          'protected_stop_loss_enabled', true,
          'return_basis', 'EXECUTABLE_PRICE_NET_OF_EXIT_FEE_VS_ENTRY_PRICE'
        )
      );

    update public.trading_positions
    set initial_quantity = initial_quantity + v_received_qty,
        remaining_quantity = remaining_quantity + v_received_qty,
        average_entry_price = v_avg,
        planned_entry_price = v_avg,
        stop_price = v_avg * 0.96,
        target_1 = v_avg * 1.05,
        target_2 = v_avg * 1.10,
        t1_allocation_pct = 50,
        t1_completed = false,
        exit_policy = 'SCALE_OUT',
        realized_cost_quote = realized_cost_quote + coalesce(v_fill.quote_amount, v_fill.price * v_fill.quantity),
        paid_fees_quote = paid_fees_quote + coalesce(v_fill.fee_quote_amount, 0),
        metadata = v_meta,
        updated_at = now()
    where id = v_position.id
    returning id into v_position_id;
  else
    select * into v_history
    from public.trading_positions
    where exchange = v_fill.exchange
      and market = v_fill.market
      and coalesce(tick_size, 0) > 0
    order by created_at desc
    limit 1;

    v_tick := coalesce(nullif(v_history.tick_size, 0), public.manual_fill_quantum(v_fill.price));
    v_step := coalesce(nullif(v_history.quantity_step, 0), public.manual_fill_quantum(v_received_qty));
    v_min_notional := coalesce(
      nullif(v_history.min_notional_quote, 0),
      case when v_fill.exchange = 'upbit' then 5000::numeric else 5::numeric end
    );

    v_fee_quality := case
      when coalesce(v_fill.fee_quote_amount, 0) <= 0 then 'NOT_APPLICABLE'
      when upper(coalesce(v_fill.fee_asset, '')) = v_base then 'BASE_ASSET_ACCOUNTED'
      when upper(coalesce(v_fill.fee_asset, '')) not in ('', v_base, v_quote) then 'THIRD_ASSET_MARKED'
      else 'EXACT'
    end;

    insert into public.trading_positions (
      exchange, quote_currency, market, base_asset, state, is_paper, profile_version,
      initial_quantity, remaining_quantity, average_entry_price, planned_entry_price,
      stop_price, target_1, target_2, tick_size, quantity_step, min_notional_quote,
      t1_allocation_pct, t1_completed, exit_policy, intended_horizon_hours,
      max_holding_at, opened_at, realized_cost_quote, paid_fees_quote,
      fee_accounting_quality, fee_accounting_version, metadata, created_at, updated_at
    ) values (
      v_fill.exchange, v_quote, v_fill.market, v_base, 'OPEN', false, 0,
      v_received_qty, v_received_qty, v_fill.price, v_fill.price,
      v_fill.price * 0.96, v_fill.price * 1.05, v_fill.price * 1.10,
      v_tick, v_step, v_min_notional,
      50, false, 'SCALE_OUT', 8760,
      now() + interval '365 days', v_fill.executed_at,
      coalesce(v_fill.quote_amount, v_fill.price * v_fill.quantity),
      coalesce(v_fill.fee_quote_amount, 0),
      v_fee_quality, 'MANUAL-ADOPT-V1',
      jsonb_build_object(
        'acquisition_source', 'MANUAL',
        'strategy', 'MANUAL_MANAGED',
        'management_scope', 'AUTO_EXIT',
        'auto_exit_enabled', true,
        'exclude_from_learning', true,
        'exclude_from_performance', true,
        'manual_fill_id', v_fill.id,
        'manual_exchange_order_id', v_fill.exchange_order_id,
        'manual_adopted_at', now(),
        'engine_version', '7.5.2-RESIDUAL-TP10-SL4',
        'engine_revision_guard', '7.5.2-RESIDUAL-TP10-SL4',
        'exit_policy_revision', '7.5.2-RESIDUAL-TP10-SL4',
        'policy_enforced_at', now(),
        'half_hold_policy', jsonb_build_object(
          'enabled', true,
          'stage', 'FIRST_TRANCHE',
          'first_stop_loss_pct', -4,
          'first_take_profit_pct', 5,
          'first_tranche_ratio', 0.5,
          'residual_ratio', 0.5,
          'residual_exit_enabled', true,
          'residual_stop_loss_pct', -4,
          'residual_take_profit_pct', 10,
          'non_threshold_exit_enabled', false,
          'protected_stop_loss_enabled', true,
          'return_basis', 'EXECUTABLE_PRICE_NET_OF_EXIT_FEE_VS_ENTRY_PRICE'
        )
      ),
      v_fill.executed_at, now()
    ) returning id into v_position_id;
  end if;

  insert into public.trading_orders (
    position_id, exchange, quote_currency, identifier, exchange_order_id,
    market, side, purpose, order_type, requested_price, requested_volume,
    requested_notional_quote, state, executed_volume, average_fill_price,
    executed_funds_quote, paid_fee_quote, fee_asset, requested_at, completed_at,
    raw_response, fee_accounting_quality, created_at, updated_at
  ) values (
    v_position_id, v_fill.exchange, v_quote,
    'manual-adopt-' || replace(v_fill.id::text, '-', ''), null,
    v_fill.market, 'BUY', 'ENTRY', 'MANUAL', v_fill.price, v_fill.quantity,
    coalesce(v_fill.quote_amount, v_fill.price * v_fill.quantity), 'APPLIED',
    v_fill.quantity, v_fill.price,
    coalesce(v_fill.quote_amount, v_fill.price * v_fill.quantity),
    coalesce(v_fill.fee_quote_amount, 0), v_fill.fee_asset,
    v_fill.executed_at, v_fill.executed_at,
    jsonb_build_object(
      'manual_adoption', true,
      'source_fill_id', v_fill.id,
      'exchange_order_id', v_fill.exchange_order_id,
      'client_order_id', v_fill.client_order_id
    ),
    case
      when coalesce(v_fill.fee_quote_amount, 0) <= 0 then 'NOT_APPLICABLE'
      when upper(coalesce(v_fill.fee_asset, '')) = v_base then 'BASE_ASSET_ACCOUNTED'
      when upper(coalesce(v_fill.fee_asset, '')) not in ('', v_base, v_quote) then 'THIRD_ASSET_MARKED'
      else 'EXACT'
    end,
    v_fill.executed_at, now()
  )
  on conflict (identifier) do update
    set position_id = excluded.position_id,
        state = 'APPLIED',
        updated_at = now()
  returning id into v_order_id;

  update public.exchange_trade_fills
  set position_id = v_position_id,
      updated_at = now()
  where id = v_fill.id
    and position_id is null;

  return v_position_id;
end;
$$;

create or replace function public.trg_adopt_manual_trade_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(coalesce(new.source, '')) = 'MANUAL'
     and upper(coalesce(new.side, '')) = 'BUY'
     and new.position_id is null
     and new.bot_order_id is null then
    perform public.adopt_manual_trade_fill(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_adopt_manual_trade_fill on public.exchange_trade_fills;
create trigger trg_adopt_manual_trade_fill
after insert or update of source, position_id, bot_order_id
on public.exchange_trade_fills
for each row
when (upper(coalesce(new.source, '')) = 'MANUAL' and upper(coalesce(new.side, '')) = 'BUY' and new.position_id is null and new.bot_order_id is null)
execute function public.trg_adopt_manual_trade_fill();

comment on function public.adopt_manual_trade_fill(uuid) is
'Manual BUY adoption v1: preserve manual acquisition provenance, exclude from learning/performance, manage exits at -4% / +5% half / +10% residual through the normal monitor.';
