-- Trading-booooo v6.8.1-RESIDUAL-LABEL-INTEGRITY
--
-- Binance/Upbit market exits are rounded down to the exchange quantity step. The previous
-- close RPC operationally closed a position when the leftover value was below the dust
-- threshold, but then set remaining_quantity to zero and calculated PnL from cash proceeds
-- only. The still-owned residual coin therefore became a fictitious loss in both the
-- dashboard and lob_online_outcomes. Base-asset sell commission made the mismatch larger.
--
-- This migration:
--   1. stores residual quantity/value separately from tradable remaining quantity,
--   2. subtracts base-asset sell commission from the physical residual,
--   3. includes marked residual value in economic realized PnL,
--   4. repairs prior one-step dust closes, and
--   5. rebuilds the online learner from corrected labels.
-- It does not change slots, allocation, entry thresholds, stops, targets, or loss limits.

alter table public.trading_positions
  add column if not exists residual_quantity numeric not null default 0,
  add column if not exists residual_value_quote numeric not null default 0,
  add column if not exists residual_fee_base numeric not null default 0,
  add column if not exists accounting_version text;

alter table public.trading_positions
  drop constraint if exists trading_positions_residual_quantity_ck,
  drop constraint if exists trading_positions_residual_value_quote_ck,
  drop constraint if exists trading_positions_residual_fee_base_ck;

alter table public.trading_positions
  add constraint trading_positions_residual_quantity_ck
    check (residual_quantity >= 0) not valid,
  add constraint trading_positions_residual_value_quote_ck
    check (residual_value_quote >= 0) not valid,
  add constraint trading_positions_residual_fee_base_ck
    check (residual_fee_base >= 0) not valid;

alter table public.trading_positions
  validate constraint trading_positions_residual_quantity_ck;
alter table public.trading_positions
  validate constraint trading_positions_residual_value_quote_ck;
alter table public.trading_positions
  validate constraint trading_positions_residual_fee_base_ck;

alter table public.lob_online_outcomes
  add column if not exists residual_quantity numeric not null default 0,
  add column if not exists residual_value_quote numeric not null default 0,
  add column if not exists accounting_quality text not null default 'LEGACY_UNVERIFIED',
  add column if not exists accounting_version text;

alter table public.lob_online_outcomes
  drop constraint if exists lob_online_outcomes_residual_quantity_ck,
  drop constraint if exists lob_online_outcomes_residual_value_quote_ck,
  drop constraint if exists lob_online_outcomes_accounting_quality_ck;

