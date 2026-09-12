-- Trading-booooo v6.9.1-FEE-LEDGER-INTEGRITY
--
-- Upbit exposes the exact order-level paid_fee while its individual trade rows omit fee.
-- The previous runtime trusted zero per-trade fee fields and discarded the positive
-- aggregate fee. This migration repairs order/fill/position accounting and rebuilds LOB
-- learning labels from corrected net PnL. It is idempotent.

create or replace function public.fee_ledger_numeric_v691(p_value text)
returns numeric
language sql
immutable
as $$
  select case
    when trim(coalesce(p_value, '')) ~ '^[+]?[0-9]+([.][0-9]+)?$'
      then trim(p_value)::numeric
    else 0::numeric
  end
$$;

create or replace function public.normalize_upbit_order_fee_v691()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exchange_fee numeric;
begin
  if lower(coalesce(new.exchange, '')) <> 'upbit' then
    return new;
  end if;

  v_exchange_fee := greatest(
    public.fee_ledger_numeric_v691(new.raw_response ->> 'paid_fee'),
    public.fee_ledger_numeric_v691(new.raw_response #>> '{raw,paid_fee}')
  );

  if v_exchange_fee > greatest(0, coalesce(new.paid_fee_quote, 0)) then
    new.paid_fee_quote := v_exchange_fee;
    new.fee_asset := 'KRW';
  end if;
  return new;
end;
$$;

drop trigger if exists trading_orders_normalize_upbit_fee_v691 on public.trading_orders;
create trigger trading_orders_normalize_upbit_fee_v691
before insert or update of raw_response, paid_fee_quote, fee_asset
on public.trading_orders
for each row execute function public.normalize_upbit_order_fee_v691();

create or replace function public.allocate_upbit_order_fee_to_fills_v691(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee numeric;
  v_total_funds numeric;
  v_fill_count integer;
begin
  select greatest(0, coalesce(o.paid_fee_quote, 0))
    into v_fee
    from public.trading_orders o
   where o.id = p_order_id
     and lower(o.exchange) = 'upbit';

  if coalesce(v_fee, 0) <= 0 then
    return;
  end if;

  select coalesce(sum(greatest(0, coalesce(f.funds_quote, 0))), 0), count(*)
    into v_total_funds, v_fill_count
    from public.trading_fills f
   where f.order_id = p_order_id;

  if coalesce(v_fill_count, 0) <= 0 then
    return;
  end if;

  update public.trading_fills f
     set fee_amount = case
           when v_total_funds > 0
             then v_fee * greatest(0, coalesce(f.funds_quote, 0)) / v_total_funds
           else v_fee / v_fill_count
         end,
         fee_asset = 'KRW',
         fee_quote_estimate = case
           when v_total_funds > 0
             then v_fee * greatest(0, coalesce(f.funds_quote, 0)) / v_total_funds
           else v_fee / v_fill_count
         end
   where f.order_id = p_order_id;
end;
$$;

create or replace function public.refresh_upbit_fill_fee_v691()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  perform public.allocate_upbit_order_fee_to_fills_v691(new.order_id);
  return new;
end;
$$;

drop trigger if exists trading_fills_refresh_upbit_fee_v691 on public.trading_fills;
create trigger trading_fills_refresh_upbit_fee_v691
after insert or update of funds_quote, fee_amount, fee_quote_estimate
on public.trading_fills
for each row execute function public.refresh_upbit_fill_fee_v691();

create or replace function public.refresh_upbit_order_fill_fee_v691()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.allocate_upbit_order_fee_to_fills_v691(new.id);
  return new;
end;
$$;

drop trigger if exists trading_orders_refresh_upbit_fill_fee_v691 on public.trading_orders;
create trigger trading_orders_refresh_upbit_fill_fee_v691
after insert or update of paid_fee_quote, raw_response
on public.trading_orders
for each row execute function public.refresh_upbit_order_fill_fee_v691();

-- Backfill exact aggregate fees retained in the exchange response.
update public.trading_orders o
   set paid_fee_quote = greatest(
         greatest(0, coalesce(o.paid_fee_quote, 0)),
         public.fee_ledger_numeric_v691(o.raw_response ->> 'paid_fee'),
         public.fee_ledger_numeric_v691(o.raw_response #>> '{raw,paid_fee}')
       ),
       fee_asset = 'KRW',
       updated_at = now()
 where lower(o.exchange) = 'upbit'
   and greatest(
         public.fee_ledger_numeric_v691(o.raw_response ->> 'paid_fee'),
         public.fee_ledger_numeric_v691(o.raw_response #>> '{raw,paid_fee}')
       ) > greatest(0, coalesce(o.paid_fee_quote, 0));

-- Fail closed for retained Upbit rows whose exchange response does not contain any
-- authoritative aggregate fee field. These rows remain visible but cannot vote.
update public.trading_orders o
   set raw_response = coalesce(o.raw_response, '{}'::jsonb) || jsonb_build_object(
         'fee_accounting', jsonb_build_object(
           'version', '6.9.1',
           'source', 'MISSING',
           'fee_quote', greatest(0, coalesce(o.paid_fee_quote, 0)),
           'estimated', false,
           'complete', false,
           'historical_repair', true
         )
       ),
       updated_at = now()
 where lower(o.exchange) = 'upbit'
   and coalesce(o.executed_funds_quote, 0) > 0
   and not (
     coalesce(o.raw_response ? 'paid_fee', false)
     or coalesce((o.raw_response -> 'raw') ? 'paid_fee', false)
   );

do $$
declare
  v_order record;
begin
  for v_order in
    select o.id
      from public.trading_orders o
     where lower(o.exchange) = 'upbit'
       and coalesce(o.paid_fee_quote, 0) > 0
  loop
    perform public.allocate_upbit_order_fee_to_fills_v691(v_order.id);
  end loop;
end;
$$;

-- Repair historical Binance third-asset or missing-detail commissions conservatively.
-- Quote commissions already recorded remain untouched; base-asset commissions stay in
-- quantity/residual accounting and are never added again as quote fees.
update public.trading_fills f
   set fee_quote_estimate = greatest(0, coalesce(f.funds_quote, 0)) * 0.001
  from public.trading_orders o, public.trading_positions p
 where f.order_id = o.id
   and o.position_id = p.id
   and lower(o.exchange) = 'binance'
   and coalesce(f.fee_amount, 0) > 0
   and coalesce(f.fee_quote_estimate, 0) = 0
   and upper(coalesce(f.fee_asset, '')) not in (
     upper(coalesce(p.quote_currency, 'USDT')),
     upper(coalesce(p.base_asset, ''))
   );

with estimated_third_asset_orders as (
  select
    o.id,
    coalesce(sum(greatest(0, coalesce(f.fee_quote_estimate, 0))), 0) as fee_quote
  from public.trading_orders o
  join public.trading_positions p on p.id = o.position_id
  join public.trading_fills f on f.order_id = o.id
  where lower(o.exchange) = 'binance'
    and coalesce(f.fee_amount, 0) > 0
    and upper(coalesce(f.fee_asset, '')) not in (
      upper(coalesce(p.quote_currency, 'USDT')),
      upper(coalesce(p.base_asset, ''))
    )
  group by o.id
)
update public.trading_orders o
   set raw_response = coalesce(o.raw_response, '{}'::jsonb) || jsonb_build_object(
         'fee_accounting', jsonb_build_object(
           'version', '6.9.1',
           'source', 'ESTIMATED_THIRD_ASSET',
           'fee_quote', e.fee_quote,
           'estimated', true,
           'complete', true,
           'historical_repair', true
         )
       ),
       updated_at = now()
  from estimated_third_asset_orders e
 where o.id = e.id;

with binance_order_fees as (
  select
    o.id,
    coalesce(sum(case
      when upper(coalesce(f.fee_asset, '')) = upper(coalesce(p.base_asset, '')) then 0
      when upper(coalesce(f.fee_asset, '')) = upper(coalesce(p.quote_currency, 'USDT'))
        then greatest(0, coalesce(f.fee_amount, 0))
      else greatest(0, coalesce(f.fee_quote_estimate, 0))
    end), 0) as fee_quote
  from public.trading_orders o
  join public.trading_positions p on p.id = o.position_id
  join public.trading_fills f on f.order_id = o.id
  where lower(o.exchange) = 'binance'
  group by o.id
)
update public.trading_orders o
   set paid_fee_quote = greatest(coalesce(o.paid_fee_quote, 0), b.fee_quote),
       updated_at = now()
  from binance_order_fees b
 where o.id = b.id
   and b.fee_quote > coalesce(o.paid_fee_quote, 0);

update public.trading_orders o
   set paid_fee_quote = greatest(0, coalesce(o.executed_funds_quote, 0)) * 0.001,
       fee_asset = coalesce(nullif(o.fee_asset, ''), 'ESTIMATED_MISSING'),
       raw_response = coalesce(o.raw_response, '{}'::jsonb) || jsonb_build_object(
         'fee_accounting', jsonb_build_object(
           'version', '6.9.1',
           'source', 'ESTIMATED_MISSING',
           'fee_quote', greatest(0, coalesce(o.executed_funds_quote, 0)) * 0.001,
           'estimated', true,
           'complete', false,
           'historical_repair', true
         )
       ),
       updated_at = now()
 where lower(o.exchange) = 'binance'
   and coalesce(o.executed_funds_quote, 0) > 0
   and coalesce(o.paid_fee_quote, 0) = 0
   and not exists (
     select 1
       from public.trading_fills f
      where f.order_id = o.id
        and coalesce(f.fee_amount, 0) > 0
   );

-- Recompute the economic ledger from actual fills. Rows without executed funds are ignored.
with ledger as (
  select
    p.id,
    coalesce(sum(case
      when upper(o.side) = 'BUY' and upper(o.purpose) = 'ENTRY'
        then greatest(0, coalesce(o.executed_funds_quote, 0))
      else 0 end), 0) as entry_funds,
    coalesce(sum(case
      when upper(o.side) = 'SELL'
        then greatest(0, coalesce(o.executed_funds_quote, 0))
      else 0 end), 0) as exit_funds,
    coalesce(sum(greatest(0, coalesce(o.paid_fee_quote, 0))), 0) as fees
  from public.trading_positions p
  join public.trading_orders o on o.position_id = p.id
  where lower(p.exchange) in ('upbit', 'binance')
    and coalesce(o.executed_funds_quote, 0) > 0
  group by p.id
)
update public.trading_positions p
   set realized_cost_quote = l.entry_funds,
       realized_proceeds_quote = l.exit_funds,
       paid_fees_quote = l.fees,
       realized_pnl_quote = case
         when p.state = 'CLOSED'
           then l.exit_funds + greatest(0, coalesce(p.residual_value_quote, 0)) - l.entry_funds - l.fees
         else p.realized_pnl_quote
       end,
       accounting_version = case when p.state = 'CLOSED' then '6.9.1-FEE-LEDGER' else p.accounting_version end,
       metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
         'fee_ledger_accounting', jsonb_build_object(
           'quality', case when lower(p.exchange) = 'upbit' then 'AGGREGATE_EXACT' else 'VERIFIED_OR_BASE_ASSET' end,
           'version', '6.9.1',
           'entry_funds_quote', l.entry_funds,
           'exit_funds_quote', l.exit_funds,
           'total_fees_quote', l.fees,
           'repaired_at', now()
         )
       ),
       updated_at = now()
  from ledger l
 where p.id = l.id
   and l.entry_funds > 0;

-- Any position that required an estimated third-asset conversion or a no-detail fee
-- fallback remains visible in performance, but cannot vote in online learning or policy
-- promotion until exact quote-equivalent commission evidence exists.
update public.trading_positions p
   set metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
         'fee_ledger_accounting', coalesce(p.metadata -> 'fee_ledger_accounting', '{}'::jsonb) ||
           jsonb_build_object('quality', 'ESTIMATED_FEE_DETAIL', 'version', '6.9.1')
       ),
       updated_at = now()
 where exists (
   select 1
     from public.trading_orders o
    where o.position_id = p.id
      and (
        lower(coalesce(o.raw_response #>> '{fee_accounting,estimated}', 'false')) = 'true'
        or o.raw_response #>> '{fee_accounting,source}' in (
          'ESTIMATED_THIRD_ASSET', 'ESTIMATED_MISSING', 'MISSING'
        )
      )
 );

create or replace function public.guard_lob_outcome_fee_quality_v691()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
      from public.trading_positions p
     where p.id = new.position_id
       and (
         coalesce(p.metadata #>> '{fee_ledger_accounting,quality}', '') = 'ESTIMATED_FEE_DETAIL'
         or exists (
           select 1
             from public.trading_orders o
            where o.position_id = p.id
              and (
                lower(coalesce(o.raw_response #>> '{fee_accounting,estimated}', 'false')) = 'true'
                or o.raw_response #>> '{fee_accounting,source}' in (
                  'ESTIMATED_THIRD_ASSET', 'ESTIMATED_MISSING', 'MISSING'
                )
              )
         )
       )
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists aa_guard_lob_outcome_fee_quality_v691 on public.lob_online_outcomes;
create trigger aa_guard_lob_outcome_fee_quality_v691
before insert or update on public.lob_online_outcomes
for each row execute function public.guard_lob_outcome_fee_quality_v691();

-- Rebuild derived outcomes so fee-free labels cannot remain embedded in online profiles.
do $$
begin
  if to_regclass('public.lob_online_outcomes') is not null
     and to_regprocedure('public.backfill_lob_online_learning(integer)') is not null then
    if to_regclass('public.lob_market_profiles') is not null then
      delete from public.lob_market_profiles;
    end if;
    delete from public.lob_online_outcomes;
    perform public.backfill_lob_online_learning(5000);
  end if;
end;
$$;

revoke all on function public.fee_ledger_numeric_v691(text) from public, anon, authenticated;
revoke all on function public.allocate_upbit_order_fee_to_fills_v691(uuid) from public, anon, authenticated;
revoke all on function public.normalize_upbit_order_fee_v691() from public, anon, authenticated;
revoke all on function public.refresh_upbit_fill_fee_v691() from public, anon, authenticated;
revoke all on function public.refresh_upbit_order_fill_fee_v691() from public, anon, authenticated;
revoke all on function public.guard_lob_outcome_fee_quality_v691() from public, anon, authenticated;
grant execute on function public.allocate_upbit_order_fee_to_fills_v691(uuid) to service_role;
