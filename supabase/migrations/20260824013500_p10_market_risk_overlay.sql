-- Activate market-regime observations only for the P10 exit-risk consumer.
-- Historical rows remain false; the observer writes true only after its production rollout.

alter table public.market_regime_observations
  drop constraint if exists market_regime_observations_trading_influence_check;

comment on column public.market_regime_observations.trading_influence is
  'True only when the observation is eligible for production P10 hold/exit risk evaluation.';

-- Preserve a position-scoped, transactionally applied marker for the one-time market
-- defensive reduction. This does not consume or alter the strategy TARGET_1 entitlement.
create or replace function public.apply_p10_exit_order(
  p_order_id uuid,
  p_action text,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_next_stop numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.trading_orders%rowtype;
  v_position public.trading_positions%rowtype;
  v_now timestamptz := now();
  v_expected_side text;
  v_quantity numeric;
  v_remaining numeric;
  v_exit_fee numeric;
  v_gross_delta numeric;
  v_gross_total numeric;
  v_fees_total numeric;
  v_closed boolean;
begin
  select * into v_order
  from public.trading_orders
  where id = p_order_id
  for update;
  if not found then raise exception 'trading order % not found', p_order_id; end if;

  select * into v_position
  from public.trading_positions
  where id = v_order.position_id
  for update;
  if not found then raise exception 'position for order % not found', p_order_id; end if;

  if v_position.strategy_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' or
     v_position.exit_policy <> 'P10_SLOW_4R' then
    raise exception 'position % is not a P10 position', v_position.id;
  end if;
  v_expected_side := case when v_position.position_side = 'SHORT' then 'BUY' else 'SELL' end;
  if v_order.purpose = 'ENTRY' or v_order.side <> v_expected_side then
    raise exception 'order % has invalid P10 exit direction', p_order_id;
  end if;
  if v_order.state = 'APPLIED' then
    return jsonb_build_object(
      'applied', false,
      'closed', v_position.state = 'CLOSED',
      'position', to_jsonb(v_position),
      'order', to_jsonb(v_order)
    );
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 then
    raise exception 'P10 exit fill must be positive';
  end if;

  v_quantity := least(v_position.remaining_quantity, p_fill_quantity);
  if v_quantity <= 0 or
     p_fill_quantity > v_position.remaining_quantity +
       greatest(0.000000000001, coalesce(v_position.quantity_step, 0) * 2) then
    raise exception 'P10 exit quantity exceeds remaining position';
  end if;
  v_remaining := greatest(0, v_position.remaining_quantity - v_quantity);
  v_closed := v_remaining <= greatest(0.000000000001, coalesce(v_position.quantity_step, 0) * 0.5);
  v_exit_fee := greatest(0, coalesce(p_fill_fee_quote, 0));
  v_gross_delta := case
    when v_position.position_side = 'SHORT'
      then (v_position.average_entry_price - p_fill_price) * v_quantity
    else (p_fill_price - v_position.average_entry_price) * v_quantity
  end;
  v_gross_total :=
    coalesce((v_position.metadata->>'p10_realized_gross_pnl_quote')::numeric, 0) +
    v_gross_delta;
  v_fees_total := greatest(0, coalesce(v_position.paid_fees_quote, 0)) + v_exit_fee;

  update public.trading_positions set
    remaining_quantity = case when v_closed then 0 else v_remaining end,
    realized_proceeds_quote = coalesce(realized_proceeds_quote, 0) +
      greatest(0, coalesce(p_fill_funds, p_fill_price * v_quantity)),
    paid_fees_quote = v_fees_total,
    realized_pnl_quote = v_gross_total - v_fees_total,
    t1_completed = t1_completed or p_action = 'TARGET_1',
    trailing_stop = case when p_next_stop is null then trailing_stop else p_next_stop end,
    state = case when v_closed then 'CLOSED' else 'OPEN' end,
    close_reason = case when v_closed then p_action else null end,
    closed_at = case when v_closed then v_now else null end,
    reserved_quote = 0,
    reserved_quantity = 0,
    reservation_expires_at = null,
    marked_pnl_quote = null,
    metadata = (
      (coalesce(metadata, '{}'::jsonb) -
        'pending_exit_action' - 'pending_exit_reason' - 'pending_exit_at') ||
      jsonb_build_object(
        'last_applied_order_id', p_order_id,
        'last_applied_order_at', v_now,
        'p10_realized_gross_pnl_quote', v_gross_total,
        'p10_last_exit_action', p_action,
        'p10_last_exit_price', p_fill_price,
        'p10_last_exit_quantity', v_quantity
      ) ||
      case
        when p_action = 'MARKET_RISK_PARTIAL' then
          jsonb_build_object(
            'p10_market_risk_partial_at', v_now,
            'p10_market_risk_partial_order_id', p_order_id
          )
        when p_action = 'MARKET_RISK_EXIT' then
          jsonb_build_object(
            'p10_market_risk_exit_at', v_now,
            'p10_market_risk_exit_order_id', p_order_id
          )
        else '{}'::jsonb
      end
    ),
    updated_at = v_now
  where id = v_position.id
  returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED',
    executed_volume = p_fill_quantity,
    average_fill_price = p_fill_price,
    executed_funds_quote =
      greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fee_quote = v_exit_fee,
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = p_order_id
  returning * into v_order;

  if v_closed then
    update public.p10_signal_claims set
      status = 'CLOSED',
      updated_at = v_now
    where position_id = v_position.id;
  end if;

  return jsonb_build_object(
    'applied', true,
    'closed', v_closed,
    'position', to_jsonb(v_position),
    'order', to_jsonb(v_order)
  );
end;
$function$;

revoke all on function public.apply_p10_exit_order(
  uuid, text, numeric, numeric, numeric, numeric, numeric
) from public;
grant execute on function public.apply_p10_exit_order(
  uuid, text, numeric, numeric, numeric, numeric, numeric
) to service_role;

-- Durable P10 market-regime live-influence safety gate.
--
-- Keep this definition in the replayed overlay migration rather than the two
-- 2026-08-26 incident-recovery migrations, because those recovery files contain
-- a bounded one-time backfill and must not run on every normal deployment.
create or replace function public.guard_unvalidated_market_regime_influence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.trading_influence is not true then
    return new;
  end if;

  if new.model_revision is distinct from 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features ->> 'source', '') <>
     'BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features ->> 'trading_influence', 'false') <> 'true' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features -> 'momentum_phase' ->> 'model_revision', '') <>
     'C43-DYNAMIC-HORIZON-FORECAST-v1' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features -> 'conditional_forecast' ->> 'model_revision', '') <>
     'C43-DYNAMIC-HORIZON-FORECAST-v1' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features ->> 'forecast_candidate_id', '') <>
     'C43_PHASE_TREE_PERSISTENCE_STRUCT_PERSIST' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features -> 'momentum_phase' ->> 'trading_influence', 'false') <> 'true' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.sample_size, 0) < 240 then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(jsonb_typeof(new.features -> 'conditional_forecast' -> 'horizons'), '') <> 'array' then
    new.trading_influence := false;
    return new;
  end if;

  if jsonb_array_length(new.features -> 'conditional_forecast' -> 'horizons') < 3 then
    new.trading_influence := false;
    return new;
  end if;

  return new;
