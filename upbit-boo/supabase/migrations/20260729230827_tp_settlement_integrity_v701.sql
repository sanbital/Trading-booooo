-- Trading-booooo v7.0.1-TP-SETTLEMENT-INTEGRITY
--
-- A resting TARGET_1 sell changes the exchange balance before the monitor books the
-- terminal fill. The old balance-reconciliation path could therefore shrink a position
-- to its 20% runner first, then apply 100% of the 80% TP proceeds to that reduced cost
-- basis. This migration makes the exit RPC fail closed on a material quantity/funds
-- mismatch and prorates dust-sized overfills to tracked residual inventory.

create or replace function public.apply_trading_exit_order(
  p_order_id uuid,
  p_action text,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_trailing_stop numeric default null,
  p_dust_value_quote numeric default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order public.trading_orders%rowtype;
  v_position public.trading_positions%rowtype;
  v_inventory public.trading_residual_inventory%rowtype;
  v_now timestamptz := now();
  v_sold numeric;
  v_fill_quantity numeric;
  v_fill_funds_total numeric;
  v_base_fee_total numeric;
  v_order_fee_quote_total numeric;
  v_allocation_ratio numeric;
  v_position_fill_funds numeric;
  v_position_fee_quote numeric;
  v_position_base_fee numeric;
  v_excess_quantity numeric;
  v_allowed_excess_quantity numeric;
  v_residual_available numeric;
  v_unallocated_funds numeric;
  v_unallocated_fee numeric;
  v_excess_left numeric;
  v_take numeric;
  v_take_proceeds numeric;
  v_take_fee numeric;
  v_after_sale numeric;
  v_remaining numeric;
  v_residual_quantity numeric;
  v_residual_value numeric;
  v_proceeds numeric;
  v_fees numeric;
  v_closed boolean;
  v_pnl numeric;
  v_quality text;
begin
  select * into v_order
  from public.trading_orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'trading order % not found', p_order_id;
  end if;
  if v_order.side <> 'SELL' or v_order.purpose = 'ENTRY' then
    raise exception 'order % is not an exit order', p_order_id;
  end if;

  select * into v_position
  from public.trading_positions
  where id = v_order.position_id
  for update;
  if not found then
    raise exception 'position for order % not found', p_order_id;
  end if;

  if v_order.state = 'APPLIED' then
    return jsonb_build_object(
      'applied', false,
      'closed', v_position.state = 'CLOSED',
      'position', to_jsonb(v_position),
      'order', to_jsonb(v_order)
    );
  end if;

  v_fill_quantity := greatest(0, coalesce(p_fill_quantity, 0));
  if v_fill_quantity <= 0 or coalesce(p_fill_price, 0) <= 0 then
    raise exception 'exit fill must be positive';
  end if;
  if greatest(0, coalesce(v_position.remaining_quantity, 0)) <= 0 then
    raise exception 'exit fill % has no remaining position quantity', p_order_id;
  end if;

  v_sold := least(greatest(0, v_position.remaining_quantity), v_fill_quantity);
  v_excess_quantity := greatest(0, v_fill_quantity - v_sold);
  v_allowed_excess_quantity := greatest(
    0.000000000001,
    greatest(0, coalesce(v_position.quantity_step, 0)) * 5,
    greatest(0, coalesce(p_dust_value_quote, 0)) / p_fill_price
  );
  if v_excess_quantity > v_allowed_excess_quantity + 0.000000000001 then
    raise exception
      'exit fill quantity % materially exceeds remaining position % for order %',
      v_fill_quantity, v_position.remaining_quantity, p_order_id;
  end if;

  select
    coalesce(sum(
      case
        when upper(coalesce(f.fee_asset, '')) = upper(coalesce(v_position.base_asset, ''))
          then greatest(0, f.fee_amount)
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when upper(coalesce(f.fee_asset, '')) = upper(coalesce(v_position.base_asset, ''))
          then 0
        when upper(coalesce(f.fee_asset, '')) = upper(coalesce(v_position.quote_currency, ''))
          then greatest(0, f.fee_amount)
        else greatest(0, coalesce(f.fee_quote_estimate, 0))
      end
    ), greatest(0, coalesce(p_fill_fee_quote, 0)))
  into v_base_fee_total, v_order_fee_quote_total
  from public.trading_fills f
  where f.order_id = p_order_id;

  v_fill_funds_total := greatest(
    0,
    coalesce(p_fill_funds, v_fill_quantity * p_fill_price)
  );
  v_allocation_ratio := v_sold / v_fill_quantity;
  v_position_fill_funds := v_fill_funds_total * v_allocation_ratio;
  v_position_fee_quote := greatest(0, v_order_fee_quote_total) * v_allocation_ratio;
  v_position_base_fee := greatest(0, v_base_fee_total) * v_allocation_ratio;
  v_unallocated_funds := greatest(0, v_fill_funds_total - v_position_fill_funds);
  v_unallocated_fee := greatest(0, v_order_fee_quote_total - v_position_fee_quote);

  if v_excess_quantity > 0 then
    perform 1
    from public.trading_residual_inventory r
    where r.exchange = v_position.exchange
      and upper(r.asset) = upper(v_position.base_asset)
      and r.state in ('AVAILABLE', 'RESERVED_FOR_REENTRY')
    for update;
    select coalesce(sum(greatest(0, r.remaining_quantity)), 0)
      into v_residual_available
    from public.trading_residual_inventory r
    where r.exchange = v_position.exchange
      and upper(r.asset) = upper(v_position.base_asset)
      and r.state in ('AVAILABLE', 'RESERVED_FOR_REENTRY');
    if v_residual_available + 0.000000000001 < v_excess_quantity then
      raise exception
        'exit overfill % exceeds tracked residual inventory % for order %',
        v_excess_quantity, v_residual_available, p_order_id;
    end if;
  end if;

  v_after_sale := greatest(0, v_position.remaining_quantity - v_sold);
  v_position_base_fee := least(v_after_sale, v_position_base_fee);
  v_remaining := greatest(0, v_after_sale - v_position_base_fee);
  v_proceeds := v_position.realized_proceeds_quote + v_position_fill_funds;
  v_fees := v_position.paid_fees_quote + v_position_fee_quote;
  v_closed := v_remaining <= 0.000000000001 or
    v_remaining * p_fill_price < greatest(0, p_dust_value_quote);
  v_residual_quantity := case when v_closed then v_remaining else 0 end;
  v_residual_value := case when v_closed then v_remaining * p_fill_price else 0 end;
  v_quality := case
    when v_closed and v_residual_quantity > 0 then 'RESIDUAL_MARKED_TO_EXIT'
    else 'NO_RESIDUAL'
  end;
  v_pnl := case
    when v_closed then
      v_proceeds + v_residual_value - v_position.realized_cost_quote - v_fees
    else v_position.realized_pnl_quote
  end;

  update public.trading_positions set
    remaining_quantity = case when v_closed then 0 else v_remaining end,
    residual_quantity = case when v_closed then v_residual_quantity else 0 end,
    residual_value_quote = case when v_closed then v_residual_value else 0 end,
    residual_fee_base = case when v_closed then v_position_base_fee else 0 end,
    accounting_version = '7.0.1',
    realized_proceeds_quote = v_proceeds,
    paid_fees_quote = v_fees,
    realized_pnl_quote = v_pnl,
    t1_completed = t1_completed or p_action = 'TARGET_1',
    trailing_stop = case
      when not v_closed and p_action = 'TARGET_1' and exit_policy = 'TRAIL_AFTER_T1'
        then greatest(coalesce(trailing_stop, 0), coalesce(p_trailing_stop, 0), stop_price)
      else trailing_stop
    end,
    state = case when v_closed then 'CLOSED' else 'OPEN' end,
    close_reason = case when v_closed then p_action else null end,
    closed_at = case when v_closed then v_now else null end,
    metadata = (coalesce(metadata, '{}'::jsonb) - 'pending_exit_action' - 'pending_exit_at') ||
      jsonb_build_object(
        'last_applied_order_id', p_order_id,
        'last_applied_order_at', v_now,
        'exit_fill_allocation', jsonb_build_object(
          'version', '7.0.1',
          'exchange_fill_quantity', v_fill_quantity,
          'position_quantity', v_sold,
          'allocation_ratio', v_allocation_ratio,
          'position_funds_quote', v_position_fill_funds,
          'position_fee_quote', v_position_fee_quote,
          'unallocated_quantity', v_excess_quantity,
          'unallocated_funds_quote', v_unallocated_funds,
          'unallocated_fee_quote', v_unallocated_fee
        ),
        'exit_residual_accounting', jsonb_build_object(
          'quality', v_quality,
          'version', '7.0.1',
          'sold_quantity', v_sold,
          'base_fee_quantity', v_position_base_fee,
          'residual_quantity', v_residual_quantity,
          'residual_value_quote', v_residual_value,
          'mark_price', p_fill_price,
          'dust_value_quote', greatest(0, p_dust_value_quote)
        )
      ),
    updated_at = v_now
  where id = v_position.id
  returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED',
    -- The order ledger remains an exact exchange audit. Only the position allocation is
    -- prorated above.
    executed_volume = v_fill_quantity,
    average_fill_price = p_fill_price,
    executed_funds_quote = v_fill_funds_total,
    paid_fee_quote = greatest(0, v_order_fee_quote_total),
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = p_order_id
  returning * into v_order;

  -- A dust-sized exchange overfill can only be accepted when it is covered by already
  -- tracked residual inventory. Consume that inventory FIFO and allocate its exact share
  -- of proceeds/fees, so account quantity and residual ledgers remain identical.
  v_excess_left := v_excess_quantity;
  if v_excess_left > 0 then
    for v_inventory in
      select *
      from public.trading_residual_inventory
      where exchange = v_position.exchange
        and upper(asset) = upper(v_position.base_asset)
        and state in ('AVAILABLE', 'RESERVED_FOR_REENTRY')
        and remaining_quantity > 0
      order by created_at, position_id
      for update
    loop
      exit when v_excess_left <= 0.000000000001;
      v_take := least(v_inventory.remaining_quantity, v_excess_left);
      v_take_proceeds := case
        when v_excess_quantity > 0 then v_unallocated_funds * v_take / v_excess_quantity
        else 0
      end;
      v_take_fee := case
        when v_excess_quantity > 0 then v_unallocated_fee * v_take / v_excess_quantity
        else 0
      end;
      update public.trading_residual_inventory set
        remaining_quantity = greatest(0, v_inventory.remaining_quantity - v_take),
        swept_quantity = greatest(0, coalesce(v_inventory.swept_quantity, 0)) + v_take,
        realized_proceeds_quote =
          greatest(0, coalesce(v_inventory.realized_proceeds_quote, 0)) + v_take_proceeds,
        paid_fees_quote =
          greatest(0, coalesce(v_inventory.paid_fees_quote, 0)) + v_take_fee,
        value_quote = greatest(0, v_inventory.remaining_quantity - v_take) * p_fill_price,
        residual_pnl_quote =
          greatest(0, coalesce(v_inventory.realized_proceeds_quote, 0)) + v_take_proceeds -
          greatest(0, coalesce(v_inventory.paid_fees_quote, 0)) - v_take_fee +
          greatest(0, v_inventory.remaining_quantity - v_take) * p_fill_price -
          greatest(0, v_inventory.original_quantity) * greatest(0, v_inventory.mark_price),
        state = case
          when v_inventory.remaining_quantity - v_take <= 0.000000000001 then 'SWEPT'
          else 'AVAILABLE'
        end,
        sweep_order_id = p_order_id,
        updated_at = v_now
      where position_id = v_inventory.position_id;
      v_excess_left := greatest(0, v_excess_left - v_take);
    end loop;
  end if;

  return jsonb_build_object(
    'applied', true,
    'closed', v_closed,
    'position', to_jsonb(v_position),
    'order', to_jsonb(v_order)
  );
end;
$$;

revoke all on function public.apply_trading_exit_order(
  uuid, text, numeric, numeric, numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.apply_trading_exit_order(
  uuid, text, numeric, numeric, numeric, numeric, numeric, numeric
) to service_role;

-- Repair incident rows only when their durable BUY and TARGET_1 fills prove that the
-- account still owns a material runner and the stored cost/PnL have the exact false-manual
-- reduction signature. The original corrupted values remain in metadata for audit, and
-- the guard makes repeated workflow applications a no-op.
with affected(position_id) as (
  select p.id
  from public.trading_positions p
  where p.state = 'CLOSED'
    and p.close_reason = 'TARGET_1'
    and p.metadata ? 'manual_reconcile'
    and nullif(p.metadata->>'tp_settled_at', '') is not null
    and not (p.metadata ? 'tp_settlement_integrity_repair')
    and exists (
      select 1
      from public.trading_orders o
      where o.position_id = p.id
        and o.side = 'SELL'
        and o.purpose = 'TARGET_1'
        and o.state = 'APPLIED'
        and o.executed_volume > 0
        and o.executed_volume < p.initial_quantity
    )
),
ledger as (
  select
    p.id,
    p.initial_quantity,
    p.average_entry_price,
    p.stop_price,
    p.metadata,
    p.state as before_state,
    p.remaining_quantity as before_remaining_quantity,
    p.realized_cost_quote as before_cost_quote,
    p.realized_proceeds_quote as before_proceeds_quote,
    p.paid_fees_quote as before_fees_quote,
    p.realized_pnl_quote as before_pnl_quote,
    e.executed_funds_quote as entry_cost_quote,
    greatest(0, coalesce(e.paid_fee_quote, 0)) as entry_fee_quote,
    greatest(0, coalesce(x.sold_quantity, 0)) as sold_quantity,
    greatest(0, coalesce(x.proceeds_quote, 0)) as proceeds_quote,
    greatest(0, coalesce(x.fees_quote, 0)) as exit_fees_quote,
    greatest(0, p.initial_quantity - coalesce(x.sold_quantity, 0) -
      coalesce(x.base_fee_quantity, 0)) as corrected_remaining_quantity
  from affected a
  join public.trading_positions p on p.id = a.position_id
  join lateral (
    select o.*
    from public.trading_orders o
    where o.position_id = p.id
      and o.side = 'BUY'
      and o.purpose = 'ENTRY'
      and o.state = 'APPLIED'
    order by o.created_at
    limit 1
  ) e on true
  join lateral (
    select
      sum(greatest(0, o.executed_volume)) as sold_quantity,
      sum(greatest(0, o.executed_funds_quote)) as proceeds_quote,
      sum(greatest(0, o.paid_fee_quote)) as fees_quote,
      sum(coalesce(f.base_fee_quantity, 0)) as base_fee_quantity
    from public.trading_orders o
    left join lateral (
      select sum(greatest(0, tf.fee_amount)) as base_fee_quantity
      from public.trading_fills tf
      where tf.order_id = o.id
        and upper(coalesce(tf.fee_asset, '')) = upper(p.base_asset)
    ) f on true
    where o.position_id = p.id
      and o.side = 'SELL'
      and o.state = 'APPLIED'
  ) x on true
  where p.state = 'CLOSED'
    and p.close_reason = 'TARGET_1'
    and p.metadata ? 'manual_reconcile'
    and not (p.metadata ? 'tp_settlement_integrity_repair')
    and p.realized_cost_quote < e.executed_funds_quote * 0.5
    and p.realized_pnl_quote > e.executed_funds_quote * 0.25
),
repaired as (
  update public.trading_positions p set
    state = 'OPEN',
    remaining_quantity = l.corrected_remaining_quantity,
    realized_cost_quote = l.entry_cost_quote,
    realized_proceeds_quote = l.proceeds_quote,
    paid_fees_quote = l.entry_fee_quote + l.exit_fees_quote,
    realized_pnl_quote = 0,
    residual_quantity = 0,
    residual_value_quote = 0,
    residual_fee_base = 0,
    accounting_version = '7.0.1',
    t1_completed = true,
    trailing_stop = case
      when p.exit_policy = 'TRAIL_AFTER_T1'
        then greatest(coalesce(p.trailing_stop, 0), p.stop_price, p.average_entry_price * 1.002)
      else p.trailing_stop
    end,
    close_reason = null,
    closed_at = null,
    metadata = (
      coalesce(p.metadata, '{}'::jsonb) -
      'pending_exit_action' -
      'pending_exit_at'
    ) || jsonb_build_object(
      'tp_identifier', null,
      'tp_order_id', null,
      'account_mismatch_count', 0,
      'last_account_mismatch_at', null,
      'exclude_from_learning', false,
      'tp_settlement_integrity_repair', jsonb_build_object(
        'version', '7.0.1',
        'repaired_at', now(),
        'reason', 'TP_FILL_BOOKED_AFTER_FALSE_MANUAL_REDUCTION',
        'before', jsonb_build_object(
          'state', l.before_state,
          'remaining_quantity', l.before_remaining_quantity,
          'realized_cost_quote', l.before_cost_quote,
          'realized_proceeds_quote', l.before_proceeds_quote,
          'paid_fees_quote', l.before_fees_quote,
          'realized_pnl_quote', l.before_pnl_quote
        ),
        'after', jsonb_build_object(
          'state', 'OPEN',
          'remaining_quantity', l.corrected_remaining_quantity,
          'realized_cost_quote', l.entry_cost_quote,
          'realized_proceeds_quote', l.proceeds_quote,
          'paid_fees_quote', l.entry_fee_quote + l.exit_fees_quote,
          'realized_pnl_quote', 0
        )
      )
    ),
    updated_at = now()
  from ledger l
  where p.id = l.id
    and l.corrected_remaining_quantity > 0
  returning p.id, p.exchange, p.base_asset, p.market, p.remaining_quantity
)
insert into public.trading_events(position_id, level, code, message, details)
select
  r.id,
  'WARNING',
  'TP_SETTLEMENT_ACCOUNTING_REPAIRED',
  r.exchange || ':' || r.market || ' false TP profit repaired and runner reopened',
  jsonb_build_object(
    'version', '7.0.1',
    'remaining_quantity', r.remaining_quantity,
    'asset', r.base_asset
  )
from repaired r;

-- The only reason these incident assets were locked was the same false manual-reduction
-- classification. Once the proven runner is back in OPEN state, release those exact locks.
update public.trading_asset_locks l set
  state = 'RELEASED',
  reason = 'TP_SETTLEMENT_ACCOUNTING_REPAIRED',
  clean_checks = greatest(clean_checks, 1),
  last_checked_at = now(),
  last_check_status = 'CLEAN',
  released_at = now(),
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'released_by', '7.0.1-TP-SETTLEMENT-INTEGRITY',
    'released_at', now()
  ),
  updated_at = now()
where l.exchange = 'binance'
  and l.state = 'LOCKED'
  and exists (
    select 1
    from public.trading_positions p
    where p.exchange = l.exchange
      and p.base_asset = l.asset
      and p.state = 'OPEN'
      and p.metadata ? 'tp_settlement_integrity_repair'
  );
