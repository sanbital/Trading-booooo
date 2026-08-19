-- Incident repair: ZROUSDT position 111c5f48-27bf-4c26-9819-4f4ed7714577
-- was contaminated by a 2025 MANUAL buy fill that predates the 2026 bot position.
-- Three authenticated Binance account snapshots confirm ZRO free+locked == 0 and
-- the only 2026 automated round trip is 47.68 BUY -> 47.68 SELL.
--
-- This migration is deliberately narrow and fail-closed. It detaches only the exact
-- stale manual fill/order, rebuilds the position from automated exchange fills, and
-- preserves the incident in metadata. It never deletes historical fills/events.

do $$
declare
  v_position_id constant uuid := '111c5f48-27bf-4c26-9819-4f4ed7714577'::uuid;
  v_manual_fill_id constant uuid := '55ddf00e-3f89-4df8-8e07-90af3e60cd0b'::uuid;
  v_manual_order_id constant uuid := '038e70c3-a28b-4e91-8316-eee8cc62e6a0'::uuid;
  v_entry_order_id constant uuid := 'bd4fdb4a-7a0f-4955-82e9-e8009dda7831'::uuid;
  v_exit_order_id constant uuid := '76b87951-0409-4c5b-b211-df54a2c88384'::uuid;
  p public.trading_positions%rowtype;
  v_snapshot_count integer := 0;
  v_zero_snapshot_count integer := 0;
  v_pending_sells integer := 0;
  v_buy_qty numeric := 0;
  v_buy_quote numeric := 0;
  v_buy_fee numeric := 0;
  v_sell_qty numeric := 0;
  v_sell_quote numeric := 0;
  v_sell_fee numeric := 0;
  v_last_sell timestamptz;
  v_pnl numeric := 0;
  v_return numeric := 0;
  v_original_reason text;
  v_reconcile jsonb;
