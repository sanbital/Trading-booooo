-- P10_DONCHIAN_BREAKOUT_E10_SLOW_4R live cutover.
-- Additive first: existing LONG positions and legacy strategy rows keep their semantics.

alter table public.trading_settings
  drop constraint if exists trading_settings_strategy_check;
alter table public.trading_settings
  add constraint trading_settings_strategy_check
  check (strategy = any (array[
    'TREND'::text,
    'SCALP'::text,
    'LOB_SCALP'::text,
    'P10_DONCHIAN_SLOW4R'::text
  ]));

alter table public.trading_positions
  add column if not exists strategy_key text not null default 'LEGACY',
  add column if not exists position_side text not null default 'LONG';

alter table public.trading_orders
  add column if not exists strategy_key text not null default 'LEGACY',
  add column if not exists position_side text,
  add column if not exists position_effect text;

alter table public.trading_orders
  drop constraint if exists trading_orders_position_side_ck;
alter table public.trading_orders
  add constraint trading_orders_position_side_ck
  check (position_side is null or position_side = any (array['LONG'::text, 'SHORT'::text]));

alter table public.trading_orders
  drop constraint if exists trading_orders_position_effect_ck;
alter table public.trading_orders
  add constraint trading_orders_position_effect_ck
  check (position_effect is null or position_effect = any (array['OPEN'::text, 'CLOSE'::text]));

alter table public.trading_positions
  drop constraint if exists trading_positions_position_side_ck;
alter table public.trading_positions
  add constraint trading_positions_position_side_ck
  check (
    position_side = 'LONG' or
    (position_side = 'SHORT' and exchange = 'binance_futures')
  );

-- Replace the two long-only geometry checks with a direction-aware invariant.
alter table public.trading_positions
  drop constraint if exists trading_positions_check1;
alter table public.trading_positions
  drop constraint if exists trading_positions_check2;
alter table public.trading_positions
  drop constraint if exists trading_positions_directional_geometry_ck;
alter table public.trading_positions
  add constraint trading_positions_directional_geometry_ck
  check (
    (
      position_side = 'LONG' and
      stop_price < coalesce(average_entry_price, planned_entry_price) and
      target_1 > coalesce(average_entry_price, planned_entry_price)
    ) or (
      position_side = 'SHORT' and
      stop_price > coalesce(average_entry_price, planned_entry_price) and
      target_1 < coalesce(average_entry_price, planned_entry_price)
    )
  );

alter table public.trading_positions
  drop constraint if exists trading_positions_exit_policy_check;
alter table public.trading_positions
  add constraint trading_positions_exit_policy_check
  check (exit_policy = any (array[
    'FIXED_T1'::text,
    'SCALE_OUT'::text,
    'TRAIL_AFTER_T1'::text,
    'P10_SLOW_4R'::text
  ]));

-- Legacy LOB guards remain authoritative for legacy positions. P10 carries its own
-- direction-aware, 96-hour Slow4R accounting and must not be rewritten to the old
-- 10-minute/50%-split policy by legacy BEFORE triggers.
drop trigger if exists aa0_trading_positions_upbit_profit_protection_v7615
  on public.trading_positions;
create trigger aa0_trading_positions_upbit_profit_protection_v7615
before update of peak_price, paid_fees_quote, realized_cost_quote
on public.trading_positions
for each row
when (
  lower(coalesce(new.exchange, '')) = 'upbit' and
  coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
)
execute function public.protect_upbit_open_profit_v7615();

drop trigger if exists aa_trading_positions_profit_protection_v6130
  on public.trading_positions;
create trigger aa_trading_positions_profit_protection_v6130
before update of peak_price, paid_fees_quote, realized_cost_quote
on public.trading_positions
for each row
when (
  lower(coalesce(new.exchange, '')) <> 'upbit' and
  coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
)
execute function public.protect_lob_open_profit_v6130();

drop trigger if exists aa_trading_positions_top10_lob_only_v700
  on public.trading_positions;
create trigger aa_trading_positions_top10_lob_only_v700
before insert on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.enforce_top10_lob_only_v700();

drop trigger if exists ab_trading_positions_pre_t1_profit_net_guard_v768
  on public.trading_positions;
