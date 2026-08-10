-- Trading-booooo v7.6.4 — immediate closed split-exit ledger repair.
--
-- A split position can close before the second exchange_trade_fills poll arrives. The
-- in-process exit accountant then has cumulative proceeds but only the remaining-half cost
-- basis, temporarily fabricating a huge profit. Rebuild a CLOSED bot position immediately
-- from durable trading_orders/trading_fills; the later exchange_trade_fills repair remains
-- authoritative and can overwrite this marked-fee ledger with exact exchange accounting.

create or replace function public.recompute_closed_position_from_trading_fills_v764(p_position_id uuid)
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
  v_pnl numeric := 0;
  v_return numeric := 0;
  v_previous_rewrite_setting text;
begin
  select * into v_pos
  from public.trading_positions
  where id = p_position_id
  for update;

  if not found
     or lower(coalesce(v_pos.exchange, '')) not in ('binance', 'binance_futures')
     or upper(coalesce(v_pos.state, '')) <> 'CLOSED'
     or coalesce(v_pos.is_paper, false) then
    return false;
  end if;

  select
    coalesce(sum(case when upper(coalesce(o.side,'')) = 'BUY' then coalesce(f.volume,0) else 0 end),0),
    coalesce(sum(case when upper(coalesce(o.side,'')) = 'BUY' then coalesce(f.funds_quote, f.price * f.volume, 0) else 0 end),0),
    coalesce(sum(case when upper(coalesce(o.side,'')) = 'BUY' then coalesce(f.fee_quote_estimate,0) else 0 end),0),
    coalesce(sum(case when upper(coalesce(o.side,'')) = 'SELL' then coalesce(f.volume,0) else 0 end),0),
    coalesce(sum(case when upper(coalesce(o.side,'')) = 'SELL' then coalesce(f.funds_quote, f.price * f.volume, 0) else 0 end),0),
    coalesce(sum(case when upper(coalesce(o.side,'')) = 'SELL' then coalesce(f.fee_quote_estimate,0) else 0 end),0)
  into v_entry_qty, v_entry_cost, v_entry_fee, v_sold_qty, v_proceeds, v_sell_fee
  from public.trading_orders o
  join public.trading_fills f on f.order_id = o.id
  where o.position_id = p_position_id
    and upper(coalesce(o.side,'')) in ('BUY','SELL');

  if v_entry_qty <= 0 or v_sold_qty <= 0 then
    return false;
  end if;

  v_sold_frac := least(v_sold_qty / v_entry_qty, 1);
  if v_sold_frac < 0.995 then
    return false;
  end if;

  v_pnl := v_proceeds - v_entry_cost - v_entry_fee - v_sell_fee;
  v_return := case when v_entry_cost > 0 then v_pnl / v_entry_cost * 100 else 0 end;

  v_previous_rewrite_setting := current_setting('trading_boooo.allow_closed_rewrite', true);
  perform set_config('trading_boooo.allow_closed_rewrite', 'on', true);

  update public.trading_positions
  set realized_proceeds_quote = v_proceeds,
      realized_cost_quote = v_entry_cost,
      paid_fees_quote = v_entry_fee + v_sell_fee,
      realized_pnl_quote = v_pnl,
      realized_return_pct = v_return,
      fee_accounting_quality = case
        when v_entry_fee + v_sell_fee > 0 then 'MARKED'
        else coalesce(fee_accounting_quality, 'UNKNOWN')
      end,
      accounting_version = '7.6.4',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'closed_split_ledger_repair', jsonb_build_object(
          'version', '7.6.4-TRADING-FILLS-FALLBACK',
          'repaired_at', now(),
          'entry_quantity', v_entry_qty,
          'sold_quantity', v_sold_qty,
          'entry_cost_quote', v_entry_cost,
          'entry_fee_quote', v_entry_fee,
          'proceeds_quote', v_proceeds,
          'sell_fee_quote', v_sell_fee
        )
      ),
      updated_at = now()
  where id = p_position_id;

  perform set_config(
    'trading_boooo.allow_closed_rewrite',
    coalesce(nullif(v_previous_rewrite_setting, ''), 'off'),
    true
  );

  return true;
end;
$function$;

comment on function public.recompute_closed_position_from_trading_fills_v764(uuid) is
  'Immediately rebuilds a fully closed Binance spot/futures position from durable bot fills; exact exchange-fill reconciliation may overwrite it later.';

create or replace function public.trg_repair_position_when_closed()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if upper(coalesce(new.state,'')) = 'CLOSED'
     and upper(coalesce(old.state,'')) is distinct from 'CLOSED' then
    perform public.recompute_closed_position_from_trading_fills_v764(new.id);
    perform public.recompute_closed_position_from_exchange_fills(new.id);
  end if;
  return new;
end;
$function$;

-- Repair recent closes that may have been exposed to the split-cost timing window. Exact
-- Binance exchange fills, where complete, are applied second and therefore remain final.
do $backfill$
declare
  r record;
begin
  for r in
    select id, exchange
    from public.trading_positions
    where state = 'CLOSED'
      and coalesce(is_paper,false) = false
      and lower(coalesce(exchange,'')) in ('binance','binance_futures')
      and closed_at >= now() - interval '2 days'
  loop
    perform public.recompute_closed_position_from_trading_fills_v764(r.id);
    if lower(r.exchange) = 'binance' then
      perform public.recompute_closed_position_from_exchange_fills(r.id);
    end if;
  end loop;
end;
$backfill$;

do $verify$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='recompute_closed_position_from_trading_fills_v764'
  ) then
    raise exception 'CLOSED_SPLIT_LEDGER_REPAIR_FUNCTION_MISSING';
  end if;
end;
$verify$;