begin
  select * into p
  from public.trading_positions
  where id = v_position_id
  for update;

  if not found then
    raise exception 'ZRO_REPAIR_POSITION_MISSING';
  end if;

  if coalesce(p.metadata->'accounting_repair'->>'revision','') = '7.6.12-ZRO-STALE-MANUAL-DETACH' then
    return;
  end if;

  if p.exchange <> 'binance' or p.market <> 'ZROUSDT' or coalesce(p.is_paper,false) then
    raise exception 'ZRO_REPAIR_POSITION_IDENTITY_MISMATCH';
  end if;

  if p.opened_at is null or p.opened_at < '2026-08-19T07:25:00Z'::timestamptz
     or p.opened_at > '2026-08-19T07:28:00Z'::timestamptz then
    raise exception 'ZRO_REPAIR_OPEN_TIME_MISMATCH: %', p.opened_at;
  end if;

  if not exists (
    select 1 from public.exchange_trade_fills
    where id = v_manual_fill_id
      and exchange = 'binance'
      and market = 'ZROUSDT'
      and side = 'BUY'
      and source = 'MANUAL'
      and bot_order_id is null
      and executed_at = '2025-06-29T22:04:31.726Z'::timestamptz
      and abs(quantity - 58.85) < 0.00000001
      and (position_id = v_position_id or position_id is null)
  ) then
    raise exception 'ZRO_REPAIR_MANUAL_FILL_PRECONDITION_FAILED';
  end if;

  if not exists (
    select 1 from public.trading_orders
    where id = v_manual_order_id
      and identifier = 'manual-adopt-55ddf00e3f894df88e0790af3e60cd0b'
      and side = 'BUY'
      and purpose = 'ENTRY'
      and state = 'APPLIED'
      and abs(executed_volume - 58.85) < 0.00000001
      and (position_id = v_position_id or position_id is null)
  ) then
    raise exception 'ZRO_REPAIR_MANUAL_ORDER_PRECONDITION_FAILED';
  end if;

  if not exists (
    select 1 from public.trading_orders
    where id = v_entry_order_id and position_id = v_position_id
      and side = 'BUY' and purpose = 'ENTRY' and state = 'APPLIED'
      and abs(executed_volume - 47.68) < 0.00000001
  ) or not exists (
    select 1 from public.trading_orders
    where id = v_exit_order_id and position_id = v_position_id
      and side = 'SELL' and purpose = 'STOP' and state = 'APPLIED'
      and abs(executed_volume - 47.68) < 0.00000001
  ) then
    raise exception 'ZRO_REPAIR_AUTOMATED_ORDER_PRECONDITION_FAILED';
  end if;

  with latest as (
    select balances
    from public.trading_account_snapshots
    where exchange = 'binance'
    order by captured_at desc
    limit 3
  ), measured as (
    select
      coalesce((
        select coalesce(nullif(a->>'balance','')::numeric, nullif(a->>'free','')::numeric, 0)
        from jsonb_array_elements(coalesce(latest.balances,'[]'::jsonb)) a
        where upper(coalesce(a->>'currency',a->>'asset','')) = 'ZRO'
        limit 1
      ),0) as free_qty,
      coalesce((
        select coalesce(nullif(a->>'locked','')::numeric,0)
        from jsonb_array_elements(coalesce(latest.balances,'[]'::jsonb)) a
        where upper(coalesce(a->>'currency',a->>'asset','')) = 'ZRO'
        limit 1
      ),0) as locked_qty
    from latest
  )
  select count(*), count(*) filter (where abs(free_qty) <= 0.00000001 and abs(locked_qty) <= 0.00000001)
  into v_snapshot_count, v_zero_snapshot_count
  from measured;

  if v_snapshot_count <> 3 or v_zero_snapshot_count <> 3 then
    raise exception 'ZRO_REPAIR_BALANCE_NOT_CONFIRMED_ZERO: snapshots %, zero %',
      v_snapshot_count, v_zero_snapshot_count;
  end if;

  select count(*) into v_pending_sells
  from public.trading_orders
  where market = 'ZROUSDT' and side = 'SELL'
    and state not in ('APPLIED','REJECTED','NOT_FOUND','EXCHANGE_CANCELLED','CANCELLED');

  if v_pending_sells <> 0 then
    raise exception 'ZRO_REPAIR_PENDING_SELL_EXISTS: %', v_pending_sells;
  end if;

  v_original_reason := coalesce(nullif(p.metadata->>'pending_exit_reason',''), p.close_reason, 'STOP');

  update public.exchange_trade_fills
  set position_id = null, updated_at = now()
  where id = v_manual_fill_id and position_id = v_position_id;

  update public.trading_orders
  set position_id = null
  where id = v_manual_order_id and position_id = v_position_id;

  v_reconcile := public.reconcile_positions_from_exchange_fills('binance', 'ZROUSDT', 0.005);

  select
    coalesce(sum(quantity) filter (where side='BUY' and source='AUTOMATED'),0),
    coalesce(sum(quote_amount) filter (where side='BUY' and source='AUTOMATED'),0),
    coalesce(sum(coalesce(fee_quote_amount,0)) filter (where side='BUY' and source='AUTOMATED'),0),
    coalesce(sum(quantity) filter (where side='SELL' and source='AUTOMATED'),0),
    coalesce(sum(quote_amount) filter (where side='SELL' and source='AUTOMATED'),0),
    coalesce(sum(coalesce(fee_quote_amount,0)) filter (where side='SELL' and source='AUTOMATED'),0),
    max(executed_at) filter (where side='SELL' and source='AUTOMATED')
  into v_buy_qty, v_buy_quote, v_buy_fee, v_sell_qty, v_sell_quote, v_sell_fee, v_last_sell
  from public.exchange_trade_fills
  where position_id = v_position_id;

  if v_buy_qty <= 0 or v_sell_qty <= 0
     or abs(v_buy_qty - 47.68) > 0.00000001
     or abs(v_sell_qty - 47.68) > 0.00000001
     or abs(v_buy_qty - v_sell_qty) > 0.00000001 then
    raise exception 'ZRO_REPAIR_AUTOMATED_FILL_MISMATCH: buy %, sell %', v_buy_qty, v_sell_qty;
  end if;

  v_pnl := v_sell_quote - v_buy_quote - v_buy_fee - v_sell_fee;
  v_return := case when v_buy_quote > 0 then v_pnl / v_buy_quote * 100 else 0 end;

  update public.trading_positions
  set state = 'CLOSED',
      initial_quantity = v_buy_qty,
      remaining_quantity = 0,
      average_entry_price = case when v_buy_qty > 0 then v_buy_quote / v_buy_qty else average_entry_price end,
      realized_cost_quote = v_buy_quote,
      realized_proceeds_quote = v_sell_quote,
      paid_fees_quote = v_buy_fee + v_sell_fee,
      realized_pnl_quote = v_pnl,
      realized_return_pct = v_return,
      residual_quantity = 0,
      residual_value_quote = 0,
      reserved_quantity = 0,
      reserved_quote = 0,
      reservation_expires_at = null,
      marked_pnl_quote = null,
      close_reason = v_original_reason,
      closed_at = coalesce(v_last_sell, closed_at, now()),
      fee_accounting_quality = 'EXACT',
      accounting_version = '7.6.12-ZRO-STALE-MANUAL-DETACH',
      metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
        'exclude_from_learning', true,
        'display_data_status', 'ACCOUNTING_REPAIRED_STALE_MANUAL_FILL',
        'pending_exit_action', null,
        'pending_exit_reason', null,
        'pending_exit_at', null,
        'accounting_repair', jsonb_build_object(
          'revision', '7.6.12-ZRO-STALE-MANUAL-DETACH',
          'repaired_at', now(),
          'reason', 'STALE_MANUAL_FILL_PREDATES_BOT_POSITION_AND_AUTHENTICATED_BALANCE_IS_ZERO',
          'detached_manual_fill_id', v_manual_fill_id,
          'detached_manual_order_id', v_manual_order_id,
          'original_initial_quantity', p.initial_quantity,
          'original_remaining_quantity', p.remaining_quantity,
          'original_realized_pnl_quote', p.realized_pnl_quote,
          'original_exit_reason', v_original_reason,
          'verified_zero_snapshot_count', v_zero_snapshot_count,
          'automated_buy_quantity', v_buy_qty,
          'automated_sell_quantity', v_sell_qty,
          'reconcile_result', v_reconcile
        )
      ),
      updated_at = now()
  where id = v_position_id;

  select * into p from public.trading_positions where id = v_position_id;
  if p.state <> 'CLOSED' or abs(coalesce(p.remaining_quantity,0)) > 0.00000001 then
    raise exception 'ZRO_REPAIR_POSTCONDITION_POSITION_NOT_CLOSED';
  end if;
  if abs(coalesce(p.realized_pnl_quote,0) - v_pnl) > 0.00000001 then
    raise exception 'ZRO_REPAIR_POSTCONDITION_PNL_MISMATCH';
  end if;
end $$;
