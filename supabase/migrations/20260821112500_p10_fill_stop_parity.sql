-- Keep the executable P10 entry geometry anchored to the actual exchange fill.
-- The initial position row is reserved at the limit price; a price-improved fill must
-- rebase both the fixed stop and the initial trailing stop before monitoring begins.

create or replace function public.apply_p10_entry_order(
  p_order_id uuid,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_stop_price numeric,
  p_target_1 numeric,
  p_target_2 numeric,
  p_initial_risk numeric
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
  v_expected_side := case when v_position.position_side = 'SHORT' then 'SELL' else 'BUY' end;
  if v_order.purpose <> 'ENTRY' or v_order.side <> v_expected_side then
    raise exception 'order % has invalid P10 entry direction', p_order_id;
  end if;
  if v_order.state = 'APPLIED' then
    return jsonb_build_object(
      'applied', false,
      'position', to_jsonb(v_position),
      'order', to_jsonb(v_order)
    );
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 or
     coalesce(p_initial_risk, 0) <= 0 then
    raise exception 'P10 entry fill and initial risk must be positive';
  end if;

  update public.trading_positions set
    state = 'OPEN',
    initial_quantity = p_fill_quantity,
    remaining_quantity = p_fill_quantity,
    average_entry_price = p_fill_price,
    planned_entry_price = p_fill_price,
    stop_price = p_stop_price,
    trailing_stop = p_stop_price,
    target_1 = p_target_1,
    target_2 = p_target_2,
    peak_price = p_fill_price,
    trough_price = p_fill_price,
    opened_at = coalesce(opened_at, v_now),
    realized_cost_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fees_quote = greatest(0, coalesce(p_fill_fee_quote, 0)),
    reserved_quote = 0,
    reserved_quantity = 0,
    reservation_expires_at = null,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_applied_order_id', p_order_id,
      'last_applied_order_at', v_now,
      'p10_initial_risk', p_initial_risk,
      'p10_realized_gross_pnl_quote', 0,
      'p10_entry_fee_quote', greatest(0, coalesce(p_fill_fee_quote, 0))
    ),
    updated_at = v_now
  where id = v_position.id
  returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED',
    executed_volume = p_fill_quantity,
    average_fill_price = p_fill_price,
    executed_funds_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fee_quote = greatest(0, coalesce(p_fill_fee_quote, 0)),
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = p_order_id
  returning * into v_order;

  update public.p10_signal_claims set
    status = 'FILLED',
    position_id = v_position.id,
    updated_at = v_now
  where position_id = v_position.id or
    id::text = coalesce(v_position.metadata->>'p10_claim_id', '');

  return jsonb_build_object(
    'applied', true,
    'position', to_jsonb(v_position),
    'order', to_jsonb(v_order)
  );
end;
$function$;

revoke all on function public.apply_p10_entry_order(
  uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.apply_p10_entry_order(
  uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) to service_role;

-- Repair only fills that have not consumed a later completed policy bar. This makes the
-- correction idempotent and never loosens a stop already advanced by break-even/trailing.
update public.trading_positions
set trailing_stop = stop_price,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'p10_entry_stop_rebased_at', now(),
      'p10_entry_stop_rebased_from', trailing_stop
    ),
    updated_at = now()
where strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
  and state = 'OPEN'
  and coalesce(t1_completed, false) = false
  and stop_price is not null
  and trailing_stop is distinct from stop_price
  and coalesce((metadata->>'p10_last_policy_bar_time')::bigint, 0) <=
      extract(epoch from (metadata->>'p10_signal_time')::timestamptz) * 1000;
