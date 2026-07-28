-- Trading-booooo v6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE
--
-- Economic contract:
--   1. maximize cost-net account growth,
--   2. maximize profitable-trade rate,
--   3. maximize capital turnover,
--   4. never permit one objective to hide degradation in another,
--   5. only mathematically reconciled LIVE outcomes may learn or vote.
--
-- This migration adds exact reservation/exposure accounting, separate fee quality,
-- residual inventory, auditable asset locks, bounded exploration budgets, immutable policy
-- definitions, and 15% -> 25% -> 50% staged governance without resetting cohorts.

-- -----------------------------------------------------------------------------
-- Operator-controlled exposure and exploration rails
-- -----------------------------------------------------------------------------
alter table public.trading_settings
  add column if not exists scalp_max_strategy_exposure_pct double precision not null default 100,
  add column if not exists scalp_low_evidence_daily_loss_pct double precision not null default 0.30,
  add column if not exists asset_lock_clean_checks_required integer not null default 3,
  add column if not exists residual_sweep_enabled boolean not null default true,
  add column if not exists residual_sweep_buffer double precision not null default 1.10,
  add column if not exists scalp_latency_slo_ms integer not null default 1500;

alter table public.trading_settings
  drop constraint if exists trading_settings_scalp_max_strategy_exposure_pct_ck,
  drop constraint if exists trading_settings_scalp_low_evidence_daily_loss_pct_ck,
  drop constraint if exists trading_settings_asset_lock_clean_checks_required_ck,
  drop constraint if exists trading_settings_residual_sweep_buffer_ck,
  drop constraint if exists trading_settings_scalp_latency_slo_ms_ck;
alter table public.trading_settings
  add constraint trading_settings_scalp_max_strategy_exposure_pct_ck
    check (scalp_max_strategy_exposure_pct between 10 and 100) not valid,
  add constraint trading_settings_scalp_low_evidence_daily_loss_pct_ck
    check (scalp_low_evidence_daily_loss_pct between 0.05 and 2) not valid,
  add constraint trading_settings_asset_lock_clean_checks_required_ck
    check (asset_lock_clean_checks_required between 1 and 10) not valid,
  add constraint trading_settings_residual_sweep_buffer_ck
    check (residual_sweep_buffer between 1 and 2) not valid,
  add constraint trading_settings_scalp_latency_slo_ms_ck
    check (scalp_latency_slo_ms between 250 and 5000) not valid;
alter table public.trading_settings validate constraint trading_settings_scalp_max_strategy_exposure_pct_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_low_evidence_daily_loss_pct_ck;
alter table public.trading_settings validate constraint trading_settings_asset_lock_clean_checks_required_ck;
alter table public.trading_settings validate constraint trading_settings_residual_sweep_buffer_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_latency_slo_ms_ck;

-- -----------------------------------------------------------------------------
-- Reservations, fee quality and marked exposure
-- -----------------------------------------------------------------------------
alter table public.trading_positions
  add column if not exists reserved_quote numeric not null default 0,
  add column if not exists reserved_quantity numeric not null default 0,
  add column if not exists reservation_expires_at timestamptz,
  add column if not exists fee_accounting_quality text not null default 'LEGACY_UNVERIFIED',
  add column if not exists fee_accounting_version text,
  add column if not exists marked_pnl_quote numeric;

alter table public.trading_positions
  drop constraint if exists trading_positions_reserved_quote_ck,
  drop constraint if exists trading_positions_reserved_quantity_ck,
  drop constraint if exists trading_positions_fee_accounting_quality_ck;
alter table public.trading_positions
  add constraint trading_positions_reserved_quote_ck check (reserved_quote >= 0) not valid,
  add constraint trading_positions_reserved_quantity_ck check (reserved_quantity >= 0) not valid,
  add constraint trading_positions_fee_accounting_quality_ck check (
    fee_accounting_quality in (
      'EXACT', 'AGGREGATE_EXACT', 'THIRD_ASSET_MARKED', 'BASE_ASSET_ACCOUNTED',
      'ESTIMATED', 'MISSING', 'LEGACY_UNVERIFIED', 'NOT_APPLICABLE'
    )
  ) not valid;
alter table public.trading_positions validate constraint trading_positions_reserved_quote_ck;
alter table public.trading_positions validate constraint trading_positions_reserved_quantity_ck;
alter table public.trading_positions validate constraint trading_positions_fee_accounting_quality_ck;

alter table public.trading_orders
  add column if not exists fee_accounting_quality text not null default 'LEGACY_UNVERIFIED',
  add column if not exists fee_accounting_version text,
  add column if not exists fee_quote_source text,
  add column if not exists fee_reconcile_attempts integer not null default 0,
  add column if not exists fee_reconcile_next_at timestamptz,
  add column if not exists fee_reconciled_at timestamptz;

alter table public.trading_orders
  drop constraint if exists trading_orders_fee_accounting_quality_ck;
alter table public.trading_orders
  add constraint trading_orders_fee_accounting_quality_ck check (
    fee_accounting_quality in (
      'EXACT', 'AGGREGATE_EXACT', 'THIRD_ASSET_MARKED', 'BASE_ASSET_ACCOUNTED',
      'ESTIMATED', 'MISSING', 'LEGACY_UNVERIFIED', 'NOT_APPLICABLE'
    )
  ) not valid;
alter table public.trading_orders validate constraint trading_orders_fee_accounting_quality_ck;

alter table public.lob_online_outcomes
  add column if not exists fee_accounting_quality text not null default 'LEGACY_UNVERIFIED',
  add column if not exists prediction_basis text not null default 'LEGACY_ATTEMPT_EV';

alter table public.lob_online_outcomes
  drop constraint if exists lob_online_outcomes_fee_accounting_quality_ck,
  drop constraint if exists lob_online_outcomes_prediction_basis_ck;
alter table public.lob_online_outcomes
  add constraint lob_online_outcomes_fee_accounting_quality_ck check (
    fee_accounting_quality in (
      'EXACT', 'AGGREGATE_EXACT', 'THIRD_ASSET_MARKED', 'BASE_ASSET_ACCOUNTED',
      'ESTIMATED', 'MISSING', 'LEGACY_UNVERIFIED'
    )
  ) not valid,
  add constraint lob_online_outcomes_prediction_basis_ck check (
    prediction_basis in ('FILL_CONDITIONAL', 'LEGACY_ATTEMPT_EV')
  ) not valid;
alter table public.lob_online_outcomes validate constraint lob_online_outcomes_fee_accounting_quality_ck;
alter table public.lob_online_outcomes validate constraint lob_online_outcomes_prediction_basis_ck;