alter table public.lob_online_outcomes
  add constraint lob_online_outcomes_residual_quantity_ck
    check (residual_quantity >= 0) not valid,
  add constraint lob_online_outcomes_residual_value_quote_ck
    check (residual_value_quote >= 0) not valid,
  add constraint lob_online_outcomes_accounting_quality_ck
    check (accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT', 'LEGACY_UNVERIFIED')) not valid;

alter table public.lob_online_outcomes
  validate constraint lob_online_outcomes_residual_quantity_ck;
alter table public.lob_online_outcomes
  validate constraint lob_online_outcomes_residual_value_quote_ck;
alter table public.lob_online_outcomes
  validate constraint lob_online_outcomes_accounting_quality_ck;

-- Same RPC signature as prior releases: migration-first and function-first deployments
-- remain compatible. The authoritative base fee is read from trading_fills, which has
-- already been written before this RPC is invoked.
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
  v_now timestamptz := now();
  v_sold numeric;
  v_base_fee numeric;
  v_order_fee_quote numeric;
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
  select * into v_order from public.trading_orders where id = p_order_id for update;
  if not found then raise exception 'trading order % not found', p_order_id; end if;
  if v_order.side <> 'SELL' or v_order.purpose = 'ENTRY' then
    raise exception 'order % is not an exit order', p_order_id;
  end if;

  select * into v_position from public.trading_positions where id = v_order.position_id for update;
  if not found then raise exception 'position for order % not found', p_order_id; end if;

  if v_order.state = 'APPLIED' then
    return jsonb_build_object(
      'applied', false,
      'closed', v_position.state = 'CLOSED',
      'position', to_jsonb(v_position),
      'order', to_jsonb(v_order)
    );
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 then
    raise exception 'exit fill must be positive';
  end if;

  v_sold := least(greatest(0, v_position.remaining_quantity), greatest(0, p_fill_quantity));
  if v_sold <= 0 then
    update public.trading_orders
       set state = 'APPLIED', completed_at = coalesce(completed_at, v_now), updated_at = v_now
     where id = p_order_id
     returning * into v_order;
    return jsonb_build_object(
      'applied', false,
      'closed', v_position.state = 'CLOSED',
      'position', to_jsonb(v_position),
      'order', to_jsonb(v_order)
    );
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
  into v_base_fee, v_order_fee_quote
  from public.trading_fills f
  where f.order_id = p_order_id;

  v_after_sale := greatest(0, v_position.remaining_quantity - v_sold);
  -- A base commission cannot consume more than what remains after the sold quantity.
  v_base_fee := least(v_after_sale, greatest(0, coalesce(v_base_fee, 0)));
  v_remaining := greatest(0, v_after_sale - v_base_fee);
  v_proceeds := v_position.realized_proceeds_quote +
    greatest(0, coalesce(p_fill_funds, v_sold * p_fill_price));
  v_fees := v_position.paid_fees_quote + greatest(0, coalesce(v_order_fee_quote, p_fill_fee_quote, 0));
  v_closed := v_remaining <= 0.000000000001 or
    v_remaining * p_fill_price < greatest(0, p_dust_value_quote);
  v_residual_quantity := case when v_closed then v_remaining else 0 end;
  v_residual_value := case when v_closed then v_remaining * p_fill_price else 0 end;
  v_quality := case
    when v_closed and v_residual_quantity > 0 then 'RESIDUAL_MARKED_TO_EXIT'
    else 'NO_RESIDUAL'
  end;
  -- Cash proceeds remain separately auditable in realized_proceeds_quote. PnL is economic:
  -- quote cash + still-owned residual mark - entry cost - quote/third-asset fee estimate.
  v_pnl := case
    when v_closed then
      v_proceeds + v_residual_value - v_position.realized_cost_quote - v_fees
    else v_position.realized_pnl_quote
  end;

  update public.trading_positions set
    remaining_quantity = case when v_closed then 0 else v_remaining end,
    residual_quantity = case when v_closed then v_residual_quantity else 0 end,
    residual_value_quote = case when v_closed then v_residual_value else 0 end,
    residual_fee_base = case when v_closed then v_base_fee else 0 end,
    accounting_version = case when v_closed then '6.8.1' else accounting_version end,
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
        'exit_residual_accounting', jsonb_build_object(
          'quality', v_quality,
          'version', '6.8.1',
          'sold_quantity', v_sold,
          'base_fee_quantity', v_base_fee,
          'residual_quantity', v_residual_quantity,
          'residual_value_quote', v_residual_value,
          'mark_price', p_fill_price,
          'dust_value_quote', greatest(0, p_dust_value_quote)
        )
      ),
    updated_at = v_now
  where id = v_position.id returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED',
    executed_volume = p_fill_quantity,
    average_fill_price = p_fill_price,
    executed_funds_quote = greatest(0, coalesce(p_fill_funds, p_fill_quantity * p_fill_price)),
    paid_fee_quote = greatest(0, coalesce(v_order_fee_quote, p_fill_fee_quote, 0)),
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = p_order_id returning * into v_order;

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

-- Start conservatively: old closed rows are excluded from learning until their physical
-- remainder can be reconstructed from APPLIED sell orders and fee fills.
update public.trading_positions p
set accounting_version = '6.8.1',
    metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
      'exit_residual_accounting', jsonb_build_object(
        'quality', 'LEGACY_UNVERIFIED',
        'version', '6.8.1',
        'historical_repair', false
      )
    ),
    updated_at = now()
where p.state = 'CLOSED'
  and coalesce(p.accounting_version, '') <> '6.8.1';

