-- Repair CLOSED Binance position economics from the complete exchange fill ledger.
--
-- Why this exists:
-- The execution engine can mark a position CLOSED immediately after its final exit
-- order is applied, while exchange-trade-sync may not have ingested every fill yet.
-- The old reconciliation contract intentionally refused to rewrite CLOSED rows.
-- That made a partial snapshot permanent. Example: a 97.8 REUSDT entry at 0.4733
-- was stored with only 50% of its entry cost after the first 48.9 exit, then the
-- second exit arrived later. Performance correctly saw all SELL fills but trusted
-- the stale CLOSED cost, producing an impossible +89% return.
--
-- Contract after this migration:
--  * exchange_trade_fills remains the source of truth for Binance realized PnL;
--  * CLOSED is immutable only once the complete fill ledger agrees with it;
--  * later-arriving fills are allowed to repair accounting fields, never trading
--    decisions, orders, close reason, or close timestamp;
--  * the repair is idempotent and records an audit marker in metadata.

create or replace function public.recompute_closed_position_from_exchange_fills(
  p_position_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_pos public.trading_positions%rowtype;
  v_entry_qty numeric := 0;
  v_entry_cost numeric := 0;
  v_entry_fee numeric := 0;
  v_sold_qty numeric := 0;
  v_proceeds numeric := 0;
  v_sell_fee numeric := 0;
  v_sold_frac numeric := 0;
  v_realized_cost numeric := 0;
  v_fees numeric := 0;
  v_pnl numeric := 0;
  v_return numeric := 0;
  v_changed boolean := false;
begin
  select * into v_pos
    from public.trading_positions
   where id = p_position_id
   for update;

  if not found
     or lower(coalesce(v_pos.exchange, '')) <> 'binance'
     or upper(coalesce(v_pos.state, '')) <> 'CLOSED'
     or coalesce(v_pos.is_paper, false) then
    return false;
  end if;

  select
    coalesce(sum(case
      when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) = upper(coalesce(f.base_asset,''))
        then greatest(f.quantity - coalesce(f.fee_amount, 0), 0)
      when f.side = 'BUY' then f.quantity
      else 0 end), 0),
    coalesce(sum(case when f.side = 'BUY' then f.quote_amount else 0 end), 0),
    coalesce(sum(case
      when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) <> upper(coalesce(f.base_asset,''))
        then coalesce(f.fee_quote_amount, 0)
      else 0 end), 0),
    coalesce(sum(case when f.side = 'SELL' then f.quantity else 0 end), 0),
    coalesce(sum(case when f.side = 'SELL' then f.quote_amount else 0 end), 0),
    coalesce(sum(case when f.side = 'SELL' then coalesce(f.fee_quote_amount, 0) else 0 end), 0)
  into v_entry_qty, v_entry_cost, v_entry_fee,
       v_sold_qty, v_proceeds, v_sell_fee
  from public.exchange_trade_fills f
  where f.position_id = p_position_id
    and f.exchange = 'binance';

  if v_entry_qty <= 0 or v_sold_qty <= 0 then
    return false;
  end if;

  v_sold_frac := least(v_sold_qty / v_entry_qty, 1);

  -- A CLOSED position may legally leave only configured dust. Do not rewrite a
  -- row while the ledger still contains a materially open position; a later fill
  -- will invoke this function again.
  if v_sold_frac < 0.995 then
    return false;
  end if;

  v_realized_cost := v_entry_cost * v_sold_frac;
  v_fees := (v_entry_fee * v_sold_frac) + v_sell_fee;
  v_pnl := v_proceeds - v_realized_cost - v_fees;
  v_return := case when v_realized_cost > 0 then v_pnl / v_realized_cost * 100 else 0 end;

  v_changed :=
       abs(coalesce(v_pos.realized_proceeds_quote, 0) - v_proceeds) > 0.00000001
    or abs(coalesce(v_pos.realized_cost_quote, 0) - v_realized_cost) > 0.00000001
    or abs(coalesce(v_pos.paid_fees_quote, 0) - v_fees) > 0.00000001
    or abs(coalesce(v_pos.realized_pnl_quote, 0) - v_pnl) > 0.00000001
    or abs(coalesce(v_pos.realized_return_pct, 0) - v_return) > 0.00000001;

  if not v_changed then
    return false;
  end if;

  update public.trading_positions
     set realized_proceeds_quote = v_proceeds,
         realized_cost_quote = v_realized_cost,
         paid_fees_quote = v_fees,
         realized_pnl_quote = v_pnl,
         realized_return_pct = v_return,
         fee_accounting_quality = 'EXACT',
         accounting_version = '7.5.3',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'closed_fill_repair', jsonb_build_object(
             'version', '7.5.3',
             'repaired_at', now(),
             'source', 'COMPLETE_EXCHANGE_TRADE_FILLS',
             'entry_quantity', v_entry_qty,
             'sold_quantity', v_sold_qty,
             'entry_cost_quote', v_entry_cost,
             'proceeds_quote', v_proceeds,
             'fees_quote', v_fees,
             'previous_realized_cost_quote', v_pos.realized_cost_quote,
             'previous_realized_pnl_quote', v_pos.realized_pnl_quote,
             'previous_realized_return_pct', v_pos.realized_return_pct
           )
         ),
         updated_at = now()
   where id = p_position_id;

  return true;
end;
$function$;

-- If a late exchange fill is linked after the position was already closed, repair
-- the accounting immediately. This is the race that caused the REUSDT +89% row.
create or replace function public.trg_repair_closed_position_after_exchange_fill()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.position_id is not null then
    perform public.recompute_closed_position_from_exchange_fills(new.position_id);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_repair_closed_position_after_exchange_fill
  on public.exchange_trade_fills;
create trigger trg_repair_closed_position_after_exchange_fill
after insert or update of position_id, quantity, quote_amount, fee_quote_amount, fee_amount, fee_asset
on public.exchange_trade_fills
for each row
execute function public.trg_repair_closed_position_after_exchange_fill();

-- Also attempt a repair at the moment a row transitions to CLOSED. If all fills are
-- already present this fixes it immediately; otherwise the fill trigger above fixes
-- it when the remaining fills arrive.
create or replace function public.trg_repair_position_when_closed()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if upper(coalesce(new.state, '')) = 'CLOSED'
     and upper(coalesce(old.state, '')) is distinct from 'CLOSED' then
    perform public.recompute_closed_position_from_exchange_fills(new.id);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_repair_position_when_closed
  on public.trading_positions;
create trigger trg_repair_position_when_closed
after update of state
on public.trading_positions
for each row
execute function public.trg_repair_position_when_closed();

grant execute on function public.recompute_closed_position_from_exchange_fills(uuid) to service_role;

-- One-time backfill. The function updates only rows whose stored CLOSED accounting
-- differs from the complete fill ledger, so already-correct history is untouched.
do $backfill$
declare
  r record;
begin
  for r in
    select distinct p.id
      from public.trading_positions p
      join public.exchange_trade_fills f on f.position_id = p.id
     where p.exchange = 'binance'
       and p.state = 'CLOSED'
       and coalesce(p.is_paper, false) = false
  loop
    perform public.recompute_closed_position_from_exchange_fills(r.id);
  end loop;
end;
$backfill$;
