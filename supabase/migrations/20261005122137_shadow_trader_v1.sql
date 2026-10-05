-- Production-grade, order-free forward Shadow Trader.
-- This namespace is intentionally isolated from trading_positions/trading_orders and
-- every executable database surface is service-role only.

create table public.shadow_strategy_configs (
  strategy_key text not null,
  version text not null,
  enabled boolean not null default true,
  shadow_only boolean not null default true check (shadow_only),
  order_capability boolean not null default false check (not order_capability),
  scan_cycle_seconds integer not null check (scan_cycle_seconds >= 60),
  micro_cycle_seconds integer not null check (micro_cycle_seconds between 5 and 60),
  comparison_window_seconds integer not null check (comparison_window_seconds > 0),
  leverage numeric not null check (leverage > 0),
  margin_quote numeric not null check (margin_quote > 0),
  hard_stop_underlying_pct numeric not null check (hard_stop_underlying_pct = -5),
  partial_exit_fraction numeric not null check (partial_exit_fraction > 0 and partial_exit_fraction < 1),
  fee_bps_per_fill numeric not null check (fee_bps_per_fill >= 0),
  parameters jsonb not null default '{}'::jsonb,
  locked_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  primary key (strategy_key, version),
  check (strategy_key in ('SHADOW_TREND_LONG_V1','SHADOW_SHORT_SQUEEZE_LONG_V1')),
  check (version = 'V1')
);

insert into public.shadow_strategy_configs(
  strategy_key,version,scan_cycle_seconds,micro_cycle_seconds,comparison_window_seconds,
  leverage,margin_quote,hard_stop_underlying_pct,partial_exit_fraction,fee_bps_per_fill,parameters
) values
(
  'SHADOW_TREND_LONG_V1','V1',60,5,900,3,150,-5,0.50,5,
  jsonb_build_object(
    'candidate_source','BINANCE_USDM_24H_GAINERS_TOP20',
    'candidate_limit',20,
    'candidate_ttl_seconds',55,
    'max_open_positions',2,
    'max_total_shadow_positions',4,
    'virtual_notional_quote',450,
    'chart_min_score',4,
    'confirmation_min_score',4,
    'micro_max_spread_bps',8,
    'micro_max_slippage_bps',15,
    'micro_min_taker_buy_share',0.48,
    'micro_min_book_imbalance',-0.35,
    'weakness_partial_score',2,
    'weakness_full_score',4,
    'time_exit',false,
    'partial_exit_rule','FIRST_MEANINGFUL_WEAKNESS_WHILE_PROFITABLE'
  )
),
(
  'SHADOW_SHORT_SQUEEZE_LONG_V1','V1',60,5,900,3,150,-5,0.50,5,
  jsonb_build_object(
    'candidate_source','BINANCE_USDM_CROSS_SECTIONAL_NEGATIVE_FUNDING_TAIL',
    'funding_bottom_percentile',0.025,
    'funding_robust_z_max',-3,
    'candidate_limit',20,
    'candidate_ttl_seconds',55,
    'max_open_positions',2,
    'max_total_shadow_positions',4,
    'virtual_notional_quote',450,
    'chart_min_score',3,
    'confirmation_min_score',4,
    'micro_max_spread_bps',8,
    'micro_max_slippage_bps',15,
    'micro_min_taker_buy_share',0.52,
    'micro_min_book_imbalance',-0.35,
    'max_holding_seconds',3600,
    'funding_selection','RELATIVE_DISTRIBUTION_ONLY'
  )
);

create table public.shadow_runtime_state (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  shadow_only boolean not null default true check (shadow_only),
  order_capability boolean not null default false check (not order_capability),
  active_version text not null default 'V1' check (active_version = 'V1'),
  lease_owner uuid,
  lease_until timestamptz,
  last_tick_at timestamptz,
  last_scan_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.shadow_runtime_state(id) values (1);

create table public.shadow_strategy_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  tick_at timestamptz not null,
  scan_slot timestamptz,
  run_kind text not null check (run_kind in ('SCAN','MICRO')),
  status text not null check (status in ('RUNNING','COMPLETED','PARTIAL','ERROR','SKIPPED')),
  shadow_only boolean not null default true check (shadow_only),
  order_capability boolean not null default false check (not order_capability),
  stage_counts jsonb not null default '{}'::jsonb,
  universe_summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default clock_timestamp()
);
create index shadow_strategy_runs_tick_idx on public.shadow_strategy_runs(tick_at desc);

create table public.shadow_trade_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.shadow_strategy_runs(id) on delete restrict,
  strategy_key text not null check (strategy_key in ('SHADOW_TREND_LONG_V1','SHADOW_SHORT_SQUEEZE_LONG_V1')),
  strategy_version text not null default 'V1' check (strategy_version = 'V1'),
  market text not null check (market ~ '^[[:alnum:]]{1,24}USDT$'),
  candidate_decision_at timestamptz not null,
  entry_decision_at timestamptz,
  expires_at timestamptz not null,
  candidate_rank integer,
  funding_percentile numeric,
  funding_median numeric,
  funding_mad numeric,
  funding_robust_z numeric,
  stage text not null,
  decision text not null check (decision in ('WAIT','BUY','SKIP')),
  rejection_reasons text[] not null default '{}',
  stage_scores jsonb not null default '{}'::jsonb,
  market_features jsonb not null default '{}'::jsonb,
  chart_features jsonb not null default '{}'::jsonb,
  derivative_features jsonb not null default '{}'::jsonb,
  microstructure jsonb not null default '{}'::jsonb,
  best_bid numeric,
  best_ask numeric,
  spread_bps numeric,
  bid_depth numeric,
  ask_depth numeric,
  book_imbalance numeric,
  estimated_slippage_bps numeric,
  virtual_fill_price numeric,
  reference_price numeric,
  outcome_due_at timestamptz not null,
  outcome_status text not null default 'PENDING' check (outcome_status in ('PENDING','COMPLETE','ERROR')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(run_id,strategy_key,market)
);
create index shadow_candidates_active_idx on public.shadow_trade_candidates(strategy_key,market,expires_at desc)
  where stage in ('SHORTLISTED','MICRO_WAIT');