-- Repair historical CLOSED positions only when the inferred leftover is within the same
-- operational dust threshold that would have closed the position (KRW 1,000 / USDT 1).
-- Material unsold quantities remain LEGACY_UNVERIFIED and cannot contaminate learning.
with sell_orders as (
  select
    o.position_id,
    sum(greatest(0, coalesce(o.executed_volume, 0))) as sold_quantity,
    (array_agg(
      coalesce(o.average_fill_price, 0)
      order by coalesce(o.completed_at, o.updated_at, o.created_at) desc
    ))[1] as last_exit_price
  from public.trading_orders o
  where o.side = 'SELL'
    and o.state = 'APPLIED'
  group by o.position_id
), sell_base_fees as (
  select
    o.position_id,
    sum(greatest(0, coalesce(f.fee_amount, 0))) as base_fee_quantity
  from public.trading_orders o
  join public.trading_positions p on p.id = o.position_id
  join public.trading_fills f on f.order_id = o.id
  where o.side = 'SELL'
    and o.state = 'APPLIED'
    and upper(coalesce(f.fee_asset, '')) = upper(coalesce(p.base_asset, ''))
  group by o.position_id
), reconstructed as (
  select
    p.id,
    greatest(
      0,
      coalesce(p.initial_quantity, 0) - coalesce(s.sold_quantity, 0) -
        coalesce(b.base_fee_quantity, 0)
    ) as residual_quantity,
    greatest(0, coalesce(s.last_exit_price, p.average_entry_price, 0)) as mark_price,
    greatest(0, coalesce(b.base_fee_quantity, 0)) as base_fee_quantity,
    case when p.exchange = 'upbit' then 1000::numeric else 1::numeric end as dust_limit
  from public.trading_positions p
  join sell_orders s on s.position_id = p.id
  left join sell_base_fees b on b.position_id = p.id
  where p.state = 'CLOSED'
    and coalesce(p.residual_value_quote, 0) = 0
), corrections as (
  select
    r.*,
    r.residual_quantity * r.mark_price as residual_value_quote
  from reconstructed r
  where r.residual_quantity > 0.000000000001
    and r.residual_quantity * r.mark_price > 0
    and r.residual_quantity * r.mark_price <= r.dust_limit * 1.05
)
update public.trading_positions p
set residual_quantity = c.residual_quantity,
    residual_value_quote = c.residual_value_quote,
    residual_fee_base = c.base_fee_quantity,
    realized_pnl_quote = coalesce(p.realized_pnl_quote, 0) + c.residual_value_quote,
    metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
      'exit_residual_accounting', jsonb_build_object(
        'quality', 'RESIDUAL_MARKED_TO_EXIT',
        'version', '6.8.1',
        'historical_repair', true,
        'base_fee_quantity', c.base_fee_quantity,
        'residual_quantity', c.residual_quantity,
        'residual_value_quote', c.residual_value_quote,
        'mark_price', c.mark_price
      )
    ),
    updated_at = now()
from corrections c
where p.id = c.id;

-- A reconstructed exact close has no missing asset and is also safe to learn from.
with sell_orders as (
  select
    o.position_id,
    sum(greatest(0, coalesce(o.executed_volume, 0))) as sold_quantity
  from public.trading_orders o
  where o.side = 'SELL'
    and o.state = 'APPLIED'
  group by o.position_id
), sell_base_fees as (
  select
    o.position_id,
    sum(greatest(0, coalesce(f.fee_amount, 0))) as base_fee_quantity
  from public.trading_orders o
  join public.trading_positions p on p.id = o.position_id
  join public.trading_fills f on f.order_id = o.id
  where o.side = 'SELL'
    and o.state = 'APPLIED'
    and upper(coalesce(f.fee_asset, '')) = upper(coalesce(p.base_asset, ''))
  group by o.position_id
), exact_closes as (
  select p.id
  from public.trading_positions p
  join sell_orders s on s.position_id = p.id
  left join sell_base_fees b on b.position_id = p.id
  where p.state = 'CLOSED'
    and greatest(
      0,
      coalesce(p.initial_quantity, 0) - coalesce(s.sold_quantity, 0) -
        coalesce(b.base_fee_quantity, 0)
    ) <= 0.000000000001
)
update public.trading_positions p
set metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
      'exit_residual_accounting', jsonb_build_object(
        'quality', 'NO_RESIDUAL',
        'version', '6.8.1',
        'historical_repair', true,
        'residual_quantity', 0,
        'residual_value_quote', 0
      )
    ),
    updated_at = now()
