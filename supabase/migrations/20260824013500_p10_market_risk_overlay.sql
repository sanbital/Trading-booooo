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
