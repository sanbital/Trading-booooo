-- Ledger recovery: make Binance fills the single source of truth for position closure.
--
-- Background
-- ----------
-- `exchange-trade-sync` linked a fill to a bot order by reading `trading_orders`
-- through PostgREST with `.limit(5000)`. PostgREST caps responses at 1000 rows, so
-- only the oldest ~1000 orders were ever visible. Every order created after
-- 2026-08-02 fell outside that window, so its fills landed with
-- `bot_order_id = null`, `position_id = null`, `source = 'MANUAL'`. Because the sync
-- also advances a `from_id` cursor, those fills were never revisited, and nothing in
-- the system ever closed a position from fills. Positions stayed OPEN while the
-- exchange balance was zero, and the autotrader retried the exit forever.
--
-- The fix has to live in SQL, not in the edge function: the linking join has no row
-- cap here, and the recovery must be replayable so the ledger repairs itself on
-- every sync rather than needing a one-off script.
--
-- Accounting contract (matches the existing v7.0.1 position rows):
--   effective buy qty = quantity - fee_amount   when the fee was charged in the base
--                       asset (you receive less coin), else quantity
--   buy fee in quote  = 0 when the fee was charged in the base asset (already netted
--                       out of the quantity above), else fee_quote_amount
--   realized_pnl      = proceeds - realized_cost - fees
--   realized_return   = realized_pnl / realized_cost * 100
-- Realized figures are computed from executed fills only. No mark price is read here,
-- so a closed trade's PnL cannot move after the fact.