end;
$$;

comment on function public.guard_unvalidated_market_regime_influence() is
  'DB safety gate for P10 market-regime live influence. Allows only FULLMARKET observations from the full active universe with the C43 production forecast/candidate and sufficient sample size; all other producers are forced false.';

drop trigger if exists trg_guard_unvalidated_market_regime_influence
  on public.market_regime_observations;

create trigger trg_guard_unvalidated_market_regime_influence
before insert or update of model_revision, trading_influence
on public.market_regime_observations
for each row
execute function public.guard_unvalidated_market_regime_influence();

-- Fail the deployment if a future edit regresses the exact P10 production
-- provenance or leaves the trigger missing/disabled. These are policy identity
-- constants, not operator-tunable thresholds.
do $$
declare
  v_guard_def text;
  v_trigger_def text;
begin
  select pg_get_functiondef(p.oid)
    into v_guard_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'guard_unvalidated_market_regime_influence';

  if v_guard_def is null
     or position('MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET' in v_guard_def) = 0
     or position('BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE' in v_guard_def) = 0
     or position('C43-DYNAMIC-HORIZON-FORECAST-v1' in v_guard_def) = 0
     or position('C43_PHASE_TREE_PERSISTENCE_STRUCT_PERSIST' in v_guard_def) = 0
     or position('coalesce(new.sample_size, 0) < 240' in v_guard_def) = 0
     or position('jsonb_array_length(new.features -> ''conditional_forecast'' -> ''horizons'') < 3' in v_guard_def) = 0
     or position('MARKET-REGIME-OBSERVER-v2-C01-D3X2-T10-G0-C43-FULLMARKET' in v_guard_def) > 0 then
    raise exception 'P10 market-risk influence guard is not the approved FULLMARKET+C43 definition';
  end if;

  select pg_get_triggerdef(t.oid, true)
    into v_trigger_def
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid
  where n.nspname = 'public'
    and c.relname = 'market_regime_observations'
    and t.tgname = 'trg_guard_unvalidated_market_regime_influence'
    and p.proname = 'guard_unvalidated_market_regime_influence'
    and t.tgenabled <> 'D'
    and not t.tgisinternal;

  if v_trigger_def is null
     or position('BEFORE INSERT OR UPDATE OF model_revision, trading_influence' in v_trigger_def) = 0 then
    raise exception 'P10 market-risk influence trigger is missing, disabled, or malformed';
  end if;
end
$$;
