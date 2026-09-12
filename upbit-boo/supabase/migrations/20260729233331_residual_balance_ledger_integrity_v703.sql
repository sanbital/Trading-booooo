-- Trading-booooo v7.0.3-RESIDUAL-BALANCE-LEDGER-INTEGRITY
--
-- v6.8.1 reconstructed historical residuals from initial quantity minus recorded SELL
-- orders. It could not see older balance-heal reductions or residual quantity consumed
-- by an overfilled later exit, so some AVAILABLE residual rows exceeded the coin that
-- still existed in the Binance account. Besides overstating economic PnL, that could make
-- a residual sweep request more base quantity than the account owned.
--
-- This is a fail-closed reconciliation:
--   * new entries must already be paused;
--   * Binance must have no active position;
--   * the account snapshot must be less than two minutes old;
--   * only AVAILABLE inventory is touched; and
--   * the account is never written to.
-- Excess ledger quantity is consumed FIFO. Closed-position PnL is then recomputed from
-- immutable cash proceeds/cost/fees plus only the residual value that physically remains.

lock table public.trading_positions in share row exclusive mode;
lock table public.trading_residual_inventory in share row exclusive mode;

create temp table v703_residual_repair_plan on commit drop as
with guard as (
  select s.balances
  from public.trading_account_snapshots s
  join public.trading_settings cfg
    on cfg.id = 1
   and cfg.pause_new_entries = true
  where s.exchange = 'binance'
    and s.captured_at >= now() - interval '2 minutes'
    and not exists (
      select 1
      from public.trading_positions p
      where p.exchange = 'binance'
        and p.state in (
          'ENTRY_PENDING',
          'OPEN',
          'EXITING',
          'RECONCILING',
          'RECONCILIATION_FAILED',
          'MANUAL_INTERVENTION_REQUIRED'
        )
    )
    and not exists (
      select 1
      from public.trading_residual_inventory pending
      where pending.exchange = 'binance'
        and pending.remaining_quantity > 0
        and pending.state in ('RESERVED_FOR_REENTRY', 'SWEEP_PENDING')
    )
  order by s.captured_at desc
  limit 1
),
account as (
  select
    upper(coalesce(b->>'currency', b->>'asset', '')) as asset,
    sum(
      greatest(0, public.safe_numeric_v6112(coalesce(b->>'balance', b->>'free'))) +
      greatest(0, public.safe_numeric_v6112(b->>'locked'))
    ) as account_quantity
  from guard g
  cross join lateral jsonb_array_elements(g.balances) b
  group by upper(coalesce(b->>'currency', b->>'asset', ''))
),
inventory as (
  select
    r.position_id,
    upper(r.asset) as asset,
    r.remaining_quantity,
    r.value_quote,
    r.mark_price,
    r.created_at,
    sum(r.remaining_quantity) over (partition by upper(r.asset)) as ledger_quantity,
    coalesce(a.account_quantity, 0) as account_quantity
  from public.trading_residual_inventory r
  left join account a on a.asset = upper(r.asset)
  where r.exchange = 'binance'
    and r.state = 'AVAILABLE'
    and r.remaining_quantity > 0
),
ranked as (
  select
    i.*,
    greatest(0, i.ledger_quantity - i.account_quantity) as excess_quantity,
    coalesce(
      sum(i.remaining_quantity) over (
        partition by i.asset
        order by i.created_at, i.position_id
        rows between unbounded preceding and 1 preceding
      ),
      0
    ) as prior_quantity
  from inventory i
),
reductions as (
  select
    r.*,
    least(
      r.remaining_quantity,
      greatest(0, r.excess_quantity - r.prior_quantity)
    ) as reduction_quantity
  from ranked r
  where r.excess_quantity >
    greatest(0.000000000001::numeric, r.account_quantity * 0.000000001)
)
select
  x.position_id,
  x.asset,
  x.ledger_quantity,
  x.account_quantity,
  x.remaining_quantity as before_quantity,
  greatest(0, x.remaining_quantity - x.reduction_quantity) as after_quantity,
  x.value_quote as before_value_quote,
  case
    when x.remaining_quantity > 0 then
      x.value_quote *
        greatest(0, x.remaining_quantity - x.reduction_quantity) /
        x.remaining_quantity
    else 0
  end as after_value_quote,
  x.reduction_quantity,
  case
    when x.remaining_quantity > 0 then
      x.value_quote * x.reduction_quantity / x.remaining_quantity
    else 0
  end as value_reduction_quote
from reductions x
where x.reduction_quantity > 0.000000000000001;

create temp table v703_residual_repair_summary on commit drop as
select
  asset,
  max(ledger_quantity) as before_ledger_quantity,
  max(account_quantity) as account_quantity,
  sum(reduction_quantity) as reduction_quantity,
  sum(value_reduction_quote) as value_reduction_quote,
  count(*) as repaired_rows