-- Existing v6.9.1 repaired rows receive a separate fee-quality label. Residual quality stays
-- in accounting_quality; the two dimensions must never be collapsed again.
update public.trading_orders o
set fee_accounting_quality = case
      when coalesce(o.executed_funds_quote, 0) <= 0 then 'NOT_APPLICABLE'
      when lower(o.exchange) = 'upbit' and greatest(
        public.fee_ledger_numeric_v691(o.raw_response ->> 'paid_fee'),
        public.fee_ledger_numeric_v691(o.raw_response #>> '{raw,paid_fee}')
      ) > 0 then 'AGGREGATE_EXACT'
      when lower(o.exchange) = 'binance' and exists (
        select 1 from public.trading_fills f
        where f.order_id = o.id and coalesce(f.fee_amount, 0) > 0
      ) and not exists (
        select 1
        from public.trading_fills f
        left join public.trading_positions p on p.id = o.position_id
        where f.order_id = o.id
          and coalesce(f.fee_amount, 0) > 0
          and upper(coalesce(f.fee_asset, '')) not in (
            upper(coalesce(p.quote_currency, o.quote_currency)),
            upper(coalesce(p.base_asset, ''))
          )
          and coalesce(f.raw #>> '{fee_accounting,marked_quote}', '') <> 'true' and coalesce(f.raw ->> 'feeQuoteMarked','0')::numeric <= 0
      ) then case
        when exists (
          select 1 from public.trading_fills f
          join public.trading_positions p on p.id = o.position_id
          where f.order_id = o.id and coalesce(f.fee_amount, 0) > 0
            and upper(coalesce(f.fee_asset, '')) = upper(coalesce(p.base_asset, ''))
        ) then 'BASE_ASSET_ACCOUNTED'
        else 'EXACT'
      end
      when o.raw_response #>> '{fee_accounting,source}' in ('ESTIMATED_THIRD_ASSET','ESTIMATED_MISSING')
        then 'ESTIMATED'
      else 'MISSING'
    end,
    fee_accounting_version = '6.10.0',
    fee_quote_source = coalesce(
      nullif(o.raw_response #>> '{fee_accounting,source}', ''),
      case when lower(o.exchange) = 'upbit' then 'UPBIT_ORDER_PAID_FEE' else 'BINANCE_FILL_COMMISSION' end
    ),
    updated_at = now();

create or replace function public.refresh_position_fee_quality_v610(p_position_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quality text;
begin
  if p_position_id is null then return; end if;
  select case
    when count(*) filter (where coalesce(o.executed_funds_quote, 0) > 0) = 0 then 'NOT_APPLICABLE'
    when count(*) filter (
      where coalesce(o.executed_funds_quote, 0) > 0
        and o.fee_accounting_quality not in (
          'EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED'
        )
    ) > 0 then case
      when count(*) filter (where o.fee_accounting_quality = 'MISSING') > 0 then 'MISSING'
      else 'ESTIMATED' end
    when count(*) filter (where o.fee_accounting_quality = 'AGGREGATE_EXACT') > 0 then 'AGGREGATE_EXACT'
    when count(*) filter (where o.fee_accounting_quality = 'THIRD_ASSET_MARKED') > 0 then 'THIRD_ASSET_MARKED'
    when count(*) filter (where o.fee_accounting_quality = 'BASE_ASSET_ACCOUNTED') > 0 then 'BASE_ASSET_ACCOUNTED'
    else 'EXACT'
  end into v_quality
  from public.trading_orders o
  where o.position_id = p_position_id;

  update public.trading_positions p
     set fee_accounting_quality = coalesce(v_quality, 'LEGACY_UNVERIFIED'),
         fee_accounting_version = '6.10.0',
         metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
           'fee_ledger_accounting', coalesce(p.metadata -> 'fee_ledger_accounting', '{}'::jsonb) ||
             jsonb_build_object('quality', coalesce(v_quality, 'LEGACY_UNVERIFIED'), 'version', '6.10.0')
         ),
         updated_at = now()
   where p.id = p_position_id;
end;
$$;

create or replace function public.trading_order_fee_quality_refresh_v610()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_position_fee_quality_v610(coalesce(new.position_id, old.position_id));
  return coalesce(new, old);
end;
$$;
drop trigger if exists trading_order_fee_quality_refresh_v610 on public.trading_orders;
create trigger trading_order_fee_quality_refresh_v610
  after insert or update of fee_accounting_quality, paid_fee_quote, raw_response
  on public.trading_orders for each row execute function public.trading_order_fee_quality_refresh_v610();

do $$
declare r record;
begin
  for r in select distinct position_id from public.trading_orders where position_id is not null loop
    perform public.refresh_position_fee_quality_v610(r.position_id);
  end loop;
end $$;

-- Reservation lifecycle guard. Terminal/open accounting states cannot retain phantom capital.
create or replace function public.normalize_position_reservation_v610()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.state in ('OPEN','CLOSED','CANCELLED','ERROR') then
    new.reserved_quote := 0;
    new.reserved_quantity := 0;
    new.reservation_expires_at := null;
  end if;
  if new.state = 'ENTRY_PENDING' then
    new.reserved_quote := greatest(0, coalesce(new.reserved_quote, 0));
    new.reserved_quantity := greatest(0, coalesce(new.reserved_quantity, 0));
  end if;
  return new;
end;
$$;
drop trigger if exists trading_positions_normalize_reservation_v610 on public.trading_positions;
create trigger trading_positions_normalize_reservation_v610
before insert or update of state, reserved_quote, reserved_quantity, reservation_expires_at
on public.trading_positions for each row execute function public.normalize_position_reservation_v610();

create or replace view public.trading_exposure_ledger_v610 as
select
  p.id,
  p.exchange,
  p.market,
  p.state,
  greatest(0, coalesce(p.remaining_quantity, 0)) * greatest(0, coalesce(p.average_entry_price, p.planned_entry_price, 0)) as filled_entry_exposure_quote,
  greatest(0, coalesce(p.reserved_quote, 0)) as reserved_exposure_quote,
  greatest(0, coalesce(p.remaining_quantity, 0)) * greatest(0, coalesce(p.average_entry_price, p.planned_entry_price, 0)) +
    greatest(0, coalesce(p.reserved_quote, 0)) as total_booked_exposure_quote,
  p.fee_accounting_quality,
  p.accounting_version,
  p.updated_at
from public.trading_positions p
where p.state in (
  'ENTRY_PENDING','OPEN','EXITING','RECONCILING','RECONCILIATION_FAILED','MANUAL_INTERVENTION_REQUIRED'
);

-- -----------------------------------------------------------------------------
-- Auditable asset locks: CLEAN increments, MISMATCH resets, QUERY_FAILED preserves count.
-- -----------------------------------------------------------------------------
create table if not exists public.trading_asset_locks (
  exchange text not null check (exchange in ('upbit','binance')),
  asset text not null,
  state text not null default 'LOCKED' check (state in ('LOCKED','RELEASED')),
  reason text not null,
  clean_checks integer not null default 0 check (clean_checks >= 0),
  locked_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_check_status text check (last_check_status in ('CLEAN','MISMATCH','QUERY_FAILED')),
  released_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (exchange, asset)
);
create index if not exists trading_asset_locks_active_idx
  on public.trading_asset_locks(state, exchange, asset) where state = 'LOCKED';
alter table public.trading_asset_locks enable row level security;
drop policy if exists trading_asset_locks_service_all on public.trading_asset_locks;
create policy trading_asset_locks_service_all on public.trading_asset_locks for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Import legacy JSON locks without releasing anything during migration.
insert into public.trading_asset_locks(exchange, asset, reason, metadata)
select
  split_part(v, ':', 1),
  upper(split_part(v, ':', 2)),
  'LEGACY_MANUAL_ASSET_LOCK',
  jsonb_build_object('imported_from', 'trading_settings.manual_asset_locks', 'imported_at', now())
from public.trading_settings s,
lateral jsonb_array_elements_text(coalesce(s.manual_asset_locks, '[]'::jsonb)) v
where s.id = 1 and split_part(v, ':', 1) in ('upbit','binance') and split_part(v, ':', 2) <> ''
on conflict (exchange, asset) do update set
  state = 'LOCKED', reason = excluded.reason, released_at = null, updated_at = now();

create or replace function public.record_asset_lock_check_v610(
  p_exchange text,
  p_asset text,
  p_status text,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_required integer;
  v_row public.trading_asset_locks%rowtype;
  v_status text := upper(coalesce(p_status,''));
begin
  if lower(p_exchange) not in ('upbit','binance') then raise exception 'invalid exchange'; end if;
  if v_status not in ('CLEAN','MISMATCH','QUERY_FAILED') then raise exception 'invalid lock check'; end if;
  select asset_lock_clean_checks_required into v_required from public.trading_settings where id = 1;
  v_required := greatest(1, coalesce(v_required, 3));

  insert into public.trading_asset_locks(exchange, asset, reason, metadata)
  values(lower(p_exchange), upper(p_asset), coalesce(p_reason,'ACCOUNT_RECONCILIATION'), coalesce(p_metadata,'{}'::jsonb))
  on conflict (exchange, asset) do nothing;

  update public.trading_asset_locks
     set clean_checks = case
           when v_status = 'CLEAN' then clean_checks + 1
           when v_status = 'MISMATCH' then 0
           else clean_checks
         end,
         state = case
           when v_status = 'CLEAN' and clean_checks + 1 >= v_required then 'RELEASED'
           when v_status = 'MISMATCH' then 'LOCKED'
           else state
         end,
         reason = case when v_status = 'MISMATCH' then coalesce(p_reason, reason) else reason end,
         last_checked_at = now(),
         last_check_status = v_status,
         released_at = case
           when v_status = 'CLEAN' and clean_checks + 1 >= v_required then now()
           when v_status = 'MISMATCH' then null
           else released_at
         end,
         metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where exchange = lower(p_exchange) and asset = upper(p_asset)
   returning * into v_row;

  -- Legacy array remains a compatibility mirror until every client has migrated.
  update public.trading_settings s
     set manual_asset_locks = coalesce((
       select jsonb_agg(l.exchange || ':' || l.asset order by l.exchange, l.asset)
       from public.trading_asset_locks l where l.state = 'LOCKED'
     ), '[]'::jsonb),
     updated_at = now()
   where s.id = 1;

  return to_jsonb(v_row);
end;
$$;

-- -----------------------------------------------------------------------------
-- Residual inventory ledger; sweep is allowed only without a live position/order/re-entry.
-- -----------------------------------------------------------------------------
create table if not exists public.trading_residual_inventory (
  position_id uuid primary key references public.trading_positions(id) on delete cascade,
  exchange text not null check (exchange in ('upbit','binance')),
  asset text not null,
  market text not null,
  original_quantity numeric not null default 0 check (original_quantity >= 0),
  remaining_quantity numeric not null default 0 check (remaining_quantity >= 0),
  mark_price numeric not null default 0 check (mark_price >= 0),
  value_quote numeric not null default 0 check (value_quote >= 0),
  state text not null default 'AVAILABLE' check (state in ('AVAILABLE','RESERVED_FOR_REENTRY','SWEEP_PENDING','SWEPT','CONSUMED')),
  sweep_order_id uuid references public.trading_orders(id) on delete set null,
  swept_quantity numeric not null default 0 check (swept_quantity >= 0),
  realized_proceeds_quote numeric not null default 0,
  paid_fees_quote numeric not null default 0,
  paid_fee_base_quantity numeric not null default 0,
  residual_pnl_quote numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.trading_residual_inventory
  add column if not exists swept_quantity numeric not null default 0,
  add column if not exists realized_proceeds_quote numeric not null default 0,
  add column if not exists paid_fees_quote numeric not null default 0,
  add column if not exists paid_fee_base_quantity numeric not null default 0,
  add column if not exists residual_pnl_quote numeric not null default 0;

create index if not exists trading_residual_inventory_asset_idx
  on public.trading_residual_inventory(exchange, asset, state);
alter table public.trading_residual_inventory enable row level security;
drop policy if exists trading_residual_inventory_service_all on public.trading_residual_inventory;
create policy trading_residual_inventory_service_all on public.trading_residual_inventory for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create or replace function public.sync_position_residual_v610()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.state = 'CLOSED' and coalesce(new.residual_quantity,0) > 0 then
    insert into public.trading_residual_inventory(
      position_id, exchange, asset, market, original_quantity, remaining_quantity, mark_price, value_quote, state, updated_at
    ) values (
      new.id, new.exchange, new.base_asset, new.market,
      new.residual_quantity, new.residual_quantity,
      case when new.residual_quantity > 0 then new.residual_value_quote / new.residual_quantity else 0 end,
      new.residual_value_quote, 'AVAILABLE', now()
    ) on conflict (position_id) do update set
      remaining_quantity = case
        when public.trading_residual_inventory.state in ('SWEPT','CONSUMED') then public.trading_residual_inventory.remaining_quantity
        else excluded.remaining_quantity end,
      mark_price = excluded.mark_price,
      value_quote = case
        when public.trading_residual_inventory.state in ('SWEPT','CONSUMED') then public.trading_residual_inventory.value_quote
        else excluded.value_quote end,
      updated_at = now();
  end if;
  return new;
end;
$$;
drop trigger if exists trading_positions_sync_residual_v610 on public.trading_positions;
create trigger trading_positions_sync_residual_v610
  after insert or update of state, residual_quantity, residual_value_quote
  on public.trading_positions for each row execute function public.sync_position_residual_v610();

insert into public.trading_residual_inventory(
  position_id, exchange, asset, market, original_quantity, remaining_quantity, mark_price, value_quote, state
)
select p.id,p.exchange,p.base_asset,p.market,p.residual_quantity,p.residual_quantity,
  case when p.residual_quantity>0 then p.residual_value_quote/p.residual_quantity else 0 end,
  p.residual_value_quote,'AVAILABLE'
from public.trading_positions p
where p.state='CLOSED' and coalesce(p.residual_quantity,0)>0
on conflict (position_id) do nothing;

-- Allow auditable residual sweeps without inventing a ghost position.
alter table public.trading_orders drop constraint if exists trading_orders_purpose_check;
alter table public.trading_orders add constraint trading_orders_purpose_check check (
  purpose in ('ENTRY','STOP','TARGET_1','TARGET_2','TRAIL','TIME_EXIT','EMERGENCY','MANUAL_RECONCILE','RESIDUAL_SWEEP')
) not valid;
alter table public.trading_orders validate constraint trading_orders_purpose_check;

-- Recompute a position from the durable order ledger after a late fee reconciliation.
-- This is idempotent and never fabricates an order or a fill.
create or replace function public.recompute_position_economic_accounting_v610(p_position_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_exit numeric;
  v_fees numeric;
begin
  select * into p from public.trading_positions where id=p_position_id for update;
  if not found then return jsonb_build_object('updated',false,'reason','POSITION_NOT_FOUND'); end if;
  select
    coalesce(sum(case when upper(o.side)='BUY' and upper(o.purpose)='ENTRY' then greatest(0,coalesce(o.executed_funds_quote,0)) else 0 end),0),
    coalesce(sum(case when upper(o.side)='SELL' and upper(o.purpose)<>'RESIDUAL_SWEEP' then greatest(0,coalesce(o.executed_funds_quote,0)) else 0 end),0),
    coalesce(sum(case when upper(o.purpose)<>'RESIDUAL_SWEEP' then greatest(0,coalesce(o.paid_fee_quote,0)) else 0 end),0)
  into v_entry,v_exit,v_fees
  from public.trading_orders o where o.position_id=p_position_id and coalesce(o.executed_funds_quote,0)>0;
  perform public.refresh_position_fee_quality_v610(p_position_id);
  select * into p from public.trading_positions where id=p_position_id for update;
  update public.trading_positions
     set realized_cost_quote=v_entry,
         realized_proceeds_quote=v_exit,
         paid_fees_quote=v_fees,
         realized_pnl_quote=case when p.state='CLOSED'
           then v_exit+greatest(0,coalesce(p.residual_value_quote,0))-v_entry-v_fees
           else p.realized_pnl_quote end,
         marked_pnl_quote=case when p.state='CLOSED'
           then v_exit+greatest(0,coalesce(p.residual_value_quote,0))-v_entry-v_fees
           else p.marked_pnl_quote end,
         fee_accounting_version='6.10.0',updated_at=now()
   where id=p_position_id returning * into p;
  return jsonb_build_object('updated',true,'position',to_jsonb(p));
end;
$$;

-- Account-level objective telemetry. Per-trade efficiency and account growth are stored
-- separately so idle capital cannot disappear from the objective.
create table if not exists public.trading_joint_objective_snapshots (
  id bigserial primary key,
  exchange text not null check(exchange in ('upbit','binance')),
  captured_at timestamptz not null default now(),
  total_equity_quote numeric not null default 0,
  managed_capital_quote numeric not null default 0,
  managed_available_quote numeric not null default 0,
  filled_exposure_quote numeric not null default 0,
  reserved_exposure_quote numeric not null default 0,
  residual_inventory_value_quote numeric not null default 0,
  marked_open_pnl_quote numeric not null default 0,
  realized_daily_pnl_quote numeric not null default 0,
  external_flow_quote numeric not null default 0,
  engine_version text not null,
  metadata jsonb not null default '{}'::jsonb
);
alter table public.trading_joint_objective_snapshots
  add column if not exists external_flow_quote numeric not null default 0;
create index if not exists trading_joint_objective_snapshots_exchange_time_idx
  on public.trading_joint_objective_snapshots(exchange,captured_at desc);
alter table public.trading_joint_objective_snapshots enable row level security;
drop policy if exists trading_joint_objective_snapshots_service_all on public.trading_joint_objective_snapshots;
create policy trading_joint_objective_snapshots_service_all on public.trading_joint_objective_snapshots for all
  using(auth.role()='service_role') with check(auth.role()='service_role');

-- -----------------------------------------------------------------------------
-- Low-evidence learning has a separate daily loss budget.
-- -----------------------------------------------------------------------------
create table if not exists public.lob_exploration_budget_daily (
  exchange text not null check (exchange in ('upbit','binance')),
  day_key date not null,
  managed_capital_quote numeric not null default 0,
  reserved_loss_quote numeric not null default 0,
  realized_loss_quote numeric not null default 0,
  entry_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key(exchange, day_key)
);
alter table public.lob_exploration_budget_daily enable row level security;
drop policy if exists lob_exploration_budget_service_all on public.lob_exploration_budget_daily;
create policy lob_exploration_budget_service_all on public.lob_exploration_budget_daily for all
  using (auth.role()='service_role') with check (auth.role()='service_role');

create table if not exists public.lob_exploration_budget_claims (
  position_id uuid primary key references public.trading_positions(id) on delete cascade,
  exchange text not null check(exchange in ('upbit','binance')),
  day_key date not null,
  claimed_loss_quote numeric not null check(claimed_loss_quote>=0),
  realized_loss_quote numeric not null default 0 check(realized_loss_quote>=0),
  claimed_at timestamptz not null default now(),
  settled_at timestamptz,
  settlement_state text check(settlement_state is null or settlement_state in ('CLOSED','CANCELLED')),
  metadata jsonb not null default '{}'::jsonb
);
alter table public.lob_exploration_budget_claims enable row level security;
drop policy if exists lob_exploration_budget_claims_service_all on public.lob_exploration_budget_claims;
create policy lob_exploration_budget_claims_service_all on public.lob_exploration_budget_claims for all
  using(auth.role()='service_role') with check(auth.role()='service_role');

create or replace function public.claim_lob_exploration_budget_v610(
  p_position_id uuid,
  p_exchange text,
  p_managed_capital_quote numeric,
  p_worst_case_loss_quote numeric
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_position public.trading_positions%rowtype;
  v_existing public.lob_exploration_budget_claims%rowtype;
  v_day date;
  v_pct numeric;
  v_limit numeric;
  v_claim numeric;
  v_row public.lob_exploration_budget_daily%rowtype;
begin
  select * into v_position from public.trading_positions where id=p_position_id for update;
  if not found then return jsonb_build_object('allowed',false,'reason','POSITION_NOT_FOUND'); end if;
  if lower(v_position.exchange)<>lower(p_exchange) then
    return jsonb_build_object('allowed',false,'reason','EXCHANGE_MISMATCH');
  end if;
  select * into v_existing from public.lob_exploration_budget_claims where position_id=p_position_id;
  if found then
    return jsonb_build_object(
      'allowed',v_existing.settled_at is null,
      'idempotent',true,
      'claimed_loss_quote',v_existing.claimed_loss_quote,
      'day_key',v_existing.day_key,
      'settled_at',v_existing.settled_at
    );
  end if;
  v_day := case when lower(p_exchange)='upbit' then (now() at time zone 'Asia/Seoul')::date else (now() at time zone 'UTC')::date end;
  select scalp_low_evidence_daily_loss_pct into v_pct from public.trading_settings where id=1;
  v_limit := greatest(0,coalesce(p_managed_capital_quote,0))*greatest(0,coalesce(v_pct,0.30))/100;
  v_claim := greatest(0,coalesce(p_worst_case_loss_quote,0));
  insert into public.lob_exploration_budget_daily(exchange,day_key,managed_capital_quote)
  values(lower(p_exchange),v_day,greatest(0,coalesce(p_managed_capital_quote,0)))
  on conflict(exchange,day_key) do update set
    managed_capital_quote=greatest(lob_exploration_budget_daily.managed_capital_quote,excluded.managed_capital_quote),
    updated_at=now();
  select * into v_row from public.lob_exploration_budget_daily
   where exchange=lower(p_exchange) and day_key=v_day for update;
  if v_row.reserved_loss_quote+v_row.realized_loss_quote+v_claim>v_limit then
    return jsonb_build_object('allowed',false,'reason','DAILY_LOSS_BUDGET_EXHAUSTED','limit_quote',v_limit,'used_quote',v_row.reserved_loss_quote+v_row.realized_loss_quote);
  end if;
  insert into public.lob_exploration_budget_claims(position_id,exchange,day_key,claimed_loss_quote)
  values(p_position_id,lower(p_exchange),v_day,v_claim);
  update public.lob_exploration_budget_daily set
    reserved_loss_quote=reserved_loss_quote+v_claim,
    entry_count=entry_count+1,updated_at=now()
  where exchange=lower(p_exchange) and day_key=v_day returning * into v_row;
  return jsonb_build_object('allowed',true,'limit_quote',v_limit,'claimed_loss_quote',v_claim,'day_key',v_day,'row',to_jsonb(v_row));
end;
$$;

-- Release/settle a claim exactly once for CLOSED or CANCELLED positions. Network failures
-- and retries cannot double-charge, and every cancelled entry returns its reserve.
create or replace function public.settle_lob_exploration_budget_v610(p_position_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.trading_positions%rowtype;
  c public.lob_exploration_budget_claims%rowtype;
  v_loss numeric;
  v_budget public.lob_exploration_budget_daily%rowtype;
begin
  select * into p from public.trading_positions where id=p_position_id for update;
  if not found then return jsonb_build_object('settled',false,'reason','POSITION_NOT_FOUND'); end if;
  if p.state not in ('CLOSED','CANCELLED') then
    return jsonb_build_object('settled',false,'reason','POSITION_NOT_TERMINAL');
  end if;
  select * into c from public.lob_exploration_budget_claims where position_id=p_position_id for update;
  if not found then return jsonb_build_object('settled',false,'reason','CLAIM_NOT_FOUND'); end if;
  if c.settled_at is not null then return jsonb_build_object('settled',false,'reason','ALREADY_SETTLED'); end if;
  v_loss:=case when p.state='CLOSED' then greatest(0,-coalesce(p.realized_pnl_quote,0)) else 0 end;
  update public.lob_exploration_budget_daily
     set reserved_loss_quote=greatest(0,reserved_loss_quote-c.claimed_loss_quote),
         realized_loss_quote=realized_loss_quote+v_loss,
         updated_at=now()
   where exchange=c.exchange and day_key=c.day_key
   returning * into v_budget;
  update public.lob_exploration_budget_claims
     set realized_loss_quote=v_loss,settled_at=now(),settlement_state=p.state,
         metadata=metadata||jsonb_build_object('engine_version','6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE')
   where position_id=p_position_id;
  update public.trading_positions
     set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
       'exploration_budget',coalesce(metadata->'exploration_budget','{}'::jsonb)||jsonb_build_object(
         'settled_at',now(),'claimed_loss_quote',c.claimed_loss_quote,
         'realized_loss_quote',v_loss,'day_key',c.day_key,'settlement_state',p.state
       )
     ),updated_at=now()
   where id=p_position_id;
  return jsonb_build_object('settled',true,'claimed_loss_quote',c.claimed_loss_quote,'realized_loss_quote',v_loss,'row',to_jsonb(v_budget));
end;
$$;

create or replace function public.auto_settle_lob_exploration_budget_v610()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.state in ('CLOSED','CANCELLED') and old.state is distinct from new.state then
    perform public.settle_lob_exploration_budget_v610(new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists trading_positions_auto_settle_exploration_v610 on public.trading_positions;
create trigger trading_positions_auto_settle_exploration_v610
  after update of state on public.trading_positions
  for each row execute function public.auto_settle_lob_exploration_budget_v610();

-- -----------------------------------------------------------------------------
-- Immutable, bounded and canonically fingerprinted policy definitions
-- -----------------------------------------------------------------------------
update public.lob_policy_versions
set policy_definition = jsonb_build_object(
  'schemaVersion',2,
  'family',coalesce(policy_definition->>'family','BALANCED'),
  'evidenceSizing',coalesce(policy_definition->'evidenceSizing','{}'::jsonb) || jsonb_build_object(
    'parentEvidenceCap',0.75,'evidenceHalfLifeHours',168
  ),
  'exploration',jsonb_build_object('dailyLossBudgetFraction',0.003,'maxConcurrentLowEvidence',1),
  'latency',coalesce(policy_definition->'latency','{}'::jsonb),
  'evBias',coalesce(policy_definition->'evBias','{}'::jsonb)
)
where case when coalesce(policy_definition->>'schemaVersion','') ~ '^[0-9]+$' then (policy_definition->>'schemaVersion')::integer else 0 end<>2;

create or replace function public.canonical_lob_policy_v610(p jsonb)
returns jsonb language sql immutable as $$
select jsonb_build_object(
  'schemaVersion',2,
  'family',upper(coalesce(p->>'family','BALANCED')),
  'evidenceSizing',jsonb_build_object(
    'unprovenFloorFraction',round(coalesce((p#>>'{evidenceSizing,unprovenFloorFraction}')::numeric,0.35),8),
    'insufficientStatusCap',round(coalesce((p#>>'{evidenceSizing,insufficientStatusCap}')::numeric,0.55),8),
    'lowQualityCap',round(coalesce((p#>>'{evidenceSizing,lowQualityCap}')::numeric,0.40),8),
    'dataQualityForFullSize',round(coalesce((p#>>'{evidenceSizing,dataQualityForFullSize}')::numeric,0.75),8),
    'featureSamplesForFullSize',coalesce((p#>>'{evidenceSizing,featureSamplesForFullSize}')::integer,60),
    'marketSamplesForFullSize',coalesce((p#>>'{evidenceSizing,marketSamplesForFullSize}')::integer,40),
    'patternSamplesForFullSize',coalesce((p#>>'{evidenceSizing,patternSamplesForFullSize}')::integer,100),
    'parentEvidenceCap',round(coalesce((p#>>'{evidenceSizing,parentEvidenceCap}')::numeric,0.75),8),
    'evidenceHalfLifeHours',coalesce((p#>>'{evidenceSizing,evidenceHalfLifeHours}')::integer,168)
  ),
  'exploration',jsonb_build_object(
    'dailyLossBudgetFraction',round(coalesce((p#>>'{exploration,dailyLossBudgetFraction}')::numeric,0.003),8),
    'maxConcurrentLowEvidence',coalesce((p#>>'{exploration,maxConcurrentLowEvidence}')::integer,1)
  ),
  'latency',jsonb_build_object(
    'assumedP95Ms',coalesce((p#>>'{latency,assumedP95Ms}')::integer,1500),
    'unmeasuredFloorBps',round(coalesce((p#>>'{latency,unmeasuredFloorBps}')::numeric,1),8),
    'penaltyMultiplier',round(coalesce((p#>>'{latency,penaltyMultiplier}')::numeric,1),8)
  ),
  'evBias',jsonb_build_object(
    'penaltyMultiplier',round(coalesce((p#>>'{evBias,penaltyMultiplier}')::numeric,1),8),
    'maxPenaltyBps',round(coalesce((p#>>'{evBias,maxPenaltyBps}')::numeric,30),8)
  )
)
$$;

create or replace function public.validate_lob_policy_v610()
returns trigger language plpgsql set search_path=public as $$
declare c jsonb;
begin
  if tg_op='UPDATE' and (
    new.policy_definition is distinct from old.policy_definition or
    new.engine_version is distinct from old.engine_version or
    new.parent_version is distinct from old.parent_version or
    new.online_profiles is distinct from old.online_profiles or
    new.pattern_profile is distinct from old.pattern_profile or
    new.fingerprint is distinct from old.fingerprint
  ) then raise exception 'immutable LOB policy snapshot fields cannot be updated'; end if;
  c:=public.canonical_lob_policy_v610(new.policy_definition);
  if c->>'family' not in ('BALANCED','QUALITY_WEIGHTED','LATENCY_GUARDED','EV_DEBIASED') then raise exception 'invalid policy family'; end if;
  if (c#>>'{evidenceSizing,unprovenFloorFraction}')::numeric not between 0.10 and 0.60 then raise exception 'unproven floor out of bounds'; end if;
  if (c#>>'{evidenceSizing,parentEvidenceCap}')::numeric not between 0.40 and 0.90 then raise exception 'parent evidence cap out of bounds'; end if;
  if (c#>>'{exploration,dailyLossBudgetFraction}')::numeric not between 0.0005 and 0.02 then raise exception 'exploration budget out of bounds'; end if;
  if (c#>>'{latency,penaltyMultiplier}')::numeric not between 0.75 and 1.75 then raise exception 'latency multiplier out of bounds'; end if;
  if (c#>>'{evBias,maxPenaltyBps}')::numeric not between 5 and 50 then raise exception 'EV bias cap out of bounds'; end if;
  new.policy_definition:=c;
  if tg_op='INSERT' then
    new.fingerprint:=md5(new.engine_version||'|'||coalesce(new.source_online_version,0)::text||'|'||c::text||'|'||coalesce(new.online_profiles,'[]'::jsonb)::text||'|'||coalesce(new.pattern_profile,'null'::jsonb)::text);
  end if;
  return new;
end;
$$;
drop trigger if exists lob_policy_versions_validate_v610 on public.lob_policy_versions;
create trigger lob_policy_versions_validate_v610
before insert or update of policy_definition,engine_version,parent_version,online_profiles,pattern_profile,fingerprint
on public.lob_policy_versions for each row execute function public.validate_lob_policy_v610();

-- New challengers always begin at 15% and carry the v6.10 economic contract.
create or replace function public.create_lob_policy_challenger(
  p_min_new_samples integer default 20,
  p_policy_definition jsonb default null
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_champion public.lob_policy_versions%rowtype;
  v_existing public.lob_policy_versions%rowtype;
  v_pattern public.lob_learning_profiles%rowtype;
  v_online jsonb;
  v_source_version bigint;
  v_last_source bigint;
  v_definition jsonb;
  v_created public.lob_policy_versions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('lob-policy-governance-v610'));
  select * into v_existing from public.lob_policy_versions where status in ('CHALLENGER','CONTROL') order by version desc limit 1;
  if found then return jsonb_build_object('created',false,'reason','ALTERNATE_ALREADY_ACTIVE','alternate_version',v_existing.version); end if;
  select * into v_champion from public.lob_policy_versions where status='CHAMPION' order by version desc limit 1 for update;
  if not found then return jsonb_build_object('created',false,'reason','NO_CHAMPION'); end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.exchange,p.market,p.pattern),'[]'::jsonb),
         coalesce(sum(p.version) filter(where p.market='*'),0)
    into v_online,v_source_version from public.lob_market_profiles p;
  select * into v_pattern from public.lob_learning_profiles order by generated_at desc limit 1;
  select greatest(coalesce(v_champion.source_online_version,0),coalesce(max(source_online_version),0)) into v_last_source from public.lob_policy_versions;
  if v_source_version-v_last_source<greatest(1,coalesce(p_min_new_samples,20)) then
    return jsonb_build_object('created',false,'reason','INSUFFICIENT_NEW_OUTCOMES','source_online_version',v_source_version);
  end if;
  v_definition:=public.canonical_lob_policy_v610(coalesce(p_policy_definition,v_champion.policy_definition));
  insert into public.lob_policy_versions(
    status,parent_version,engine_version,fingerprint,source_online_version,source_pattern_profile_id,
    online_profiles,pattern_profile,policy_definition,traffic_fraction,evaluation_started_at,decision_reason,criteria
  ) values(
    'CHALLENGER',v_champion.version,'6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE','TEMP',v_source_version,v_pattern.id,
    v_online,case when v_pattern.id is null then null else to_jsonb(v_pattern) end,v_definition,0.15,now(),
    'CANARY_15_PERCENT_JOINT_OBJECTIVE_EXACT_ACCOUNTING',
    jsonb_build_object(
      'stages',jsonb_build_array(0.15,0.25,0.50),
      'canary_min_samples_per_arm',30,'canary_min_observation_hours',24,
      'final_min_samples_per_arm',100,'max_samples_per_arm',400,
      'requires_cost_net_growth_improvement',true,'requires_win_rate_improvement',true,
      'requires_capital_turnover_improvement',true,'requires_exact_fee_accounting',true,
      'requires_verified_residual_accounting',true,'requires_fill_conditional_ev',true,
      'backtest_shadow_can_vote',false
    )
  ) returning * into v_created;
  -- Preserve the original cohort start on the champion; do not reset it on later stage expansion.
  update public.lob_policy_versions set evaluation_started_at=coalesce(evaluation_started_at,v_created.evaluation_started_at),updated_at=now() where version=v_champion.version;
  return jsonb_build_object('created',true,'version',v_created.version,'parent_version',v_created.parent_version,'traffic_fraction',v_created.traffic_fraction,'policy_definition',v_created.policy_definition);
end;
$$;

-- Only exact-fee, verified-residual, current-engine LIVE outcomes can vote.
create or replace function public.get_lob_policy_evaluation_dataset()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_champion public.lob_policy_versions%rowtype;
  v_alternate public.lob_policy_versions%rowtype;
  v_phase text; v_base bigint; v_candidate bigint; v_since timestamptz;
  bt jsonb; ct jsonb; bex jsonb; cex jsonb;
begin
  select * into v_champion from public.lob_policy_versions where status='CHAMPION' order by version desc limit 1;
  select * into v_alternate from public.lob_policy_versions where status in ('CHALLENGER','CONTROL') order by version desc limit 1;
  if v_champion.version is null or v_alternate.version is null then return jsonb_build_object('phase','IDLE'); end if;
  if v_alternate.status='CHALLENGER' then v_phase:='CHALLENGE';v_base:=v_champion.version;v_candidate:=v_alternate.version;
  else v_phase:='CONFIRMATION';v_base:=v_alternate.version;v_candidate:=v_champion.version; end if;
  v_since:=least(coalesce(v_champion.evaluation_started_at,v_champion.created_at),coalesce(v_alternate.evaluation_started_at,v_alternate.created_at));
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',o.position_id,'policyVersion',o.policy_version,'exchange',o.exchange,'market',o.market,'pattern',o.pattern,
    'netBps',o.net_bps,'profitable',o.profitable,'heldSeconds',o.held_seconds,'notionalQuote',o.realized_cost_quote,
    'closedAtMs',extract(epoch from o.closed_at)*1000,'liveVerified',true,'accountingQuality',o.accounting_quality
  ) order by o.closed_at),'[]'::jsonb) into bt from public.lob_online_outcomes o
  where o.policy_version=v_base and o.closed_at>=v_since
    and o.engine_version='6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE'
    and o.accounting_quality in ('NO_RESIDUAL','RESIDUAL_MARKED_TO_EXIT')
    and o.fee_accounting_quality in ('EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED')
    and o.prediction_basis='FILL_CONDITIONAL';
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',o.position_id,'policyVersion',o.policy_version,'exchange',o.exchange,'market',o.market,'pattern',o.pattern,
    'netBps',o.net_bps,'profitable',o.profitable,'heldSeconds',o.held_seconds,'notionalQuote',o.realized_cost_quote,
    'closedAtMs',extract(epoch from o.closed_at)*1000,'liveVerified',true,'accountingQuality',o.accounting_quality
  ) order by o.closed_at),'[]'::jsonb) into ct from public.lob_online_outcomes o
  where o.policy_version=v_candidate and o.closed_at>=v_since
    and o.engine_version='6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE'
    and o.accounting_quality in ('NO_RESIDUAL','RESIDUAL_MARKED_TO_EXIT')
    and o.fee_accounting_quality in ('EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED')
    and o.prediction_basis='FILL_CONDITIONAL';
  select coalesce(jsonb_agg(jsonb_build_object('policyVersion',e.policy_version,'assignedAtMs',extract(epoch from e.assigned_at)*1000,'candidateCount',e.candidate_count,'entryAttempts',e.entry_attempts,'reservations',e.reservations) order by e.assigned_at),'[]'::jsonb)
    into bex from public.lob_policy_cycle_exposures e where e.policy_version=v_base and e.assigned_at>=v_since;
  select coalesce(jsonb_agg(jsonb_build_object('policyVersion',e.policy_version,'assignedAtMs',extract(epoch from e.assigned_at)*1000,'candidateCount',e.candidate_count,'entryAttempts',e.entry_attempts,'reservations',e.reservations) order by e.assigned_at),'[]'::jsonb)
    into cex from public.lob_policy_cycle_exposures e where e.policy_version=v_candidate and e.assigned_at>=v_since;
  return jsonb_build_object('phase',v_phase,'since',v_since,'baseline_version',v_base,'candidate_version',v_candidate,
    'candidate_traffic_fraction',case when v_phase='CHALLENGE' then v_alternate.traffic_fraction else 0.50 end,
    'baseline_trades',bt,'candidate_trades',ct,'baseline_exposures',bex,'candidate_exposures',cex,
    'evaluation_look',coalesce((v_alternate.metrics->>'evaluation_look')::integer,0));
end;
$$;

-- EXPAND advances exactly one stage and never resets evaluation_started_at.
create or replace function public.apply_lob_policy_decision(
  p_expected_champion bigint,p_expected_alternate bigint,p_decision text,p_metrics jsonb,p_reason text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  c public.lob_policy_versions%rowtype; a public.lob_policy_versions%rowtype;
  d text:=upper(coalesce(p_decision,'')); next_fraction numeric;
begin
  perform pg_advisory_xact_lock(hashtext('lob-policy-governance-v610'));
  select * into c from public.lob_policy_versions where status='CHAMPION' order by version desc limit 1 for update;
  select * into a from public.lob_policy_versions where status in ('CHALLENGER','CONTROL') order by version desc limit 1 for update;
  if c.version is distinct from p_expected_champion or a.version is distinct from p_expected_alternate then return jsonb_build_object('applied',false,'reason','STALE_POLICY_STATE'); end if;
  p_metrics:=coalesce(p_metrics,'{}'::jsonb)||jsonb_build_object('evaluation_look',coalesce((a.metrics->>'evaluation_look')::integer,0)+1);
  if d='HOLD' then
    update public.lob_policy_versions set metrics=p_metrics,decision_reason=p_reason,evaluated_at=now(),updated_at=now() where version=a.version;
  elsif d='EXPAND' and a.status='CHALLENGER' then
    next_fraction:=case when a.traffic_fraction<0.25 then 0.25 when a.traffic_fraction<0.50 then 0.50 else a.traffic_fraction end;
    if next_fraction<=a.traffic_fraction then return jsonb_build_object('applied',false,'reason','ALREADY_AT_FINAL_CANARY_STAGE'); end if;
    update public.lob_policy_versions set traffic_fraction=next_fraction,metrics=p_metrics,
      decision_reason=coalesce(p_reason,'CANARY_ADVANCED_TO_'||(next_fraction*100)::integer||'_PERCENT'),evaluated_at=now(),updated_at=now()
      where version=a.version;
  elsif d='REJECT' and a.status='CHALLENGER' then
    update public.lob_policy_versions set status='REJECTED',metrics=p_metrics,decision_reason=p_reason,evaluated_at=now(),retired_at=now(),updated_at=now() where version=a.version;
    update public.lob_policy_versions set evaluation_started_at=null,updated_at=now() where version=c.version;
  elsif d='PROMOTE' and a.status='CHALLENGER' and a.traffic_fraction>=0.50 then
    update public.lob_policy_versions set status='RETIRED',updated_at=now() where version=a.version;
    update public.lob_policy_versions set status='CONTROL',traffic_fraction=0.50,metrics=coalesce(p_metrics->'baseline','{}'::jsonb),decision_reason='LIVE_CONTROL_AFTER_PROVISIONAL_PROMOTION',updated_at=now() where version=c.version;
    update public.lob_policy_versions set status='CHAMPION',promoted_at=now(),confirmed_at=null,metrics=coalesce(p_metrics->'candidate','{}'::jsonb),decision_reason=p_reason,evaluated_at=now(),updated_at=now() where version=a.version;
  elsif d='CONFIRM' and a.status='CONTROL' then
    update public.lob_policy_versions set status='RETIRED',metrics=coalesce(p_metrics->'baseline',metrics),decision_reason='PROVISIONAL_CHAMPION_CONFIRMED',evaluated_at=now(),retired_at=now(),updated_at=now() where version=a.version;
    update public.lob_policy_versions set confirmed_at=now(),evaluation_started_at=null,metrics=coalesce(p_metrics->'candidate',metrics),decision_reason=p_reason,evaluated_at=now(),updated_at=now() where version=c.version;
  elsif d='ROLLBACK' and a.status='CONTROL' then
    update public.lob_policy_versions set status='ROLLED_BACK',metrics=coalesce(p_metrics->'candidate',metrics),decision_reason=p_reason,evaluated_at=now(),retired_at=now(),updated_at=now() where version=c.version;
    update public.lob_policy_versions set status='CHAMPION',confirmed_at=now(),evaluation_started_at=null,metrics=coalesce(p_metrics->'baseline',metrics),decision_reason='AUTO_ROLLBACK_CONTROL_RESTORED',evaluated_at=now(),retired_at=null,updated_at=now() where version=a.version;
  else return jsonb_build_object('applied',false,'reason','INVALID_DECISION_FOR_PHASE_OR_STAGE','decision',d,'traffic_fraction',a.traffic_fraction); end if;
  return jsonb_build_object('applied',true,'decision',d,'status',public.get_lob_policy_status());
end;
$$;

-- Learning guard: separate residual and fee quality, current engine and fill-conditional EV.
create or replace function public.guard_lob_outcome_integrity_v610()
returns trigger language plpgsql security definer set search_path=public as $$
declare p public.trading_positions%rowtype;
begin
  select * into p from public.trading_positions where id=new.position_id;
  if not found then return null; end if;
  -- This guard may run before the legacy enrichment trigger. Read authoritative fields
  -- from the position instead of depending on trigger-name ordering.
  new.engine_version:=coalesce(nullif(new.engine_version,''),nullif(p.metadata->>'engine_version',''));
  new.accounting_quality:=coalesce(nullif(new.accounting_quality,''),nullif(p.metadata#>>'{exit_residual_accounting,quality}',''),'LEGACY_UNVERIFIED');
  new.accounting_version:=coalesce(nullif(new.accounting_version,''),nullif(p.accounting_version,''));
  new.fee_accounting_quality:=coalesce(p.fee_accounting_quality,'LEGACY_UNVERIFIED');
  new.prediction_basis:=case when p.metadata #>> '{lob_signal,prediction_basis}'='FILL_CONDITIONAL' then 'FILL_CONDITIONAL' else 'LEGACY_ATTEMPT_EV' end;
  if coalesce(new.engine_version,'')<>'6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE'
     or new.accounting_quality not in ('NO_RESIDUAL','RESIDUAL_MARKED_TO_EXIT')
     or new.fee_accounting_quality not in ('EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED')
     or new.prediction_basis<>'FILL_CONDITIONAL' then return null; end if;
  return new;
end;
$$;
drop trigger if exists aa_guard_lob_outcome_fee_quality_v691 on public.lob_online_outcomes;
drop trigger if exists aa_guard_lob_outcome_integrity_v610 on public.lob_online_outcomes;
create trigger aa_guard_lob_outcome_integrity_v610 before insert or update on public.lob_online_outcomes
for each row execute function public.guard_lob_outcome_integrity_v610();

-- Zero-quantity ghosts cannot remain operationally open.
update public.trading_positions
set state='CLOSED',remaining_quantity=0,reserved_quote=0,reserved_quantity=0,
    closed_at=coalesce(closed_at,now()),close_reason=coalesce(close_reason,'ZERO_QUANTITY_AUTO_CLOSE_V610'),updated_at=now()
where state in ('OPEN','EXITING','RECONCILING','RECONCILIATION_FAILED','MANUAL_INTERVENTION_REQUIRED')
  and coalesce(remaining_quantity,0)<=0 and coalesce(reserved_quote,0)<=0;

revoke all on function public.record_asset_lock_check_v610(text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.claim_lob_exploration_budget_v610(uuid,text,numeric,numeric) from public,anon,authenticated;
revoke all on function public.settle_lob_exploration_budget_v610(uuid) from public,anon,authenticated;
revoke all on function public.refresh_position_fee_quality_v610(uuid) from public,anon,authenticated;
revoke all on function public.recompute_position_economic_accounting_v610(uuid) from public,anon,authenticated;
revoke all on function public.canonical_lob_policy_v610(jsonb) from public,anon,authenticated;
revoke all on function public.create_lob_policy_challenger(integer,jsonb) from public,anon,authenticated;
revoke all on function public.get_lob_policy_evaluation_dataset() from public,anon,authenticated;
revoke all on function public.apply_lob_policy_decision(bigint,bigint,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.record_asset_lock_check_v610(text,text,text,text,jsonb) to service_role;
grant execute on function public.claim_lob_exploration_budget_v610(uuid,text,numeric,numeric) to service_role;
grant execute on function public.settle_lob_exploration_budget_v610(uuid) to service_role;
grant execute on function public.refresh_position_fee_quality_v610(uuid) to service_role;
grant execute on function public.recompute_position_economic_accounting_v610(uuid) to service_role;
grant execute on function public.create_lob_policy_challenger(integer,jsonb) to service_role;
grant execute on function public.get_lob_policy_evaluation_dataset() to service_role;
grant execute on function public.apply_lob_policy_decision(bigint,bigint,text,jsonb,text) to service_role;