create trigger ab_trading_positions_pre_t1_profit_net_guard_v768
before update of peak_price, paid_fees_quote, realized_cost_quote
on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.sanitize_pre_t1_profit_protection_v768();

drop trigger if exists az_trading_positions_lob_live_v711
  on public.trading_positions;
create trigger az_trading_positions_lob_live_v711
before insert or update on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.enforce_lob_live_admission_v711();

drop trigger if exists label_trading_exit_reason_v704
  on public.trading_positions;
create trigger label_trading_exit_reason_v704
before insert or update on public.trading_positions
for each row
when (
  new.state = 'CLOSED' and
  coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
)
execute function public.label_trading_exit_reason_v704();

drop trigger if exists trading_positions_auto_settle_exploration_v610
  on public.trading_positions;
create trigger trading_positions_auto_settle_exploration_v610
after update of state on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.auto_settle_lob_exploration_budget_v610();

drop trigger if exists trading_positions_lob_planned_stop_v724
  on public.trading_positions;
create trigger trading_positions_lob_planned_stop_v724
before insert or update of average_entry_price, planned_entry_price, stop_price, tick_size, metadata
on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.enforce_lob_planned_stop_v724();

drop trigger if exists trading_positions_trade_mission_audit_v6120
  on public.trading_positions;
create trigger trading_positions_trade_mission_audit_v6120
after insert or update of state, realized_pnl_quote, realized_cost_quote, paid_fees_quote
on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.audit_closed_trade_mission_v6120();

drop trigger if exists trg_repair_position_when_closed
  on public.trading_positions;
create trigger trg_repair_position_when_closed
after update of state on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.trg_repair_position_when_closed();

drop trigger if exists zz_trading_positions_exit_policy_v714
  on public.trading_positions;
create trigger zz_trading_positions_exit_policy_v714
before insert or update on public.trading_positions
for each row
when (
  lower(coalesce(new.exchange, '')) <> 'binance_futures' and
  coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
)
execute function public.enforce_v714_volatility_aware_position_policy();

drop trigger if exists zz_trading_positions_mission_stamp_v6120
  on public.trading_positions;
create trigger zz_trading_positions_mission_stamp_v6120
before insert on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.stamp_lob_mission_position_v6120();

drop trigger if exists zzzz_trading_positions_ops_guard_v740
  on public.trading_positions;
create trigger zzzz_trading_positions_ops_guard_v740
before insert or update on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.enforce_position_ops_metrics();

drop trigger if exists zzzzz_trading_positions_residual_exit_v751
  on public.trading_positions;
create trigger zzzzz_trading_positions_residual_exit_v751
before insert or update on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.enforce_residual_exit_position_policy_v751();

drop trigger if exists zzzzzz_trading_positions_sync_exit_revision_v753
  on public.trading_positions;
create trigger zzzzzz_trading_positions_sync_exit_revision_v753
before insert or update on public.trading_positions
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.sync_active_exit_revision_v753();

drop trigger if exists zz_trading_orders_lob_exit_guard_v714
  on public.trading_orders;
create trigger zz_trading_orders_lob_exit_guard_v714
before insert on public.trading_orders
for each row
when (
  lower(coalesce(new.exchange, '')) <> 'binance_futures' and
  coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
)
execute function public.guard_lob_sell_order_v714();

drop trigger if exists zzzz0_trading_orders_normalize_recovery_reason_v753
  on public.trading_orders;
create trigger zzzz0_trading_orders_normalize_recovery_reason_v753
before insert on public.trading_orders
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.normalize_recovery_exit_reason_v753();

drop trigger if exists zzzz1_trading_orders_normalize_absolute_timeout_v769
  on public.trading_orders;
create trigger zzzz1_trading_orders_normalize_absolute_timeout_v769
before insert on public.trading_orders
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.normalize_absolute_timeout_exit_reason_v769();

drop trigger if exists zzzzz_trading_orders_residual_exit_v751
  on public.trading_orders;
create trigger zzzzz_trading_orders_residual_exit_v751
before insert on public.trading_orders
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.guard_residual_sell_order_v751();

drop trigger if exists zzzzzz_trading_orders_pre_t1_net_guard_v768
  on public.trading_orders;