from v703_residual_repair_plan
group by asset;

update public.trading_positions p
set
  residual_quantity = plan.after_quantity,
  residual_value_quote = plan.after_value_quote,
  realized_pnl_quote =
    coalesce(p.realized_proceeds_quote, 0) +
    plan.after_value_quote -
    coalesce(p.realized_cost_quote, 0) -
    coalesce(p.paid_fees_quote, 0),
  marked_pnl_quote =
    coalesce(p.realized_proceeds_quote, 0) +
    plan.after_value_quote -
    coalesce(p.realized_cost_quote, 0) -
    coalesce(p.paid_fees_quote, 0),
  accounting_version = '7.0.3',
  metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
    'residual_balance_integrity_repair',
    jsonb_build_object(
      'version', '7.0.3',
      'repaired_at', now(),
      'reason', 'AVAILABLE_RESIDUAL_EXCEEDED_CURRENT_ACCOUNT_BALANCE',
      'asset', plan.asset,
      'before_quantity', plan.before_quantity,
      'after_quantity', plan.after_quantity,
      'before_value_quote', plan.before_value_quote,
      'after_value_quote', plan.after_value_quote,
      'account_asset_quantity', plan.account_quantity,
      'asset_ledger_quantity_before', plan.ledger_quantity
    )
  ),
  updated_at = now()
from v703_residual_repair_plan plan
where p.id = plan.position_id
  and p.state = 'CLOSED';

update public.trading_residual_inventory r
set
  original_quantity = greatest(0, r.original_quantity - plan.reduction_quantity),
  remaining_quantity = plan.after_quantity,
  value_quote = plan.after_value_quote,
  residual_pnl_quote =
    coalesce(r.realized_proceeds_quote, 0) -
    coalesce(r.paid_fees_quote, 0) +
    plan.after_value_quote -
    greatest(0, r.original_quantity - plan.reduction_quantity) *
      greatest(0, r.mark_price),
  state = case
    when plan.after_quantity <= 0.000000000001 then 'CONSUMED'
    else 'AVAILABLE'
  end,
  updated_at = now()
from v703_residual_repair_plan plan
where r.position_id = plan.position_id;

-- Keep row-level learning evidence consistent. Aggregate profiles remain online EWMA
-- history; corrected rows carry exact net_bps on every future inspection or rebuild.
update public.lob_online_outcomes o
set
  residual_quantity = p.residual_quantity,
  residual_value_quote = p.residual_value_quote,
  net_bps = case
    when coalesce(p.realized_cost_quote, 0) > 0
      then p.realized_pnl_quote / p.realized_cost_quote * 10000
    else 0
  end,
  profitable = p.realized_pnl_quote > 0,
  accounting_version = '7.0.3'
from public.trading_positions p
where o.position_id = p.id
  and exists (
    select 1
    from v703_residual_repair_plan plan
    where plan.position_id = p.id
  );

insert into public.trading_events(level, code, message, details)
select
  'WARNING',
  'RESIDUAL_BALANCE_LEDGER_REPAIRED',
  'binance:' || summary.asset || ' residual ledger reconciled to current account balance',
  jsonb_build_object(
    'version', '7.0.3',
    'asset', summary.asset,
    'before_ledger_quantity', summary.before_ledger_quantity,
    'account_quantity', summary.account_quantity,
    'after_ledger_quantity',
      summary.before_ledger_quantity - summary.reduction_quantity,
    'reduction_quantity', summary.reduction_quantity,
    'value_reduction_quote', summary.value_reduction_quote,
    'repaired_rows', summary.repaired_rows
  )
from v703_residual_repair_summary summary;

do $$
declare
  mismatch record;
begin
  select
    summary.asset,
    summary.account_quantity,
    coalesce(sum(r.remaining_quantity) filter (
      where r.state in ('AVAILABLE', 'RESERVED_FOR_REENTRY', 'SWEEP_PENDING')
    ), 0) as ledger_quantity
  into mismatch
  from v703_residual_repair_summary summary
  left join public.trading_residual_inventory r
    on r.exchange = 'binance'
   and upper(r.asset) = summary.asset
  group by summary.asset, summary.account_quantity
  having abs(
    coalesce(sum(r.remaining_quantity) filter (
      where r.state in ('AVAILABLE', 'RESERVED_FOR_REENTRY', 'SWEEP_PENDING')
    ), 0) - summary.account_quantity
  ) > greatest(0.000000000001::numeric, summary.account_quantity * 0.000000001)
  limit 1;

  if found then
    raise exception
      'V703_RESIDUAL_RECONCILIATION_FAILED asset=% account=% ledger=%',
      mismatch.asset,
      mismatch.account_quantity,
      mismatch.ledger_quantity;
  end if;
end;
$$;
