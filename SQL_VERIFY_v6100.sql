-- Trading-booooo v6.10.0 read-only deployment verification
-- Expected: every check_status is PASS and bad_rows is 0.

select 'V610_MIGRATION_COLUMNS' as check_name,
       case when count(*) = 8 then 'PASS' else 'FAIL' end as check_status,
       8-count(*) as bad_rows
from information_schema.columns
where table_schema='public' and (
  (table_name='trading_positions' and column_name in ('reserved_quote','reserved_quantity','reservation_expires_at','fee_accounting_quality','marked_pnl_quote')) or
  (table_name='trading_settings' and column_name in ('scalp_max_strategy_exposure_pct','scalp_low_evidence_daily_loss_pct','asset_lock_clean_checks_required'))
);

select 'FEE_MISSING_EXECUTED_ORDERS' as check_name,
       case when count(*)=0 then 'PASS' else 'FAIL' end as check_status,
       count(*) as bad_rows
from public.trading_orders
where state='APPLIED' and coalesce(executed_funds_quote,0)>0
  and fee_accounting_quality in ('MISSING','LEGACY_UNVERIFIED');

with x as (
  select p.id, p.paid_fees_quote,
         coalesce(sum(case when upper(o.purpose)<>'RESIDUAL_SWEEP' then greatest(0,coalesce(o.paid_fee_quote,0)) else 0 end),0) order_fees
  from public.trading_positions p left join public.trading_orders o on o.position_id=p.id
  where p.state='CLOSED' group by p.id
)
select 'POSITION_FEE_TOTAL' check_name,
       case when count(*) filter(where abs(coalesce(paid_fees_quote,0)-order_fees)>0.000001)=0 then 'PASS' else 'FAIL' end check_status,
       count(*) filter(where abs(coalesce(paid_fees_quote,0)-order_fees)>0.000001) bad_rows
from x;

with x as (
  select p.id,p.realized_pnl_quote,p.residual_value_quote,
         coalesce(sum(case when upper(o.side)='BUY' and upper(o.purpose)='ENTRY' then o.executed_funds_quote else 0 end),0) cost,
         coalesce(sum(case when upper(o.side)='SELL' and upper(o.purpose)<>'RESIDUAL_SWEEP' then o.executed_funds_quote else 0 end),0) proceeds,
         coalesce(sum(case when upper(o.purpose)<>'RESIDUAL_SWEEP' then o.paid_fee_quote else 0 end),0) fees
  from public.trading_positions p join public.trading_orders o on o.position_id=p.id
  where p.state='CLOSED' group by p.id
)
select 'CLOSED_ECONOMIC_PNL' check_name,
       case when count(*) filter(where abs(realized_pnl_quote-(proceeds+coalesce(residual_value_quote,0)-cost-fees))>0.000001)=0 then 'PASS' else 'FAIL' end check_status,
       count(*) filter(where abs(realized_pnl_quote-(proceeds+coalesce(residual_value_quote,0)-cost-fees))>0.000001) bad_rows
from x;

select 'ZERO_QUANTITY_ACTIVE_POSITIONS' check_name,
       case when count(*)=0 then 'PASS' else 'FAIL' end check_status,
       count(*) bad_rows
from public.trading_positions
where state in ('OPEN','EXITING','MANUAL_INTERVENTION_REQUIRED') and coalesce(remaining_quantity,0)<=0;

select 'EXPIRED_RESERVATIONS' check_name,
       case when count(*)=0 then 'PASS' else 'FAIL' end check_status,
       count(*) bad_rows
from public.trading_positions
where state='ENTRY_PENDING' and reservation_expires_at<now() and (reserved_quote>0 or reserved_quantity>0);

select 'INVALID_ACTIVE_LOCKS' check_name,
       case when count(*)=0 then 'PASS' else 'FAIL' end check_status,
       count(*) bad_rows
from public.trading_asset_locks
where state='LOCKED' and coalesce(reason,'')='';

select 'RESIDUAL_LEDGER_COVERAGE' check_name,
       case when count(*)=0 then 'PASS' else 'FAIL' end check_status,
       count(*) bad_rows
from public.trading_positions p
left join public.trading_residual_inventory r on r.position_id=p.id
where p.state='CLOSED' and coalesce(p.residual_quantity,0)>0 and r.position_id is null;

select 'LEARNING_DATA_QUALITY' check_name,
       case when count(*)=0 then 'PASS' else 'FAIL' end check_status,
       count(*) bad_rows
from public.lob_online_outcomes
where accounting_quality not in ('NO_RESIDUAL','RESIDUAL_MARKED_TO_EXIT')
   or fee_accounting_quality not in ('EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED')
   or prediction_basis<>'FILL_CONDITIONAL'
   or engine_version<>'6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE';

select 'POLICY_STAGES' check_name,
       case when count(*) filter(where status='CHALLENGER' and traffic_fraction not in (0.15,0.25,0.50))=0 then 'PASS' else 'FAIL' end check_status,
       count(*) filter(where status='CHALLENGER' and traffic_fraction not in (0.15,0.25,0.50)) bad_rows
from public.lob_policy_versions;

select 'EXPOSURE_LIMIT' check_name,
       case when coalesce(sum(e.total_booked_exposure_quote),0) <=
         coalesce((select scalp_max_strategy_exposure_pct/100.0 from public.trading_settings where id=1),1) *
         coalesce((select sum(managed_capital_quote) from (
           select distinct on(exchange) exchange,managed_capital_quote from public.trading_account_snapshots order by exchange,captured_at desc
         ) z),0) + 0.000001 then 'PASS' else 'FAIL' end check_status,
       0::bigint bad_rows
from public.trading_exposure_ledger_v610 e;