-- ---------------------------------------------------------------------------
-- 1. Base-asset buy fees were double-counted in the market-wide accounting pass.
--    When the fee is paid in the base asset the quantity received is already
--    reduced, so adding fee_quote_amount to the cost again overstates the basis.
-- ---------------------------------------------------------------------------
create or replace function public.rebuild_exchange_trade_accounting(
  p_exchange text,
  p_account_scope text,
  p_market text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  v_inventory_qty numeric := 0;
  v_inventory_cost numeric := 0;
  v_avg_cost numeric := 0;
  v_effective_buy_qty numeric;
  v_fee_quote numeric;
  v_base_fee boolean;
  v_realized_cost numeric;
  v_realized_proceeds numeric;
  v_realized_pnl numeric;
  v_accounted integer := 0;
  v_unmatched integer := 0;
begin
  update public.exchange_trade_fills
     set realized_cost_quote = null,
         realized_proceeds_quote = null,
         realized_pnl_quote = null,
         inventory_quantity_after = null,
         inventory_cost_after = null,
         accounting_status = 'PENDING',
         updated_at = now()
   where exchange = p_exchange
     and account_scope = p_account_scope
     and market = p_market;

  for r in
    select *
    from public.exchange_trade_fills
    where exchange = p_exchange
      and account_scope = p_account_scope
      and market = p_market
    order by executed_at, exchange_trade_id
  loop
    v_fee_quote := coalesce(r.fee_quote_amount, 0);
    v_base_fee := upper(coalesce(r.fee_asset, '')) = upper(coalesce(r.base_asset, ''));

    if r.side = 'BUY' then
      v_effective_buy_qty := r.quantity;
      if v_base_fee then
        -- Fee taken in coin: fewer units received, and the quote outlay is unchanged.
        v_effective_buy_qty := greatest(r.quantity - coalesce(r.fee_amount, 0), 0);
        v_fee_quote := 0;
      end if;

      if v_effective_buy_qty <= 0 then
        update public.exchange_trade_fills
           set accounting_status = 'ERROR',
               inventory_quantity_after = v_inventory_qty,
               inventory_cost_after = v_inventory_cost,
               updated_at = now()
         where id = r.id;
        continue;
      end if;

      v_inventory_qty := v_inventory_qty + v_effective_buy_qty;
      v_inventory_cost := v_inventory_cost + r.quote_amount + v_fee_quote;

      update public.exchange_trade_fills
         set realized_cost_quote = 0,
             realized_proceeds_quote = 0,
             realized_pnl_quote = 0,
             inventory_quantity_after = v_inventory_qty,
             inventory_cost_after = v_inventory_cost,
             accounting_status = 'ACCOUNTED',
             updated_at = now()
       where id = r.id;
      v_accounted := v_accounted + 1;
    else
      if r.quantity > v_inventory_qty + 0.000000000001 then
        update public.exchange_trade_fills
           set accounting_status = 'UNMATCHED_INVENTORY',
               inventory_quantity_after = v_inventory_qty,
               inventory_cost_after = v_inventory_cost,
               updated_at = now()
         where id = r.id;
        v_unmatched := v_unmatched + 1;
        continue;
      end if;

      v_avg_cost := case when v_inventory_qty > 0 then v_inventory_cost / v_inventory_qty else 0 end;
      v_realized_cost := v_avg_cost * r.quantity;
      v_realized_proceeds := r.quote_amount - v_fee_quote;
      v_realized_pnl := v_realized_proceeds - v_realized_cost;
      v_inventory_qty := greatest(v_inventory_qty - r.quantity, 0);
      v_inventory_cost := greatest(v_inventory_cost - v_realized_cost, 0);
      if v_inventory_qty <= 0.000000000001 then
        v_inventory_qty := 0;
        v_inventory_cost := 0;
      end if;

      update public.exchange_trade_fills
         set realized_cost_quote = v_realized_cost,
             realized_proceeds_quote = v_realized_proceeds,
             realized_pnl_quote = v_realized_pnl,
             inventory_quantity_after = v_inventory_qty,
             inventory_cost_after = v_inventory_cost,
             accounting_status = 'ACCOUNTED',
             updated_at = now()
       where id = r.id;
      v_accounted := v_accounted + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'exchange', p_exchange,
    'account_scope', p_account_scope,
    'market', p_market,
    'accounted', v_accounted,
    'unmatched', v_unmatched,
    'inventory_quantity', v_inventory_qty,
    'inventory_cost_quote', v_inventory_cost
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Link fills to the bot order that produced them. Runs as a set-based join, so
--    it has none of the row-cap exposure the edge function had, and it re-links
--    fills that were already written as MANUAL.
-- ---------------------------------------------------------------------------
create or replace function public.link_exchange_fills_to_orders(
  p_exchange text default 'binance',
  p_market text default null
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_linked integer;
begin
  with matched as (
    select distinct on (f.id)
      f.id as fill_id,
      o.id as order_id,
      o.position_id,
      o.identifier
    from public.exchange_trade_fills f
    join public.trading_orders o
      on o.market = f.market
     and o.exchange_order_id = f.exchange_order_id
     and o.exchange = f.exchange
    where f.exchange = p_exchange
      and (p_market is null or f.market = p_market)
      and f.exchange_order_id is not null
      and o.position_id is not null
      and (f.bot_order_id is distinct from o.id or f.position_id is distinct from o.position_id)
    order by f.id, o.created_at
  )
  update public.exchange_trade_fills f
     set bot_order_id = m.order_id,
         position_id = m.position_id,
         client_order_id = coalesce(f.client_order_id, m.identifier),
         source = 'AUTOMATED',
         updated_at = now()
    from matched m
   where f.id = m.fill_id;

  get diagnostics v_linked = row_count;
  return v_linked;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Attribute exchange fills to positions and settle positions whose exchange
--    inventory is exhausted.
--
--    Attribution order:
--      a) fills already carrying a position_id (linked to a bot order) stay put;
--      b) remaining SELL fills are assigned FIFO to the oldest position in that
--         market that still has outstanding quantity as of the fill time. Exits
--         placed outside the bot are real exits and must land on the position they
--         actually closed.
--
--    A position is only settled from executed fills. Already-CLOSED positions are
--    never rewritten, which is what keeps a finished trade's PnL immutable.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_positions_from_exchange_fills(
  p_exchange text default 'binance',
  p_market text default null,
  p_dust_fraction numeric default 0.005
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_market text;
  v_fill record;
  v_pos record;
  v_linked integer := 0;
  v_attributed integer := 0;
  v_split integer := 0;
  v_orphan integer := 0;
  v_updated integer := 0;
  v_closed integer := 0;
  v_closed_ids jsonb := '[]'::jsonb;
  v_outstanding numeric;
  v_target uuid;
  v_take numeric;
  -- position recompute scratch
  v_entry_qty numeric;
  v_entry_cost numeric;
  v_entry_fee numeric;
  v_sold_qty numeric;
  v_proceeds numeric;
  v_sell_fee numeric;
  v_last_exit timestamptz;
  v_sold_frac numeric;
  v_realized_cost numeric;
  v_fees numeric;
  v_pnl numeric;
  v_return numeric;
  v_remaining numeric;
  v_reason text;
  v_should_close boolean;
  -- FIFO inventory per position, held as parallel arrays ordered by opened_at.
  -- Plain arrays rather than a temp table: this function is called on every sync,
  -- and a temp table would leave stale cached plans behind between calls.
  v_pos_ids uuid[];
  v_pos_opened timestamptz[];
  v_pos_out numeric[];
  v_pos_entry numeric[];
  i integer;
  v_hit integer;