create trigger zzzzzz_trading_orders_pre_t1_net_guard_v768
before insert on public.trading_orders
for each row
when (coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R')
execute function public.guard_pre_t1_profit_exit_positive_net_v768();

create or replace function public.guard_p10_order_v800()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  p public.trading_positions%rowtype;
  v_expected_side text;
  v_expected_effect text;
  v_leverage numeric;
begin
  if coalesce(new.strategy_key, '') <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' then
    return new;
  end if;
  if new.position_id is null then
    raise exception using errcode = '23514', message = 'P10_ORDER_POSITION_REQUIRED';
  end if;
  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.strategy_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' then
    raise exception using errcode = '23514', message = 'P10_ORDER_POSITION_MISMATCH';
  end if;
  v_expected_effect := case when new.purpose = 'ENTRY' then 'OPEN' else 'CLOSE' end;
  v_expected_side := case
    when p.position_side = 'SHORT' and v_expected_effect = 'OPEN' then 'SELL'
    when p.position_side = 'SHORT' then 'BUY'
    when v_expected_effect = 'OPEN' then 'BUY'
    else 'SELL'
  end;
  if new.position_side is distinct from p.position_side or
     new.position_effect is distinct from v_expected_effect or
     new.side is distinct from v_expected_side then
    raise exception using errcode = '23514', message = 'P10_ORDER_DIRECTION_MISMATCH';
  end if;
  if p.position_side = 'SHORT' and lower(p.exchange) <> 'binance_futures' then
    raise exception using errcode = '23514', message = 'P10_SPOT_SHORT_FORBIDDEN';
  end if;
  if lower(p.exchange) = 'binance_futures' and v_expected_effect = 'OPEN' then
    v_leverage := least(20, greatest(1, coalesce(nullif(p.leverage, 0), 3)));
    if coalesce(new.requested_notional_quote, 0) + 0.00000001 < 50 * v_leverage then
      raise exception using errcode = '23514', message = 'P10_FUTURES_ENTRY_MARGIN_BELOW_50_USDT';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trading_orders_guard_p10_v800 on public.trading_orders;
create trigger trading_orders_guard_p10_v800
before insert or update on public.trading_orders
for each row execute function public.guard_p10_order_v800();

create unique index if not exists trading_positions_p10_one_active_market_uidx
  on public.trading_positions (exchange, market)
  where strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
    and state in (
      'ENTRY_PENDING',
      'OPEN',
      'EXITING',
      'RECONCILING',
      'RECONCILIATION_FAILED',
      'MANUAL_INTERVENTION_REQUIRED'
    );

create table if not exists public.p10_signal_claims (
  id uuid primary key default gen_random_uuid(),
  venue text not null check (venue = any (array[
    'upbit_spot'::text,
    'binance_spot'::text,
    'binance_futures'::text
  ])),
  market text not null,
  signal_time timestamptz not null,
  side text not null check (side = any (array['LONG'::text, 'SHORT'::text])),
  strategy_key text not null default 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
  status text not null default 'CLAIMED' check (status = any (array[
    'CLAIMED'::text,
    'ORDERED'::text,
    'FILLED'::text,
    'REJECTED'::text,
    'CLOSED'::text
  ])),
  position_id uuid null references public.trading_positions(id) on delete set null,
  reason text null,
  evidence jsonb not null default '{}'::jsonb,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue, market, signal_time, side)
);

alter table public.p10_signal_claims enable row level security;

create index if not exists p10_signal_claims_status_time_idx
  on public.p10_signal_claims (status, signal_time desc);

