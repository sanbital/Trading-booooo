-- Trading-booooo v6.9.1 fee-ledger integrity verification (read only)
-- Run after migration 202607280001. Every check_status should be PASS.

with upbit_orders as (
  select
    o.id,
    greatest(
      public.fee_ledger_numeric_v691(o.raw_response ->> 'paid_fee'),
      public.fee_ledger_numeric_v691(o.raw_response #>> '{raw,paid_fee}')
    ) as exchange_fee,
    greatest(0, coalesce(o.paid_fee_quote, 0)) as stored_fee,
    (
      coalesce(o.raw_response ? 'paid_fee', false)
      or coalesce((o.raw_response -> 'raw') ? 'paid_fee', false)
    ) as has_exchange_fee_field
  from public.trading_orders o
  where lower(o.exchange) = 'upbit'
    and coalesce(o.executed_funds_quote, 0) > 0
)
select
  'UPBIT_ORDER_FEE_CAPTURE' as check_name,
  case when count(*) filter (
    where not has_exchange_fee_field
       or (exchange_fee > 0 and abs(exchange_fee - stored_fee) > 0.000001)
  ) = 0 then 'PASS' else 'FAIL' end as check_status,
  count(*) filter (
    where not has_exchange_fee_field
       or (exchange_fee > 0 and abs(exchange_fee - stored_fee) > 0.000001)
  ) as bad_rows
from upbit_orders;

with fill_totals as (
  select o.id, o.paid_fee_quote, coalesce(sum(f.fee_quote_estimate), 0) as fill_fee
  from public.trading_orders o
  left join public.trading_fills f on f.order_id = o.id
  where lower(o.exchange) = 'upbit'
    and coalesce(o.executed_funds_quote, 0) > 0
  group by o.id, o.paid_fee_quote
)
select
  'UPBIT_FILL_FEE_ALLOCATION' as check_name,
  case when count(*) filter (where paid_fee_quote > 0 and abs(paid_fee_quote - fill_fee) > 0.000001) = 0
    then 'PASS' else 'FAIL' end as check_status,
  count(*) filter (where paid_fee_quote > 0 and abs(paid_fee_quote - fill_fee) > 0.000001) as bad_rows
from fill_totals;

with ledger as (
  select
    p.id,
    p.realized_pnl_quote,
    sum(case when upper(o.side) = 'BUY' and upper(o.purpose) = 'ENTRY' then o.executed_funds_quote else 0 end) as cost,
    sum(case when upper(o.side) = 'SELL' then o.executed_funds_quote else 0 end) as proceeds,
    sum(coalesce(o.paid_fee_quote, 0)) as fees,
    p.residual_value_quote
  from public.trading_positions p
  join public.trading_orders o on o.position_id = p.id
  where lower(p.exchange) = 'upbit'
    and p.state = 'CLOSED'
    and coalesce(o.executed_funds_quote, 0) > 0
  group by p.id
)
select
  'UPBIT_CLOSED_PNL' as check_name,
  case when count(*) filter (
    where abs(realized_pnl_quote - (proceeds + coalesce(residual_value_quote, 0) - cost - fees)) > 0.000001
  ) = 0 then 'PASS' else 'FAIL' end as check_status,
  count(*) filter (
    where abs(realized_pnl_quote - (proceeds + coalesce(residual_value_quote, 0) - cost - fees)) > 0.000001
  ) as bad_rows
from ledger;

-- Confirm the exact example that exposed the defect.
select
  p.id as position_id,
  p.market,
  p.realized_cost_quote,
  p.realized_proceeds_quote,
  p.paid_fees_quote,
  p.realized_pnl_quote,
  p.metadata #>> '{fee_ledger_accounting,quality}' as fee_quality,
  p.accounting_version
from public.trading_positions p
where p.id = '612cb500-bc82-4520-a23e-7594f9c1c49e';


with binance_orders as (
  select
    o.id,
    o.executed_funds_quote,
    o.paid_fee_quote,
    exists (
      select 1
      from public.trading_fills f
      join public.trading_positions p on p.id = o.position_id
      where f.order_id = o.id
        and coalesce(f.fee_amount, 0) > 0
        and upper(coalesce(f.fee_asset, '')) = upper(coalesce(p.base_asset, ''))
    ) as exact_base_fee
  from public.trading_orders o
  where lower(o.exchange) = 'binance'
)
select
  'BINANCE_EXECUTED_ORDER_FEE' as check_name,
  case when count(*) filter (
    where coalesce(executed_funds_quote, 0) > 0
      and coalesce(paid_fee_quote, 0) <= 0
      and not exact_base_fee
  ) = 0 then 'PASS' else 'FAIL' end as check_status,
  count(*) filter (
    where coalesce(executed_funds_quote, 0) > 0
      and coalesce(paid_fee_quote, 0) <= 0
      and not exact_base_fee
  ) as bad_rows
from binance_orders;

select
  'ESTIMATED_FEE_LABEL_EXCLUSION' as check_name,
  case when count(*) = 0 then 'PASS' else 'FAIL' end as check_status,
  count(*) as bad_rows
from public.lob_online_outcomes o
join public.trading_positions p on p.id = o.position_id
where p.metadata #>> '{fee_ledger_accounting,quality}' = 'ESTIMATED_FEE_DETAIL'
   or exists (
     select 1
     from public.trading_orders ord
     where ord.position_id = p.id
       and (
         lower(coalesce(ord.raw_response #>> '{fee_accounting,estimated}', 'false')) = 'true'
         or ord.raw_response #>> '{fee_accounting,source}' in (
           'ESTIMATED_THIRD_ASSET', 'ESTIMATED_MISSING', 'MISSING'
         )
       )
   );