create index shadow_candidates_decision_idx on public.shadow_trade_candidates(candidate_decision_at desc,strategy_key,stage);

create table public.shadow_candidate_outcomes (
  candidate_id uuid primary key references public.shadow_trade_candidates(id) on delete restrict,
  strategy_key text not null,
  market text not null,
  candidate_decision_at timestamptz not null,
  reference_price numeric not null check (reference_price > 0),
  evaluated_at timestamptz not null,
  forward_5m_pct numeric,
  forward_15m_pct numeric,
  forward_30m_pct numeric,
  forward_60m_pct numeric,
  forward_120m_pct numeric,
  mfe_2h_pct numeric,
  mae_2h_pct numeric,
  was_entered boolean not null,
  terminal_stage text not null,
  rejection_reasons text[] not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);
create index shadow_candidate_outcomes_strategy_idx on public.shadow_candidate_outcomes(strategy_key,candidate_decision_at);

create table public.shadow_positions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.shadow_trade_candidates(id) on delete restrict,
  strategy_key text not null check (strategy_key in ('SHADOW_TREND_LONG_V1','SHADOW_SHORT_SQUEEZE_LONG_V1')),
  strategy_version text not null default 'V1' check (strategy_version = 'V1'),
  market text not null check (market ~ '^[[:alnum:]]{1,24}USDT$'),
  status text not null check (status in ('OPEN','CLOSED')),
  entry_at timestamptz not null,
  entry_price numeric not null check (entry_price > 0),
  entry_reference_price numeric not null check (entry_reference_price > 0),
  initial_quantity numeric not null check (initial_quantity > 0),
  remaining_quantity numeric not null check (remaining_quantity >= 0),
  initial_margin_quote numeric not null check (initial_margin_quote > 0),
  initial_notional_quote numeric not null check (initial_notional_quote > 0),
  leverage numeric not null check (leverage > 0),
  hard_stop_price numeric not null check (hard_stop_price > 0),
  partial_exit_done boolean not null default false,
  peak_price numeric not null,
  trough_price numeric not null,
  mfe_pct numeric not null default 0,
  mae_pct numeric not null default 0,
  unrealized_return_pct numeric not null default 0,
  realized_return_pct numeric not null default 0,
  levered_return_pct numeric not null default 0,
  gross_pnl_quote numeric not null default 0,
  realized_fill_pnl_quote numeric not null default 0,
  fee_quote numeric not null default 0,
  slippage_quote numeric not null default 0,
  net_pnl_quote numeric not null default 0,
  average_exit_price numeric,
  exited_quantity numeric not null default 0,
  latest_facts jsonb not null default '{}'::jsonb,
  exit_at timestamptz,
  exit_price numeric,
  exit_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (remaining_quantity <= initial_quantity),
  check ((status='OPEN' and remaining_quantity>0 and exit_at is null) or
         (status='CLOSED' and remaining_quantity=0 and exit_at is not null))
);
create unique index shadow_positions_one_open_strategy_market_idx
  on public.shadow_positions(strategy_key,market) where status='OPEN';
create index shadow_positions_open_idx on public.shadow_positions(status,strategy_key,entry_at);

create table public.shadow_position_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  position_id uuid not null references public.shadow_positions(id) on delete restrict,
  run_id uuid references public.shadow_strategy_runs(id) on delete restrict,
  candidate_id uuid references public.shadow_trade_candidates(id) on delete restrict,
  event_type text not null check (event_type in ('ENTRY','PARTIAL_EXIT','FULL_EXIT','HARD_STOP')),
  event_at timestamptz not null,
  price numeric not null check (price > 0),
  reference_price numeric not null check (reference_price > 0),
  quantity numeric not null check (quantity > 0),
  remaining_quantity numeric not null check (remaining_quantity >= 0),
  underlying_return_pct numeric,
  levered_return_pct numeric,
  gross_pnl_quote numeric,
  fee_quote numeric,
  slippage_quote numeric,
  net_pnl_quote numeric,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index shadow_position_events_position_idx on public.shadow_position_events(position_id,event_at);

create table public.shadow_trade_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_key text not null unique,
  position_id uuid references public.shadow_positions(id) on delete restrict,
  candidate_id uuid references public.shadow_trade_candidates(id) on delete restrict,
  run_id uuid references public.shadow_strategy_runs(id) on delete restrict,
  strategy_key text not null,
  market text not null,
  snapshot_type text not null,
  captured_at timestamptz not null,
  price numeric,
  mark_price numeric,
  index_price numeric,
  funding_rate numeric,
  basis numeric,
  basis_bps numeric,
  basis_slope numeric,
  basis_acceleration numeric,
  open_interest numeric,
  open_interest_value numeric,
  oi_change_pct numeric,
  macd numeric,
  dif numeric,
  dea numeric,
  volume numeric,
  volume_acceleration numeric,
  obv numeric,
  taker_buy numeric,
  taker_sell numeric,
  best_bid numeric,
  best_ask numeric,
  spread_bps numeric,
  bid_depth numeric,
  ask_depth numeric,
  book_imbalance numeric,
  estimated_slippage_bps numeric,
  candle_1m jsonb not null default '{}'::jsonb,
  candle_5m jsonb not null default '{}'::jsonb,
  candle_15m jsonb not null default '{}'::jsonb,
  candle_1h jsonb not null default '{}'::jsonb,
  chart_state jsonb not null default '{}'::jsonb,
  technical_state jsonb not null default '{}'::jsonb,
  derivative_state jsonb not null default '{}'::jsonb,
  microstructure jsonb not null default '{}'::jsonb,
  raw_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index shadow_snapshots_position_idx on public.shadow_trade_snapshots(position_id,captured_at desc);
create index shadow_snapshots_market_idx on public.shadow_trade_snapshots(market,captured_at desc);