from exact_closes e
where p.id = e.id;

-- Enrich every outcome with the corrected position accounting evidence.
create or replace function public.enrich_lob_online_outcome_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_metadata jsonb;
  v_cost numeric;
  v_residual_quantity numeric;
  v_residual_value numeric;
  v_accounting_version text;
  v_version_text text;
  v_version bigint;
  v_lane text;
begin
  select
    coalesce(p.metadata, '{}'::jsonb),
    greatest(0, coalesce(p.realized_cost_quote, 0)),
    greatest(0, coalesce(p.residual_quantity, 0)),
    greatest(0, coalesce(p.residual_value_quote, 0)),
    nullif(p.accounting_version, '')
  into
    v_metadata,
    v_cost,
    v_residual_quantity,
    v_residual_value,
    v_accounting_version
  from public.trading_positions p
  where p.id = new.position_id;

  if coalesce(v_metadata #>> '{exit_residual_accounting,quality}', 'LEGACY_UNVERIFIED') =
      'LEGACY_UNVERIFIED' then
    return null;
  end if;

  v_version_text := v_metadata #>> '{lob_signal,policy,version}';
  if coalesce(v_version_text, '') ~ '^[0-9]+$' then
    v_version := v_version_text::bigint;
    if not exists (select 1 from public.lob_policy_versions p where p.version = v_version) then
      v_version := null;
    end if;
  end if;

  v_lane := upper(coalesce(nullif(v_metadata #>> '{lob_signal,policy,lane}', ''), 'LEGACY'));
  if v_lane not in ('CHAMPION', 'CHALLENGER', 'CONTROL') then
    v_lane := 'LEGACY';
  end if;

  new.policy_version := v_version;
  new.policy_lane := v_lane;
  new.realized_cost_quote := v_cost;
  new.capital_seconds := v_cost * greatest(0, new.held_seconds);
  new.engine_version := nullif(v_metadata ->> 'engine_version', '');
  new.residual_quantity := v_residual_quantity;
  new.residual_value_quote := v_residual_value;
  new.accounting_quality := coalesce(
    nullif(v_metadata #>> '{exit_residual_accounting,quality}', ''),
    case when v_residual_quantity > 0 then 'RESIDUAL_MARKED_TO_EXIT' else 'NO_RESIDUAL' end
  );
  new.accounting_version := coalesce(v_accounting_version, '6.8.1');
  return new;
end;
$$;

-- Future backfills also skip rows whose physical accounting could not be reconstructed.
create or replace function public.backfill_lob_online_learning(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select p.id
      from public.trading_positions p
      left join public.lob_online_outcomes o on o.position_id = p.id
     where p.state = 'CLOSED'
       and not p.is_paper
       and p.metadata ? 'lob_signal'
       and coalesce(
         p.metadata #>> '{exit_residual_accounting,quality}',
         'LEGACY_UNVERIFIED'
       ) <> 'LEGACY_UNVERIFIED'
       and o.position_id is null
     order by p.closed_at asc
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    perform public.learn_lob_trade_outcome(v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.backfill_lob_online_learning(integer) from public;
grant execute on function public.backfill_lob_online_learning(integer) to service_role;

-- Existing profiles are EWMA aggregates. Updating net_bps in-place would leave the old
-- distorted values embedded in those aggregates, so rebuild the derived ledger once from
-- corrected positions. The position_id primary key keeps this deterministic and idempotent.
delete from public.lob_market_profiles;
delete from public.lob_online_outcomes;
select public.backfill_lob_online_learning(5000);
