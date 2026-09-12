begin;

-- Run the fill-ledger repair in bounded batches. Production hotfix deployment ran
-- these batches separately to stay below the API timeout; on a fresh database this
-- migration completes the same work before it records success.
do $backfill$
declare
  v_updated integer;
  v_batches integer := 0;
begin
  loop
    v_updated := public.backfill_closed_binance_position_economics(25);
    v_batches := v_batches + 1;
    exit when v_updated = 0;
    if v_batches > 100 then
      raise exception 'CLOSED_BINANCE_BACKFILL_DID_NOT_CONVERGE';
    end if;
  end loop;
end;
$backfill$;

do $verify$
declare
  v_mismatch_count integer;
begin
  with fill_totals as (
    select
      f.position_id,
      coalesce(sum(case
        when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) = upper(coalesce(f.base_asset,''))
          then greatest(f.quantity - coalesce(f.fee_amount, 0), 0)
        when f.side = 'BUY' then f.quantity else 0 end), 0) as entry_qty,
      coalesce(sum(case when f.side = 'BUY' then f.quote_amount else 0 end), 0) as entry_cost,
      coalesce(sum(case
        when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) <> upper(coalesce(f.base_asset,''))
          then coalesce(f.fee_quote_amount, 0) else 0 end), 0) as entry_fee,
      coalesce(sum(case when f.side = 'SELL' then f.quantity else 0 end), 0) as sold_qty,
      coalesce(sum(case when f.side = 'SELL' then f.quote_amount else 0 end), 0) as proceeds,
      coalesce(sum(case when f.side = 'SELL' then coalesce(f.fee_quote_amount, 0) else 0 end), 0) as sell_fee
    from public.exchange_trade_fills f
    where f.exchange = 'binance'
    group by f.position_id
  ), expected as (
    select
      p.id,
      ft.entry_cost * least(ft.sold_qty / nullif(ft.entry_qty, 0), 1) as realized_cost,
      ft.proceeds,
      ft.entry_fee * least(ft.sold_qty / nullif(ft.entry_qty, 0), 1) + ft.sell_fee as fees
    from public.trading_positions p
    join fill_totals ft on ft.position_id = p.id
    where p.exchange = 'binance'
      and p.state = 'CLOSED'
      and coalesce(p.is_paper, false) = false
      and ft.entry_qty > 0
      and ft.sold_qty / ft.entry_qty >= 0.995
  )
  select count(*) into v_mismatch_count
  from expected e
  join public.trading_positions p on p.id = e.id
  where abs(coalesce(p.realized_cost_quote, 0) - e.realized_cost) > 0.00000001
     or abs(coalesce(p.realized_proceeds_quote, 0) - e.proceeds) > 0.00000001
     or abs(coalesce(p.paid_fees_quote, 0) - e.fees) > 0.00000001
     or abs(
       coalesce(p.realized_pnl_quote, 0) -
       (e.proceeds - e.realized_cost - e.fees)
     ) > 0.00000001;

  if v_mismatch_count > 0 then
    raise exception 'CLOSED_BINANCE_FILL_LEDGER_MISMATCH count=%', v_mismatch_count;
  end if;
end;
$verify$;

commit;