create table public.shadow_trade_outcomes (
  position_id uuid primary key references public.shadow_positions(id) on delete restrict,
  strategy_key text not null,
  market text not null,
  entry_at timestamptz not null,
  exit_at timestamptz not null,
  holding_seconds bigint not null,
  entry_price numeric not null,
  exit_price numeric not null,
  underlying_return_pct numeric not null,
  levered_return_pct numeric not null,
  gross_pnl numeric not null,
  fee numeric not null,
  slippage numeric not null,
  net_pnl numeric not null,
  net_return_pct numeric not null,
  mfe_pct numeric not null,
  mae_pct numeric not null,
  mfe_capture_rate numeric,
  profit_giveback_pct numeric,
  hard_stop boolean not null,
  partial_take_profit boolean not null,
  exit_reason text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index shadow_outcomes_strategy_exit_idx on public.shadow_trade_outcomes(strategy_key,exit_at);

create table public.manual_shadow_comparisons (
  comparison_key text primary key,
  relation text not null check (relation in (
    'BOTH_SAME_SYMBOL_NEAR_TIME','BOTH_SAME_SYMBOL_DIFFERENT_TIME','USER_ONLY','SHADOW_ONLY'
  )),
  market text not null,
  manual_entry_key text,
  manual_entry_at timestamptz,
  manual_entry_price numeric,
  manual_quantity numeric,
  manual_leverage numeric,
  manual_exit_at timestamptz,
  manual_holding_seconds bigint,
  manual_underlying_return_pct numeric,
  manual_levered_return_pct numeric,
  manual_mfe_pct numeric,
  manual_mae_pct numeric,
  manual_profit_giveback_pct numeric,
  shadow_position_id uuid references public.shadow_positions(id) on delete restrict,
  shadow_strategy_key text,
  shadow_entry_at timestamptz,
  shadow_entry_price numeric,
  shadow_exit_at timestamptz,
  shadow_holding_seconds bigint,
  shadow_underlying_return_pct numeric,
  shadow_levered_return_pct numeric,
  shadow_mfe_pct numeric,
  shadow_mae_pct numeric,
  shadow_profit_giveback_pct numeric,
  entry_timing_difference_seconds bigint,
  comparison_window_seconds integer not null default 900,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index manual_shadow_relation_idx on public.manual_shadow_comparisons(relation,updated_at desc);

alter table public.shadow_strategy_configs enable row level security;
alter table public.shadow_runtime_state enable row level security;
alter table public.shadow_strategy_runs enable row level security;
alter table public.shadow_trade_candidates enable row level security;
alter table public.shadow_candidate_outcomes enable row level security;
alter table public.shadow_positions enable row level security;
alter table public.shadow_position_events enable row level security;
alter table public.shadow_trade_snapshots enable row level security;
alter table public.shadow_trade_outcomes enable row level security;
alter table public.manual_shadow_comparisons enable row level security;

revoke all on table public.shadow_strategy_configs,public.shadow_runtime_state,
  public.shadow_strategy_runs,public.shadow_trade_candidates,public.shadow_candidate_outcomes,public.shadow_positions,
  public.shadow_position_events,public.shadow_trade_snapshots,public.shadow_trade_outcomes,
  public.manual_shadow_comparisons from public,anon,authenticated;
grant select,insert,update,delete on table public.shadow_strategy_configs,public.shadow_runtime_state,
  public.shadow_strategy_runs,public.shadow_trade_candidates,public.shadow_candidate_outcomes,public.shadow_positions,
  public.shadow_position_events,public.shadow_trade_snapshots,public.shadow_trade_outcomes,
  public.manual_shadow_comparisons to service_role;

create function public.shadow_claim_runtime_v1(p_owner uuid,p_tick_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_scan_slot timestamptz := date_trunc('minute',p_tick_at);
  v_scan_due boolean;
  v_row public.shadow_runtime_state%rowtype;
begin
  if p_owner is null or p_tick_at is null or abs(extract(epoch from (clock_timestamp()-p_tick_at))) > 180 then
    return jsonb_build_object('acquired',false,'reason','INVALID_TICK');
  end if;
  select last_scan_at is null or last_scan_at < v_scan_slot into v_scan_due
  from public.shadow_runtime_state where id=1;
  update public.shadow_runtime_state
  set lease_owner=p_owner,
      lease_until=clock_timestamp()+interval '90 seconds',
      last_tick_at=p_tick_at,
      last_scan_at=case when v_scan_due then v_scan_slot else last_scan_at end,
      updated_at=clock_timestamp()
  where id=1 and enabled and shadow_only and not order_capability
    and (lease_until is null or lease_until < clock_timestamp() or lease_owner=p_owner)
  returning * into v_row;
  if not found then return jsonb_build_object('acquired',false,'reason','LEASE_BUSY_OR_DISABLED'); end if;
  return jsonb_build_object('acquired',true,'scan_due',v_scan_due,'scan_slot',v_scan_slot,
    'lease_until',v_row.lease_until,'shadow_only',true,'order_capability',false);
end
$$;

create function public.shadow_release_runtime_v1(p_owner uuid,p_ok boolean,p_error text default null)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.shadow_runtime_state
  set lease_owner=null,lease_until=null,
      last_success_at=case when p_ok then clock_timestamp() else last_success_at end,
      last_error=case when p_ok then null else left(coalesce(p_error,'UNKNOWN'),500) end,
      updated_at=clock_timestamp()
  where id=1 and lease_owner=p_owner
  returning true
$$;

create function public.shadow_open_position_v1(
  p_candidate_id uuid,p_run_id uuid,p_at timestamptz,p_entry_price numeric,
  p_reference_price numeric,p_quantity numeric,p_margin_quote numeric,p_notional_quote numeric,
  p_leverage numeric,p_entry_fee numeric,p_entry_slippage numeric,p_snapshot jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c public.shadow_trade_candidates%rowtype;
  p public.shadow_positions%rowtype;
  v_stop numeric;
  v_event_key text;
begin
  select * into c from public.shadow_trade_candidates where id=p_candidate_id for update;
  if not found then raise exception 'SHADOW_CANDIDATE_NOT_FOUND'; end if;
  if c.stage not in ('SHORTLISTED','MICRO_WAIT') or c.expires_at < p_at then
    return jsonb_build_object('opened',false,'reason','CANDIDATE_NOT_ACTIVE');
  end if;
  if p_entry_price<=0 or p_reference_price<=0 or p_quantity<=0 or p_leverage<=0 then
    raise exception 'SHADOW_ENTRY_INVALID';
  end if;
  if exists(select 1 from public.shadow_positions x where x.strategy_key=c.strategy_key and x.market=c.market and x.status='OPEN') then
    update public.shadow_trade_candidates set stage='RISK_BLOCKED',decision='SKIP',
      rejection_reasons=array_append(rejection_reasons,'ALREADY_POSITIONED'),updated_at=clock_timestamp()
    where id=c.id;
    return jsonb_build_object('opened',false,'reason','ALREADY_POSITIONED');
  end if;
  v_stop=p_entry_price*0.95;
  insert into public.shadow_positions(
    candidate_id,strategy_key,market,status,entry_at,entry_price,entry_reference_price,
    initial_quantity,remaining_quantity,initial_margin_quote,initial_notional_quote,leverage,
    hard_stop_price,peak_price,trough_price,fee_quote,slippage_quote,net_pnl_quote,latest_facts
  ) values (
    c.id,c.strategy_key,c.market,'OPEN',p_at,p_entry_price,p_reference_price,
    p_quantity,p_quantity,p_margin_quote,p_notional_quote,p_leverage,
    v_stop,p_reference_price,p_reference_price,p_entry_fee,p_entry_slippage,
    -p_entry_fee-p_entry_slippage,coalesce(p_snapshot,'{}'::jsonb)
  ) returning * into p;

  update public.shadow_trade_candidates set stage='ENTERED',decision='BUY',entry_decision_at=p_at,
    virtual_fill_price=p_entry_price,updated_at=clock_timestamp() where id=c.id;

  v_event_key='ENTRY:'||c.id::text;
  insert into public.shadow_position_events(
    event_key,position_id,run_id,candidate_id,event_type,event_at,price,reference_price,quantity,
    remaining_quantity,underlying_return_pct,levered_return_pct,gross_pnl_quote,fee_quote,
    slippage_quote,net_pnl_quote,reason,evidence
  ) values (
    v_event_key,p.id,p_run_id,c.id,'ENTRY',p_at,p_entry_price,p_reference_price,p_quantity,
    p_quantity,0,0,0,p_entry_fee,p_entry_slippage,-p_entry_fee-p_entry_slippage,
    'SHADOW_ENTRY',coalesce(p_snapshot,'{}'::jsonb)
  );

  insert into public.shadow_trade_snapshots(
    snapshot_key,position_id,candidate_id,run_id,strategy_key,market,snapshot_type,captured_at,
    price,mark_price,index_price,funding_rate,basis,basis_bps,basis_slope,basis_acceleration,
    open_interest,open_interest_value,oi_change_pct,macd,dif,dea,volume,volume_acceleration,
    obv,taker_buy,taker_sell,best_bid,best_ask,spread_bps,bid_depth,ask_depth,book_imbalance,
    estimated_slippage_bps,candle_1m,candle_5m,candle_15m,candle_1h,chart_state,
    technical_state,derivative_state,microstructure,raw_snapshot
  ) values (
    v_event_key,p.id,c.id,p_run_id,c.strategy_key,c.market,'ENTRY',p_at,
    p_reference_price,(p_snapshot->>'mark_price')::numeric,(p_snapshot->>'index_price')::numeric,
    (p_snapshot#>>'{derivatives,funding_rate}')::numeric,(p_snapshot#>>'{derivatives,basis}')::numeric,
    (p_snapshot#>>'{derivatives,basis_bps}')::numeric,(p_snapshot#>>'{derivatives,basis_slope}')::numeric,
    (p_snapshot#>>'{derivatives,basis_acceleration}')::numeric,(p_snapshot#>>'{derivatives,open_interest}')::numeric,
    (p_snapshot#>>'{derivatives,open_interest_value}')::numeric,(p_snapshot#>>'{derivatives,oi_change_1h_pct}')::numeric,
    (p_snapshot#>>'{technical,macd_hist}')::numeric,(p_snapshot#>>'{technical,dif}')::numeric,
    (p_snapshot#>>'{technical,dea}')::numeric,(p_snapshot#>>'{technical,volume}')::numeric,
    (p_snapshot#>>'{technical,volume_acceleration}')::numeric,(p_snapshot#>>'{technical,obv}')::numeric,
    (p_snapshot#>>'{microstructure,taker_buy}')::numeric,(p_snapshot#>>'{microstructure,taker_sell}')::numeric,
    (p_snapshot#>>'{microstructure,best_bid}')::numeric,(p_snapshot#>>'{microstructure,best_ask}')::numeric,
    (p_snapshot#>>'{microstructure,spread_bps}')::numeric,(p_snapshot#>>'{microstructure,bid_depth}')::numeric,
    (p_snapshot#>>'{microstructure,ask_depth}')::numeric,(p_snapshot#>>'{microstructure,book_imbalance}')::numeric,
    (p_snapshot#>>'{microstructure,estimated_slippage_bps}')::numeric,coalesce(p_snapshot#>'{candles,m1}','{}'),
    coalesce(p_snapshot#>'{candles,m5}','{}'),coalesce(p_snapshot#>'{candles,m15}','{}'),
    coalesce(p_snapshot#>'{candles,h1}','{}'),coalesce(p_snapshot->'chart','{}'),
    coalesce(p_snapshot->'technical','{}'),coalesce(p_snapshot->'derivatives','{}'),
    coalesce(p_snapshot->'microstructure','{}'),coalesce(p_snapshot,'{}')
  );
  return jsonb_build_object('opened',true,'position_id',p.id,'hard_stop_price',v_stop,
    'shadow_only',true,'order_capability',false);
end
$$;

create function public.shadow_record_position_tick_v1(
  p_position_id uuid,p_run_id uuid,p_at timestamptz,p_action text,p_reference_price numeric,
  p_exit_price numeric,p_exit_quantity numeric,p_exit_fee numeric,p_exit_reason text,p_snapshot jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  p public.shadow_positions%rowtype;
  v_qty numeric:=0;
  v_remaining numeric;
  v_peak numeric;
  v_trough numeric;
  v_mfe numeric;
  v_mae numeric;
  v_unrealized numeric;
  v_event_gross numeric:=0;
  v_event_fill_pnl numeric:=0;
  v_event_slippage numeric:=0;
  v_exited numeric;
  v_avg_exit numeric;
  v_status text;
  v_event_type text;
  v_event_key text;
  v_gross numeric;
  v_fill_pnl numeric;
  v_fees numeric;
  v_slippage numeric;
  v_net numeric;
  v_underlying numeric;
  v_levered numeric;
begin
  if p_action not in ('HOLD','PARTIAL_EXIT','FULL_EXIT','HARD_STOP') then raise exception 'SHADOW_ACTION_INVALID'; end if;
  select * into p from public.shadow_positions where id=p_position_id for update;
  if not found then raise exception 'SHADOW_POSITION_NOT_FOUND'; end if;
  if p.status<>'OPEN' then return jsonb_build_object('applied',false,'reason','POSITION_ALREADY_CLOSED'); end if;
  if p_reference_price is null or p_reference_price<=0 then raise exception 'SHADOW_REFERENCE_PRICE_INVALID'; end if;

  v_peak=greatest(p.peak_price,p_reference_price);
  v_trough=least(p.trough_price,p_reference_price);
  v_mfe=(v_peak/p.entry_price-1)*100;
  v_mae=(v_trough/p.entry_price-1)*100;
  v_unrealized=(p_reference_price/p.entry_price-1)*100;

  if p_reference_price<=p.hard_stop_price then
    p_action='HARD_STOP';
    p_exit_reason='UNDERLYING_HARD_STOP_MINUS_5_PCT';
  end if;

  if p_action='HOLD' then
    update public.shadow_positions set peak_price=v_peak,trough_price=v_trough,mfe_pct=v_mfe,mae_pct=v_mae,
      unrealized_return_pct=v_unrealized,latest_facts=coalesce(p_snapshot,'{}'::jsonb),updated_at=clock_timestamp()
    where id=p.id;
    insert into public.shadow_trade_snapshots(
      snapshot_key,position_id,run_id,strategy_key,market,snapshot_type,captured_at,price,mark_price,index_price,
      funding_rate,basis,basis_bps,basis_slope,basis_acceleration,open_interest,open_interest_value,oi_change_pct,
      macd,dif,dea,volume,volume_acceleration,obv,taker_buy,taker_sell,best_bid,best_ask,spread_bps,bid_depth,
      ask_depth,book_imbalance,estimated_slippage_bps,candle_1m,candle_5m,candle_15m,candle_1h,chart_state,
      technical_state,derivative_state,microstructure,raw_snapshot
    ) values (
      'HOLD:'||p.id::text||':'||(floor(extract(epoch from p_at)*5)/5)::bigint,p.id,p_run_id,p.strategy_key,p.market,'HOLD',p_at,
      p_reference_price,(p_snapshot->>'mark_price')::numeric,(p_snapshot->>'index_price')::numeric,
      (p_snapshot#>>'{derivatives,funding_rate}')::numeric,(p_snapshot#>>'{derivatives,basis}')::numeric,
      (p_snapshot#>>'{derivatives,basis_bps}')::numeric,(p_snapshot#>>'{derivatives,basis_slope}')::numeric,
      (p_snapshot#>>'{derivatives,basis_acceleration}')::numeric,(p_snapshot#>>'{derivatives,open_interest}')::numeric,
      (p_snapshot#>>'{derivatives,open_interest_value}')::numeric,(p_snapshot#>>'{derivatives,oi_change_1h_pct}')::numeric,
      (p_snapshot#>>'{technical,macd_hist}')::numeric,(p_snapshot#>>'{technical,dif}')::numeric,
      (p_snapshot#>>'{technical,dea}')::numeric,(p_snapshot#>>'{technical,volume}')::numeric,
      (p_snapshot#>>'{technical,volume_acceleration}')::numeric,(p_snapshot#>>'{technical,obv}')::numeric,
      (p_snapshot#>>'{microstructure,taker_buy}')::numeric,(p_snapshot#>>'{microstructure,taker_sell}')::numeric,
      (p_snapshot#>>'{microstructure,best_bid}')::numeric,(p_snapshot#>>'{microstructure,best_ask}')::numeric,
      (p_snapshot#>>'{microstructure,spread_bps}')::numeric,(p_snapshot#>>'{microstructure,bid_depth}')::numeric,
      (p_snapshot#>>'{microstructure,ask_depth}')::numeric,(p_snapshot#>>'{microstructure,book_imbalance}')::numeric,
      (p_snapshot#>>'{microstructure,estimated_slippage_bps}')::numeric,coalesce(p_snapshot#>'{candles,m1}','{}'),
      coalesce(p_snapshot#>'{candles,m5}','{}'),coalesce(p_snapshot#>'{candles,m15}','{}'),
      coalesce(p_snapshot#>'{candles,h1}','{}'),coalesce(p_snapshot->'chart','{}'),coalesce(p_snapshot->'technical','{}'),
      coalesce(p_snapshot->'derivatives','{}'),coalesce(p_snapshot->'microstructure','{}'),coalesce(p_snapshot,'{}')
    ) on conflict(snapshot_key) do nothing;
    return jsonb_build_object('applied',true,'action','HOLD','mfe_pct',v_mfe,'mae_pct',v_mae);
  end if;

  if p_exit_price is null or p_exit_price<=0 then raise exception 'SHADOW_EXIT_PRICE_INVALID'; end if;
  if p_action='PARTIAL_EXIT' then
    if p.partial_exit_done then return jsonb_build_object('applied',false,'reason','PARTIAL_ALREADY_DONE'); end if;
    v_qty=least(coalesce(p_exit_quantity,p.initial_quantity*0.5),p.remaining_quantity);
    if v_qty<=0 or v_qty>=p.remaining_quantity then raise exception 'SHADOW_PARTIAL_QUANTITY_INVALID'; end if;
    v_event_type='PARTIAL_EXIT';v_event_key='PARTIAL_EXIT:'||p.id::text;v_status='OPEN';
  else
    v_qty=p.remaining_quantity;v_event_type=case when p_action='HARD_STOP' then 'HARD_STOP' else 'FULL_EXIT' end;
    v_event_key=v_event_type||':'||p.id::text;v_status='CLOSED';
  end if;

  v_remaining=p.remaining_quantity-v_qty;
  v_event_gross=(p_reference_price-p.entry_reference_price)*v_qty;
  v_event_fill_pnl=(p_exit_price-p.entry_price)*v_qty;
  v_event_slippage=greatest(0,(p_reference_price-p_exit_price)*v_qty);
  v_exited=p.exited_quantity+v_qty;
  v_avg_exit=case when v_exited>0 then (coalesce(p.average_exit_price,0)*p.exited_quantity+p_exit_price*v_qty)/v_exited end;
  v_gross=p.gross_pnl_quote+v_event_gross;
  v_fill_pnl=p.realized_fill_pnl_quote+v_event_fill_pnl;
  v_fees=p.fee_quote+coalesce(p_exit_fee,0);
  v_slippage=p.slippage_quote+v_event_slippage;
  v_net=v_gross-v_fees-v_slippage;
  v_underlying=case when p.entry_price*v_exited>0 then v_fill_pnl/(p.entry_price*v_exited)*100 else 0 end;
  v_levered=v_underlying*p.leverage;

  update public.shadow_positions set
    status=v_status,remaining_quantity=v_remaining,partial_exit_done=partial_exit_done or p_action='PARTIAL_EXIT',
    peak_price=v_peak,trough_price=v_trough,mfe_pct=v_mfe,mae_pct=v_mae,unrealized_return_pct=v_unrealized,
    realized_return_pct=v_underlying,levered_return_pct=v_levered,gross_pnl_quote=v_gross,
    realized_fill_pnl_quote=v_fill_pnl,fee_quote=v_fees,slippage_quote=v_slippage,net_pnl_quote=v_net,
    average_exit_price=v_avg_exit,exited_quantity=v_exited,latest_facts=coalesce(p_snapshot,'{}'::jsonb),
    exit_at=case when v_status='CLOSED' then p_at else null end,
    exit_price=case when v_status='CLOSED' then v_avg_exit else null end,
    exit_reason=case when v_status='CLOSED' then coalesce(p_exit_reason,p_action) else null end,
    updated_at=clock_timestamp()
  where id=p.id;

  insert into public.shadow_position_events(
    event_key,position_id,run_id,candidate_id,event_type,event_at,price,reference_price,quantity,
    remaining_quantity,underlying_return_pct,levered_return_pct,gross_pnl_quote,fee_quote,
    slippage_quote,net_pnl_quote,reason,evidence
  ) values (
    v_event_key,p.id,p_run_id,p.candidate_id,v_event_type,p_at,p_exit_price,p_reference_price,v_qty,
    v_remaining,v_underlying,v_levered,v_event_gross,coalesce(p_exit_fee,0),v_event_slippage,
    v_event_gross-v_event_slippage-coalesce(p_exit_fee,0),coalesce(p_exit_reason,p_action),coalesce(p_snapshot,'{}'::jsonb)
  ) on conflict(event_key) do nothing;

  insert into public.shadow_trade_snapshots(
    snapshot_key,position_id,candidate_id,run_id,strategy_key,market,snapshot_type,captured_at,price,mark_price,index_price,
    funding_rate,basis,basis_bps,basis_slope,basis_acceleration,open_interest,open_interest_value,oi_change_pct,
    macd,dif,dea,volume,volume_acceleration,obv,taker_buy,taker_sell,best_bid,best_ask,spread_bps,bid_depth,
    ask_depth,book_imbalance,estimated_slippage_bps,candle_1m,candle_5m,candle_15m,candle_1h,chart_state,
    technical_state,derivative_state,microstructure,raw_snapshot
  ) values (
    v_event_key,p.id,p.candidate_id,p_run_id,p.strategy_key,p.market,v_event_type,p_at,p_reference_price,
    (p_snapshot->>'mark_price')::numeric,(p_snapshot->>'index_price')::numeric,(p_snapshot#>>'{derivatives,funding_rate}')::numeric,
    (p_snapshot#>>'{derivatives,basis}')::numeric,(p_snapshot#>>'{derivatives,basis_bps}')::numeric,
    (p_snapshot#>>'{derivatives,basis_slope}')::numeric,(p_snapshot#>>'{derivatives,basis_acceleration}')::numeric,
    (p_snapshot#>>'{derivatives,open_interest}')::numeric,(p_snapshot#>>'{derivatives,open_interest_value}')::numeric,
    (p_snapshot#>>'{derivatives,oi_change_1h_pct}')::numeric,(p_snapshot#>>'{technical,macd_hist}')::numeric,
    (p_snapshot#>>'{technical,dif}')::numeric,(p_snapshot#>>'{technical,dea}')::numeric,
    (p_snapshot#>>'{technical,volume}')::numeric,(p_snapshot#>>'{technical,volume_acceleration}')::numeric,
    (p_snapshot#>>'{technical,obv}')::numeric,(p_snapshot#>>'{microstructure,taker_buy}')::numeric,
    (p_snapshot#>>'{microstructure,taker_sell}')::numeric,(p_snapshot#>>'{microstructure,best_bid}')::numeric,
    (p_snapshot#>>'{microstructure,best_ask}')::numeric,(p_snapshot#>>'{microstructure,spread_bps}')::numeric,
    (p_snapshot#>>'{microstructure,bid_depth}')::numeric,(p_snapshot#>>'{microstructure,ask_depth}')::numeric,
    (p_snapshot#>>'{microstructure,book_imbalance}')::numeric,(p_snapshot#>>'{microstructure,estimated_slippage_bps}')::numeric,
    coalesce(p_snapshot#>'{candles,m1}','{}'),coalesce(p_snapshot#>'{candles,m5}','{}'),
    coalesce(p_snapshot#>'{candles,m15}','{}'),coalesce(p_snapshot#>'{candles,h1}','{}'),
    coalesce(p_snapshot->'chart','{}'),coalesce(p_snapshot->'technical','{}'),coalesce(p_snapshot->'derivatives','{}'),
    coalesce(p_snapshot->'microstructure','{}'),coalesce(p_snapshot,'{}')
  ) on conflict(snapshot_key) do nothing;

  if v_status='CLOSED' then
    insert into public.shadow_trade_outcomes(
      position_id,strategy_key,market,entry_at,exit_at,holding_seconds,entry_price,exit_price,
      underlying_return_pct,levered_return_pct,gross_pnl,fee,slippage,net_pnl,net_return_pct,
      mfe_pct,mae_pct,mfe_capture_rate,profit_giveback_pct,hard_stop,partial_take_profit,exit_reason
    ) values (
      p.id,p.strategy_key,p.market,p.entry_at,p_at,extract(epoch from (p_at-p.entry_at))::bigint,p.entry_price,v_avg_exit,
      v_underlying,v_levered,v_gross,v_fees,v_slippage,v_net,v_net/p.initial_margin_quote*100,
      v_mfe,v_mae,case when v_mfe>0 then greatest(0,v_underlying)/v_mfe else null end,
      case when v_mfe>0 then greatest(0,v_mfe-v_underlying) else 0 end,p_action='HARD_STOP',
      p.partial_exit_done or p_action='PARTIAL_EXIT',coalesce(p_exit_reason,p_action)
    ) on conflict(position_id) do nothing;
  end if;
  return jsonb_build_object('applied',true,'action',p_action,'remaining_quantity',v_remaining,
    'underlying_return_pct',v_underlying,'levered_return_pct',v_levered,'net_pnl',v_net);
end
$$;

create function public.shadow_refresh_comparisons_v1(p_since timestamptz default clock_timestamp()-interval '7 days')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_pairs integer:=0;v_user integer:=0;v_shadow integer:=0;
begin
  delete from public.manual_shadow_comparisons
  where coalesce(manual_entry_at,shadow_entry_at) >= p_since;

  with manual_entries as (
    select l.market,coalesce(l.exchange_order_id,'TRADE:'||l.exchange_trade_id::text) entry_key,
      min(l.executed_at) entry_at,sum(l.price*l.quantity)/nullif(sum(l.quantity),0) entry_price,
      sum(l.quantity) quantity,max(l.leverage) leverage,max(l.strategy_tag) strategy_tag
    from public.manual_trade_ledger l
    where l.source_classification='MANUAL' and l.side='BUY' and l.executed_at>=p_since
      and (l.event_type='ENTRY_OR_ADD' or l.event_type is null)
    group by l.market,coalesce(l.exchange_order_id,'TRADE:'||l.exchange_trade_id::text)
  ), nearest as (
    select m.*,s.id shadow_id,s.strategy_key,s.entry_at shadow_entry_at,s.entry_price shadow_entry_price,
      abs(extract(epoch from (s.entry_at-m.entry_at)))::bigint diff_seconds,
      row_number() over(partition by m.market,m.entry_key order by abs(extract(epoch from (s.entry_at-m.entry_at))),s.id) rn
    from manual_entries m join public.shadow_positions s on s.market=m.market
      and s.entry_at between m.entry_at-interval '24 hours' and m.entry_at+interval '24 hours'
  ), chosen as (select * from nearest where rn=1)
  insert into public.manual_shadow_comparisons(
    comparison_key,relation,market,manual_entry_key,manual_entry_at,manual_entry_price,manual_quantity,
    manual_leverage,shadow_position_id,shadow_strategy_key,shadow_entry_at,shadow_entry_price,
    entry_timing_difference_seconds,evidence,updated_at
  ) select 'PAIR:'||market||':'||entry_key||':'||shadow_id::text,
    case when diff_seconds<=900 then 'BOTH_SAME_SYMBOL_NEAR_TIME' else 'BOTH_SAME_SYMBOL_DIFFERENT_TIME' end,
    market,entry_key,entry_at,entry_price,quantity,leverage,shadow_id,strategy_key,shadow_entry_at,
    shadow_entry_price,extract(epoch from (shadow_entry_at-entry_at))::bigint,
    jsonb_build_object('matching_window_seconds',900,'different_time_horizon_hours',24),clock_timestamp()
  from chosen
  on conflict(comparison_key) do update set relation=excluded.relation,updated_at=excluded.updated_at;
  get diagnostics v_pairs=row_count;

  with manual_entries as (
    select l.market,coalesce(l.exchange_order_id,'TRADE:'||l.exchange_trade_id::text) entry_key,
      min(l.executed_at) entry_at,sum(l.price*l.quantity)/nullif(sum(l.quantity),0) entry_price,
      sum(l.quantity) quantity,max(l.leverage) leverage
    from public.manual_trade_ledger l
    where l.source_classification='MANUAL' and l.side='BUY' and l.executed_at>=p_since
      and (l.event_type='ENTRY_OR_ADD' or l.event_type is null)
    group by l.market,coalesce(l.exchange_order_id,'TRADE:'||l.exchange_trade_id::text)
  )
  insert into public.manual_shadow_comparisons(
    comparison_key,relation,market,manual_entry_key,manual_entry_at,manual_entry_price,manual_quantity,
    manual_leverage,evidence,updated_at
  ) select 'USER:'||m.market||':'||m.entry_key,'USER_ONLY',m.market,m.entry_key,m.entry_at,m.entry_price,
    m.quantity,m.leverage,jsonb_build_object('reason','NO_SAME_SYMBOL_SHADOW_WITHIN_24H'),clock_timestamp()
  from manual_entries m where not exists(select 1 from public.shadow_positions s where s.market=m.market
    and s.entry_at between m.entry_at-interval '24 hours' and m.entry_at+interval '24 hours')
  on conflict(comparison_key) do update set updated_at=excluded.updated_at;
  get diagnostics v_user=row_count;

  insert into public.manual_shadow_comparisons(
    comparison_key,relation,market,shadow_position_id,shadow_strategy_key,shadow_entry_at,shadow_entry_price,
    evidence,updated_at
  ) select 'SHADOW:'||s.id::text,'SHADOW_ONLY',s.market,s.id,s.strategy_key,s.entry_at,s.entry_price,
    jsonb_build_object('reason','NO_SAME_SYMBOL_MANUAL_WITHIN_24H'),clock_timestamp()
  from public.shadow_positions s where s.entry_at>=p_since and not exists(
    select 1 from public.manual_trade_ledger l where l.source_classification='MANUAL' and l.side='BUY'
      and (l.event_type='ENTRY_OR_ADD' or l.event_type is null) and l.market=s.market
      and l.executed_at between s.entry_at-interval '24 hours' and s.entry_at+interval '24 hours')
  on conflict(comparison_key) do update set updated_at=excluded.updated_at;
  get diagnostics v_shadow=row_count;

  update public.manual_shadow_comparisons c set
    manual_exit_at=o.exit_at,manual_holding_seconds=o.holding_seconds,
    manual_underlying_return_pct=o.return_pct,manual_levered_return_pct=o.roi_pct,
    manual_mfe_pct=o.mfe_pct,manual_mae_pct=o.mae_pct,manual_profit_giveback_pct=o.profit_giveback_pct,
    updated_at=clock_timestamp()
  from public.manual_trade_outcomes o where c.manual_entry_key=o.entry_order_id and c.market=o.market;

  update public.manual_shadow_comparisons c set
    shadow_exit_at=o.exit_at,shadow_holding_seconds=o.holding_seconds,
    shadow_underlying_return_pct=o.underlying_return_pct,shadow_levered_return_pct=o.levered_return_pct,
    shadow_mfe_pct=o.mfe_pct,shadow_mae_pct=o.mae_pct,shadow_profit_giveback_pct=o.profit_giveback_pct,
    updated_at=clock_timestamp()
  from public.shadow_trade_outcomes o where c.shadow_position_id=o.position_id;
  return jsonb_build_object('pairs',v_pairs,'user_only',v_user,'shadow_only',v_shadow);
end
$$;

create view public.shadow_strategy_stats_v1
with (security_invoker=true)
as
with base as (
  select o.*,sum(o.net_pnl) over(partition by o.strategy_key order by o.exit_at,o.position_id) equity
  from public.shadow_trade_outcomes o
), dd as (
  select b.*,b.equity-max(b.equity) over(partition by b.strategy_key order by b.exit_at,b.position_id) drawdown
  from base b
)
select strategy_key,count(*) trade_count,
  avg((net_pnl>0)::int)::numeric win_rate,avg((net_pnl<0)::int)::numeric loss_rate,
  avg(underlying_return_pct) avg_return,percentile_cont(0.5) within group(order by underlying_return_pct) median_return,
  avg(net_pnl) expectancy,
  sum(net_pnl) filter(where net_pnl>0)/nullif(abs(sum(net_pnl) filter(where net_pnl<0)),0) profit_factor,
  sum(net_pnl) total_pnl,min(drawdown) max_drawdown,avg(mfe_pct) avg_mfe,avg(mae_pct) avg_mae,
  avg(mfe_capture_rate) mfe_capture_rate,avg(profit_giveback_pct) profit_giveback,
  avg(hard_stop::int)::numeric hard_stop_rate,avg(partial_take_profit::int)::numeric partial_take_profit_rate,
  avg(holding_seconds) avg_hold_seconds,
  percentile_cont(0.05) within group(order by underlying_return_pct) p95_loss
from dd group by strategy_key;

revoke all on public.shadow_strategy_stats_v1 from public,anon,authenticated;
grant select on public.shadow_strategy_stats_v1 to service_role;

revoke all on function public.shadow_claim_runtime_v1(uuid,timestamptz),
  public.shadow_release_runtime_v1(uuid,boolean,text),
  public.shadow_open_position_v1(uuid,uuid,timestamptz,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,jsonb),
  public.shadow_record_position_tick_v1(uuid,uuid,timestamptz,text,numeric,numeric,numeric,numeric,text,jsonb),
  public.shadow_refresh_comparisons_v1(timestamptz)
from public,anon,authenticated;
grant execute on function public.shadow_claim_runtime_v1(uuid,timestamptz),
  public.shadow_release_runtime_v1(uuid,boolean,text),
  public.shadow_open_position_v1(uuid,uuid,timestamptz,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,jsonb),
  public.shadow_record_position_tick_v1(uuid,uuid,timestamptz,text,numeric,numeric,numeric,numeric,text,jsonb),
  public.shadow_refresh_comparisons_v1(timestamptz)
to service_role;

insert into public.edge_internal_tokens(name,token,created_at,rotated_at)
values('shadow-trader-v1',encode(extensions.gen_random_bytes(32),'hex'),clock_timestamp(),clock_timestamp())
on conflict(name) do nothing;

do $$
declare v_job bigint;
begin
  select jobid into v_job from cron.job where jobname='shadow-trader-v1-5s';
  if v_job is not null then perform cron.unschedule(v_job); end if;
  perform cron.schedule(
    'shadow-trader-v1-5s','5 seconds',
    $job$
      select net.http_post(
        url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/shadow-trader-v1',
        headers:=jsonb_build_object('content-type','application/json','x-shadow-trader-token',
          (select token from public.edge_internal_tokens where name='shadow-trader-v1')),
        body:='{"action":"tick"}'::jsonb,
        timeout_milliseconds:=55000
      );
    $job$
  );
end
$$;

comment on table public.shadow_positions is 'Order-free virtual positions only. Never exchange exposure.';
comment on function public.shadow_open_position_v1 is 'Creates only a virtual Shadow position. No exchange or production order mutation.';
comment on function public.shadow_record_position_tick_v1 is 'Maintains virtual Shadow lifecycle and accounting only.';
