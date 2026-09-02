create table if not exists public.v11_three_slot_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  observer_regime text,
  route text not null,
  available_usdt numeric,
  requested_slot_margin_usdt numeric not null,
  cash_buffer_usdt numeric not null,
  recommended_slot_margin_usdt numeric not null,
  full_40_slot_capacity integer not null,
  three_slot_feasible_at_40 boolean not null,
  candidate_count integer not null default 0,
  selected_count integer not null default 0,
  details jsonb not null default '{}'::jsonb
);

create table if not exists public.v11_three_slot_shadow_positions (
  run_id uuid not null references public.v11_three_slot_shadow_runs(id) on delete cascade,
  slot_no smallint not null check (slot_no between 1 and 3),
  source_signal_id uuid,
  lane text not null,
  symbol text not null,
  margin_usdt numeric not null,
  notional_usdt numeric not null,
  reference_price numeric,
  signal_status text,
  entry_bar_at timestamptz,
  primary key (run_id, slot_no),
  unique (run_id, symbol)
);

alter table public.v11_three_slot_shadow_runs enable row level security;
alter table public.v11_three_slot_shadow_positions enable row level security;

create or replace function public.run_v11_three_slot_shadow()
returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_run_id uuid := gen_random_uuid();
  v_regime text;
  v_route text := 'CASH';
  v_available numeric := 0;
  v_requested constant numeric := 40;
  v_cash_buffer constant numeric := 1.25;
  v_recommended numeric := 0;
  v_full_40_capacity integer := 0;
  v_candidate_count integer := 0;
  v_selected_count integer := 0;
begin
  select predicted_regime
    into v_regime
  from public.market_regime_observations
  where model_revision='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
    and trading_influence=true
  order by observed_at desc
  limit 1;

  v_route := case upper(coalesce(v_regime,''))
    when 'RISK_OFF' then 'BEAR'
    when 'NEUTRAL' then 'RANGE'
    when 'BULL' then 'BULL'
    when 'STRONG_BULL' then 'BULL'
    else 'CASH'
  end;

  select coalesce(available_quote,0)
    into v_available
  from public.trading_account_snapshots
  where exchange='binance_futures'
  order by captured_at desc
  limit 1;

  v_recommended := greatest(0, least(v_requested, trunc(greatest(0, v_available - v_cash_buffer) / 3, 2)));
  v_full_40_capacity := greatest(0, floor(greatest(0, v_available - v_cash_buffer) / v_requested)::integer);

  with candidates as (
    select distinct on (s.symbol)
      s.id,
      s.symbol,
      s.lane,
      s.status,
      s.entry_bar_at,
      nullif(s.features->>'referenceClose','')::numeric as reference_price
    from public.v11_long_regime_signals s
    where s.revision='V11-LONG-REGIME-1.0.1'
      and s.lane=v_route
      and s.entry_bar_at >= now() - interval '90 minutes'
      and coalesce(s.features->>'executionMode','') in ('MICRO','BULL_TREND')
    order by s.symbol, s.entry_bar_at desc
  )
  select count(*) into v_candidate_count from candidates;

  insert into public.v11_three_slot_shadow_runs(
    id, observer_regime, route, available_usdt,
    requested_slot_margin_usdt, cash_buffer_usdt,
    recommended_slot_margin_usdt, full_40_slot_capacity,
    three_slot_feasible_at_40, candidate_count, selected_count, details
  ) values (
    v_run_id, v_regime, v_route, v_available,
    v_requested, v_cash_buffer,
    v_recommended, v_full_40_capacity,
    (v_available - v_cash_buffer) >= (v_requested * 3),
    v_candidate_count, 0,
    jsonb_build_object(
      'mode','SHADOW_ONLY_NO_ORDERS',
      'max_slots',3,
      'leverage',3,
      'requested_total_margin_usdt',120,
      'recommended_total_margin_usdt',v_recommended*3,
      'capital_source','LATEST_STORED_BINANCE_FUTURES_SNAPSHOT',
      'signal_window_minutes',90
    )
  );

  with ranked as (
    select *, row_number() over (order by entry_bar_at desc, symbol) as rn
    from (
      select distinct on (s.symbol)
        s.id as source_signal_id,
        s.symbol,
        s.lane,
        s.status,
        s.entry_bar_at,
        nullif(s.features->>'referenceClose','')::numeric as reference_price
      from public.v11_long_regime_signals s
      where s.revision='V11-LONG-REGIME-1.0.1'
        and s.lane=v_route
        and s.entry_bar_at >= now() - interval '90 minutes'
        and coalesce(s.features->>'executionMode','') in ('MICRO','BULL_TREND')
      order by s.symbol, s.entry_bar_at desc
    ) q
  )
  insert into public.v11_three_slot_shadow_positions(
    run_id, slot_no, source_signal_id, lane, symbol,
    margin_usdt, notional_usdt, reference_price, signal_status, entry_bar_at
  )
  select
    v_run_id, rn::smallint, source_signal_id, lane, symbol,
    v_recommended, v_recommended*3, reference_price, status, entry_bar_at
  from ranked
  where rn <= 3
  order by rn;

  get diagnostics v_selected_count = row_count;

  update public.v11_three_slot_shadow_runs
     set selected_count = v_selected_count,
         details = details || jsonb_build_object(
           'selected_count',v_selected_count,
           'three_distinct_symbols',v_selected_count=3,
           'live_tables_modified',false,
           'orders_submitted',false
         )
   where id=v_run_id;

  return jsonb_build_object(
    'run_id',v_run_id,
    'observer_regime',v_regime,
    'route',v_route,
    'available_usdt',v_available,
    'requested_slot_margin_usdt',v_requested,
    'recommended_slot_margin_usdt',v_recommended,
    'full_40_slot_capacity',v_full_40_capacity,
    'three_slot_feasible_at_40',(v_available - v_cash_buffer) >= (v_requested*3),
    'candidate_count',v_candidate_count,
    'selected_count',v_selected_count,
    'mode','SHADOW_ONLY_NO_ORDERS'
  );
end;
$function$;

revoke all on function public.run_v11_three_slot_shadow() from public, anon, authenticated;
grant execute on function public.run_v11_three_slot_shadow() to service_role;

comment on table public.v11_three_slot_shadow_runs is 'Order-free V11 three-slot capacity and candidate shadow runs. Never routes exchange orders.';
comment on table public.v11_three_slot_shadow_positions is 'Order-free per-run three-slot candidate allocation. Never represents live exchange exposure.';