begin
  v_linked := public.link_exchange_fills_to_orders(p_exchange, p_market);

  for v_market in
    select distinct f.market
    from public.exchange_trade_fills f
    where f.exchange = p_exchange
      and (p_market is null or f.market = p_market)
  loop
    -- Outstanding quantity per position for this market, seeded from fills already
    -- attributed to each position. Rebuilt per market so the pass is replayable.
    select array_agg(s.id order by s.opened_at),
           array_agg(s.opened_at order by s.opened_at),
           array_agg(s.outstanding order by s.opened_at),
           array_agg(s.entry_qty order by s.opened_at)
      into v_pos_ids, v_pos_opened, v_pos_out, v_pos_entry
      from (
        select p.id,
               p.opened_at,
               coalesce(sum(
                 case
                   when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) = upper(coalesce(f.base_asset,''))
                     then greatest(f.quantity - coalesce(f.fee_amount, 0), 0)
                   when f.side = 'BUY' then f.quantity
                   else -f.quantity
                 end
               ), 0) as outstanding,
               coalesce(sum(
                 case
                   when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) = upper(coalesce(f.base_asset,''))
                     then greatest(f.quantity - coalesce(f.fee_amount, 0), 0)
                   when f.side = 'BUY' then f.quantity
                   else 0
                 end
               ), 0) as entry_qty
          from public.trading_positions p
          left join public.exchange_trade_fills f
            on f.position_id = p.id
          where p.market = v_market
            and p.exchange = p_exchange
            and coalesce(p.is_paper, false) = false
            and p.opened_at is not null
            -- A fully-exited position keeps a dust remainder (base-asset entry fees
            -- mean sold never lands exactly on bought). Left eligible, that dust
            -- absorbs a later orphan sell and starves its real owner.
            and p.state <> 'CLOSED'
          group by p.id, p.opened_at
      ) s;

    v_pos_ids := coalesce(v_pos_ids, array[]::uuid[]);

    -- Assign orphan SELL fills FIFO to positions that still hold inventory.
    for v_fill in
      select f.id, f.quantity, f.executed_at
        from public.exchange_trade_fills f
       where f.exchange = p_exchange
         and f.market = v_market
         and f.side = 'SELL'
         and f.position_id is null
       order by f.executed_at, f.exchange_trade_id
    loop
      v_target := null;
      v_outstanding := 0;
      v_hit := null;
      for i in 1 .. coalesce(array_length(v_pos_ids, 1), 0) loop
        if v_pos_out[i] > greatest(v_pos_entry[i] * p_dust_fraction, 1e-9)
           and v_pos_opened[i] <= v_fill.executed_at then
          v_target := v_pos_ids[i];
          v_outstanding := v_pos_out[i];
          v_hit := i;
          exit;
        end if;
      end loop;

      if v_target is null then
        v_orphan := v_orphan + 1;
        continue;
      end if;

      v_take := least(v_fill.quantity, v_outstanding);
      if v_fill.quantity > v_outstanding + greatest(v_outstanding * p_dust_fraction, 1e-9) then
        -- The fill spans more inventory than this position held. Surface it rather
        -- than silently splitting a single exchange fill across two positions.
        v_split := v_split + 1;
      end if;

      update public.exchange_trade_fills
         set position_id = v_target,
             updated_at = now()
       where id = v_fill.id;

      v_pos_out[v_hit] := greatest(v_pos_out[v_hit] - v_take, 0);
      v_attributed := v_attributed + 1;
    end loop;

    -- Recompute and settle each position in this market from its attributed fills.
    for v_pos in
      select p.*
        from public.trading_positions p
       where p.market = v_market
         and p.exchange = p_exchange
         and coalesce(p.is_paper, false) = false
         and p.state <> 'CLOSED'
    loop
      select
        coalesce(sum(case
          when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) = upper(coalesce(f.base_asset,''))
            then greatest(f.quantity - coalesce(f.fee_amount, 0), 0)
          when f.side = 'BUY' then f.quantity else 0 end), 0),
        coalesce(sum(case when f.side = 'BUY' then f.quote_amount else 0 end), 0),
        coalesce(sum(case
          when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) <> upper(coalesce(f.base_asset,''))
            then coalesce(f.fee_quote_amount, 0) else 0 end), 0),
        coalesce(sum(case when f.side = 'SELL' then f.quantity else 0 end), 0),
        coalesce(sum(case when f.side = 'SELL' then f.quote_amount else 0 end), 0),
        coalesce(sum(case when f.side = 'SELL' then coalesce(f.fee_quote_amount, 0) else 0 end), 0),
        max(case when f.side = 'SELL' then f.executed_at end)
      into v_entry_qty, v_entry_cost, v_entry_fee, v_sold_qty, v_proceeds, v_sell_fee, v_last_exit
      from public.exchange_trade_fills f
      where f.position_id = v_pos.id;

      -- No executed entry on the exchange: nothing to settle (rejected/blocked rows).
      if v_entry_qty <= 0 then
        continue;
      end if;

      v_sold_frac := least(v_sold_qty / v_entry_qty, 1);
      v_realized_cost := v_entry_cost * v_sold_frac;
      v_fees := (v_entry_fee * v_sold_frac) + v_sell_fee;
      v_pnl := v_proceeds - v_realized_cost - v_fees;
      v_return := case when v_realized_cost > 0 then v_pnl / v_realized_cost * 100 else 0 end;
      v_remaining := greatest(v_entry_qty - v_sold_qty, 0);
      v_should_close := v_remaining <= greatest(v_entry_qty * p_dust_fraction, 0);

      if v_should_close then
        select o.purpose into v_reason
          from public.trading_orders o
         where o.position_id = v_pos.id
           and o.side = 'SELL'
           and o.state = 'APPLIED'
         order by o.completed_at desc nulls last
         limit 1;
        v_reason := coalesce(v_reason, 'EXCHANGE_FILL_RECONCILED');

        update public.trading_positions
           set state = 'CLOSED',
               remaining_quantity = 0,
               closed_at = coalesce(v_last_exit, now()),
               close_reason = v_reason,
               realized_proceeds_quote = v_proceeds,
               realized_cost_quote = v_realized_cost,
               paid_fees_quote = v_fees,
               realized_pnl_quote = v_pnl,
               realized_return_pct = v_return,
               residual_quantity = 0,
               residual_value_quote = 0,
               reserved_quantity = 0,
               reserved_quote = 0,
               fee_accounting_quality = 'EXACT',
               accounting_version = '7.5.2',
               metadata = coalesce(v_pos.metadata, '{}'::jsonb) || jsonb_build_object(
                 'ledger_recovery', jsonb_build_object(
                   'settled_from', 'EXCHANGE_TRADE_FILLS',
                   'settled_at', now(),
                   'previous_state', v_pos.state,
                   'previous_close_reason', v_pos.close_reason,
                   'exchange_entry_quantity', v_entry_qty,
                   'exchange_exit_quantity', v_sold_qty
                 )
               ),
               updated_at = now()
         where id = v_pos.id;
        v_closed := v_closed + 1;
        v_closed_ids := v_closed_ids || jsonb_build_array(v_pos.id);
      else
        -- Still holding coin on the exchange: keep the position live but make the
        -- partial-exit figures reflect executed fills instead of leaving them at 0.
        update public.trading_positions
           set remaining_quantity = v_remaining,
               realized_proceeds_quote = v_proceeds,
               realized_cost_quote = v_realized_cost,
               paid_fees_quote = v_fees,
               realized_pnl_quote = v_pnl,
               realized_return_pct = v_return,
               updated_at = now()
         where id = v_pos.id
           and (
             remaining_quantity is distinct from v_remaining
             or realized_pnl_quote is distinct from v_pnl
             or realized_proceeds_quote is distinct from v_proceeds
           );
      end if;

      v_updated := v_updated + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'exchange', p_exchange,
    'market', p_market,
    'fills_linked_to_orders', v_linked,
    'fills_attributed_fifo', v_attributed,
    'fills_spanning_positions', v_split,
    'orphan_sell_fills', v_orphan,
    'positions_evaluated', v_updated,
    'positions_closed', v_closed,
    'closed_position_ids', v_closed_ids
  );
end;
$function$;

comment on function public.reconcile_positions_from_exchange_fills is
  'Settles trading_positions from exchange_trade_fills. Binance fills are the single source of truth; already-CLOSED positions are never rewritten so realized PnL is immutable.';

grant execute on function public.link_exchange_fills_to_orders(text, text) to service_role;
grant execute on function public.reconcile_positions_from_exchange_fills(text, text, numeric) to service_role;