create or replace function public.claim_p10_signal(
  p_venue text,
  p_market text,
  p_signal_time timestamptz,
  p_side text,
  p_evidence jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_claim public.p10_signal_claims%rowtype;
begin
  insert into public.p10_signal_claims (
    venue, market, signal_time, side, evidence
  ) values (
    p_venue, p_market, p_signal_time, p_side, coalesce(p_evidence, '{}'::jsonb)
  )
  on conflict (venue, market, signal_time, side) do nothing
  returning * into v_claim;

  if not found then
    select * into v_claim
    from public.p10_signal_claims
    where venue = p_venue
      and market = p_market
      and signal_time = p_signal_time
      and side = p_side;
    return jsonb_build_object(
      'claimed', false,
      'claim', to_jsonb(v_claim)
    );
  end if;

  return jsonb_build_object(
    'claimed', true,
    'claim', to_jsonb(v_claim)
  );
end;
$function$;

create or replace function public.apply_p10_entry_order(
  p_order_id uuid,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_stop_price numeric,
  p_target_1 numeric,
  p_target_2 numeric,
  p_initial_risk numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.trading_orders%rowtype;
  v_position public.trading_positions%rowtype;
  v_now timestamptz := now();
  v_expected_side text;
begin
  select * into v_order
  from public.trading_orders
  where id = p_order_id
  for update;
  if not found then raise exception 'trading order % not found', p_order_id; end if;

  select * into v_position
  from public.trading_positions
  where id = v_order.position_id
  for update;
  if not found then raise exception 'position for order % not found', p_order_id; end if;

  if v_position.strategy_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' or
     v_position.exit_policy <> 'P10_SLOW_4R' then
    raise exception 'position % is not a P10 position', v_position.id;
  end if;
  v_expected_side := case when v_position.position_side = 'SHORT' then 'SELL' else 'BUY' end;
  if v_order.purpose <> 'ENTRY' or v_order.side <> v_expected_side then
    raise exception 'order % has invalid P10 entry direction', p_order_id;
  end if;
  if v_order.state = 'APPLIED' then
    return jsonb_build_object(
      'applied', false,
      'position', to_jsonb(v_position),
      'order', to_jsonb(v_order)
    );
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 or
     coalesce(p_initial_risk, 0) <= 0 then
    raise exception 'P10 entry fill and initial risk must be positive';
  end if;

  update public.trading_positions set
    state = 'OPEN',
    initial_quantity = p_fill_quantity,
    remaining_quantity = p_fill_quantity,
    average_entry_price = p_fill_price,
    planned_entry_price = p_fill_price,
    stop_price = p_stop_price,
    trailing_stop = p_stop_price,
    target_1 = p_target_1,
    target_2 = p_target_2,
    peak_price = p_fill_price,
    trough_price = p_fill_price,
    opened_at = coalesce(opened_at, v_now),
    realized_cost_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fees_quote = greatest(0, coalesce(p_fill_fee_quote, 0)),
    reserved_quote = 0,
    reserved_quantity = 0,
    reservation_expires_at = null,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_applied_order_id', p_order_id,
      'last_applied_order_at', v_now,
      'p10_initial_risk', p_initial_risk,
      'p10_realized_gross_pnl_quote', 0,
      'p10_entry_fee_quote', greatest(0, coalesce(p_fill_fee_quote, 0))
    ),
    updated_at = v_now
  where id = v_position.id
  returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED',
    executed_volume = p_fill_quantity,
    average_fill_price = p_fill_price,
    executed_funds_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fee_quote = greatest(0, coalesce(p_fill_fee_quote, 0)),
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = p_order_id
  returning * into v_order;

  update public.p10_signal_claims set
    status = 'FILLED',
    position_id = v_position.id,
    updated_at = v_now
  where position_id = v_position.id or
    id::text = coalesce(v_position.metadata->>'p10_claim_id', '');

  return jsonb_build_object(
    'applied', true,
    'position', to_jsonb(v_position),
    'order', to_jsonb(v_order)
  );
end;
$function$;

create or replace function public.apply_p10_exit_order(
  p_order_id uuid,
  p_action text,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_next_stop numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.trading_orders%rowtype;
  v_position public.trading_positions%rowtype;
  v_now timestamptz := now();
  v_expected_side text;
  v_quantity numeric;
  v_remaining numeric;
  v_exit_fee numeric;
  v_gross_delta numeric;
  v_gross_total numeric;
  v_fees_total numeric;
  v_closed boolean;
begin
  select * into v_order
  from public.trading_orders
  where id = p_order_id
  for update;
  if not found then raise exception 'trading order % not found', p_order_id; end if;

  select * into v_position
  from public.trading_positions
  where id = v_order.position_id
  for update;
  if not found then raise exception 'position for order % not found', p_order_id; end if;

  if v_position.strategy_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' or
     v_position.exit_policy <> 'P10_SLOW_4R' then
    raise exception 'position % is not a P10 position', v_position.id;
  end if;
  v_expected_side := case when v_position.position_side = 'SHORT' then 'BUY' else 'SELL' end;
  if v_order.purpose = 'ENTRY' or v_order.side <> v_expected_side then
    raise exception 'order % has invalid P10 exit direction', p_order_id;
  end if;
  if v_order.state = 'APPLIED' then
    return jsonb_build_object(
      'applied', false,
      'closed', v_position.state = 'CLOSED',
      'position', to_jsonb(v_position),
      'order', to_jsonb(v_order)
    );
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 then
    raise exception 'P10 exit fill must be positive';
  end if;

  v_quantity := least(v_position.remaining_quantity, p_fill_quantity);
  if v_quantity <= 0 or
     p_fill_quantity > v_position.remaining_quantity + greatest(0.000000000001, coalesce(v_position.quantity_step, 0) * 2) then
    raise exception 'P10 exit quantity exceeds remaining position';
  end if;
  v_remaining := greatest(0, v_position.remaining_quantity - v_quantity);
  v_closed := v_remaining <= greatest(0.000000000001, coalesce(v_position.quantity_step, 0) * 0.5);
  v_exit_fee := greatest(0, coalesce(p_fill_fee_quote, 0));
  v_gross_delta := case
    when v_position.position_side = 'SHORT'
      then (v_position.average_entry_price - p_fill_price) * v_quantity
    else (p_fill_price - v_position.average_entry_price) * v_quantity
  end;
  v_gross_total := coalesce((v_position.metadata->>'p10_realized_gross_pnl_quote')::numeric, 0) +
    v_gross_delta;
  v_fees_total := greatest(0, coalesce(v_position.paid_fees_quote, 0)) + v_exit_fee;

  update public.trading_positions set
    remaining_quantity = case when v_closed then 0 else v_remaining end,
    realized_proceeds_quote = coalesce(realized_proceeds_quote, 0) +
      greatest(0, coalesce(p_fill_funds, p_fill_price * v_quantity)),
    paid_fees_quote = v_fees_total,
    realized_pnl_quote = v_gross_total - v_fees_total,
    t1_completed = t1_completed or p_action = 'TARGET_1',
    trailing_stop = case when p_next_stop is null then trailing_stop else p_next_stop end,
    state = case when v_closed then 'CLOSED' else 'OPEN' end,
    close_reason = case when v_closed then p_action else null end,
    closed_at = case when v_closed then v_now else null end,
    reserved_quote = 0,
    reserved_quantity = 0,
    reservation_expires_at = null,
    marked_pnl_quote = null,
    metadata = (coalesce(metadata, '{}'::jsonb) -
      'pending_exit_action' - 'pending_exit_reason' - 'pending_exit_at') ||
      jsonb_build_object(
        'last_applied_order_id', p_order_id,
        'last_applied_order_at', v_now,
        'p10_realized_gross_pnl_quote', v_gross_total,
        'p10_last_exit_action', p_action,
        'p10_last_exit_price', p_fill_price,
        'p10_last_exit_quantity', v_quantity
      ),
    updated_at = v_now
  where id = v_position.id
  returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED',
    executed_volume = p_fill_quantity,
    average_fill_price = p_fill_price,
    executed_funds_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fee_quote = v_exit_fee,
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = p_order_id
  returning * into v_order;

  if v_closed then
    update public.p10_signal_claims set
      status = 'CLOSED',
      updated_at = v_now
    where position_id = v_position.id;
  end if;

  return jsonb_build_object(
    'applied', true,
    'closed', v_closed,
    'position', to_jsonb(v_position),
    'order', to_jsonb(v_order)
  );
end;
$function$;

revoke all on function public.claim_p10_signal(text, text, timestamptz, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.apply_p10_entry_order(uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.apply_p10_exit_order(uuid, text, numeric, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.claim_p10_signal(text, text, timestamptz, text, jsonb) to service_role;
grant execute on function public.apply_p10_entry_order(uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) to service_role;
grant execute on function public.apply_p10_exit_order(uuid, text, numeric, numeric, numeric, numeric, numeric) to service_role;
