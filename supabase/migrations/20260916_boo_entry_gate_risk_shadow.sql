-- BOO integration: common entry gate, central risk reservation, ledger
-- exceptions and strategy SHADOW (brief sections 3, 4, 6, 10).
--
-- Split into two parts on purpose:
--   PART A creates NEW tables only. It touches nothing that production reads
--          today, so it is safe to apply at any time and is what the SHADOW
--          needs in order to run.
--   PART B adds nullable columns to two LIVE tables. It is additive and
--          reversible, but it changes rows the executor reads every minute, so
--          the operator applies it deliberately as part of the cutover.
--
-- Rollback for every object here is at the bottom of the file.

-- ==========================================================================
-- PART A -- new tables
-- ==========================================================================

-- Who may enforce the gate, and in which mode.
-- ENFORCE (default, fail-closed): a refusal blocks the entry.
-- OBSERVE: the verdict is recorded but the legacy path proceeds, so the
-- operator can measure the impact of enforcement before turning it on.
create table if not exists public.boo_entry_gate_control (
  singleton boolean primary key default true check (singleton),
  enforcement text not null default 'ENFORCE' check (enforcement in ('ENFORCE', 'OBSERVE')),
  set_by text,
  set_reason text,
  updated_at timestamptz not null default now()
);
insert into public.boo_entry_gate_control (singleton, enforcement, set_by, set_reason)
values (true, 'ENFORCE', 'migration:20260916_boo', 'Fail-closed by default: an unvalidated policy is SKIP, not ALLOW.')
on conflict (singleton) do nothing;

-- Validation approvals. A row here is the ONLY thing that can satisfy the
-- gate's validation_approved condition, and it must match the running policy
-- identity exactly -- a boolean or a hand-typed edge cannot stand in for it.
create table if not exists public.boo_strategy_approvals (
  id uuid primary key default gen_random_uuid(),
  policy_code_hash text not null,
  parameter_hash text not null,
  dataset_hash text not null,
  cost_model_version text not null,
  execution_model_version text not null,
  result_file_hash text not null,
  -- A real evaluated result, not a claimed edge. The gate requires this to be
  -- strictly positive, and refuses when expected_edge_source is MANUAL.
  net_expectancy_lower_bound numeric not null,
  expected_edge_source text not null check (expected_edge_source in ('EVALUATED', 'MANUAL', 'OPERATOR')),
  evaluation_start timestamptz not null,
  evaluation_end timestamptz not null,
  independent_periods integer not null default 0,
  trade_count integer not null default 0,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  valid_until timestamptz not null,
  revoked boolean not null default false,
  revoked_reason text,
  evidence jsonb not null default '{}'::jsonb
);
create index if not exists boo_strategy_approvals_identity_idx
  on public.boo_strategy_approvals (policy_code_hash, parameter_hash, dataset_hash, revoked);

-- Every gate evaluation, both checkpoints, admitted or refused.
create table if not exists public.boo_entry_gate_decisions (
  id bigserial primary key,
  adapter_version text not null,
  gate_version text not null,
  signal_id uuid,
  symbol text,
  phase text not null check (phase in ('ADMISSION', 'PRE_DISPATCH')),
  enforcement text not null,
  allowed boolean not null,
  blocked_by text,
  conditions jsonb not null default '{}'::jsonb,
  sizing jsonb,
  risk_policy_errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists boo_entry_gate_decisions_recent_idx
  on public.boo_entry_gate_decisions (created_at desc);

-- Central risk reservation with lease fencing. The unique constraint on
-- intent_id is what makes a reservation idempotent, and the conditional UPDATE
-- the executor issues is what makes two concurrent workers unable to both
-- spend the last of the budget.
create table if not exists public.boo_risk_reservations (
  intent_id text primary key,
  symbol text not null,
  amount_quote numeric not null check (amount_quote > 0),
  fencing_token bigint not null,
  state text not null default 'RESERVED'
    check (state in ('RESERVED', 'FILLED', 'RELEASED', 'UNKNOWN')),
  client_order_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text,
  evidence jsonb not null default '{}'::jsonb
);
create index if not exists boo_risk_reservations_open_idx
  on public.boo_risk_reservations (state) where state in ('RESERVED', 'UNKNOWN');

-- Ledger exceptions: positions whose fills cannot be reconciled from the DB.
-- These are carried EXPLICITLY rather than absorbed into a tolerance.
create table if not exists public.boo_ledger_exceptions (
  id bigserial primary key,
  position_id uuid,
  symbol text not null,
  window_from timestamptz not null,
  window_to timestamptz not null,
  finding_code text not null,
  residual_quote numeric,
  bought_quantity numeric,
  sold_quantity numeric,
  fill_count integer not null default 0,
  detail text,
  -- Set only when the missing fills have actually been re-collected from
  -- userTrades. An aggregate receipt does not resolve an exception.
  resolved_at timestamptz,
  resolved_by text,
  resolution_evidence jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists boo_ledger_exceptions_unique_idx
  on public.boo_ledger_exceptions (position_id, finding_code);

-- Atomic reservation, verified against the live database on 2026-09-16:
--   budget 100, two workers requesting 80 -> exactly one RESERVED, the other
--   INSUFFICIENT_RISK_BUDGET; the winner's retry returns ALREADY_RESERVED
--   without a second charge; a stale fencing token is FENCED_OUT; an unproven
--   outcome moves the row to UNKNOWN and KEEPS the budget held.
-- Doing this compare-and-set in application code is the bug it prevents:
-- read-then-write from two invocations interleaves and both see the same
-- "available" figure.
create or replace function public.boo_reserve_risk(
  p_intent_id text, p_symbol text, p_amount numeric,
  p_fencing_token bigint, p_total_budget numeric, p_client_order_id text default null
) returns jsonb language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  v_existing public.boo_risk_reservations%rowtype;
  v_outstanding numeric;
  v_max_token bigint;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'AMOUNT_NOT_POSITIVE');
  end if;
  select * into v_existing from public.boo_risk_reservations
   where intent_id = p_intent_id for update;
  if found then
    return jsonb_build_object('ok', true, 'reason', 'ALREADY_RESERVED',
      'amount', v_existing.amount_quote, 'state', v_existing.state);
  end if;
  select max(fencing_token) into v_max_token from public.boo_risk_reservations
   where state in ('RESERVED', 'UNKNOWN');
  if v_max_token is not null and p_fencing_token < v_max_token then
    return jsonb_build_object('ok', false, 'reason', 'FENCED_OUT',
      'held', v_max_token, 'presented', p_fencing_token);
  end if;
  -- UNKNOWN counts: an order whose outcome we cannot prove still holds budget.
  select coalesce(sum(amount_quote), 0) into v_outstanding
    from public.boo_risk_reservations where state in ('RESERVED', 'UNKNOWN');
  if v_outstanding + p_amount > p_total_budget then
    return jsonb_build_object('ok', false, 'reason', 'INSUFFICIENT_RISK_BUDGET',
      'outstanding', v_outstanding, 'requested', p_amount, 'budget', p_total_budget);
  end if;
  insert into public.boo_risk_reservations
    (intent_id, symbol, amount_quote, fencing_token, state, client_order_id)
  values (p_intent_id, p_symbol, p_amount, p_fencing_token, 'RESERVED', p_client_order_id);
  return jsonb_build_object('ok', true, 'reason', 'RESERVED',
    'amount', p_amount, 'outstanding', v_outstanding + p_amount);
end;
$$;

create or replace function public.boo_release_risk(
  p_intent_id text, p_fencing_token bigint, p_resolution text, p_proven boolean
) returns jsonb language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare v_existing public.boo_risk_reservations%rowtype;
begin
  select * into v_existing from public.boo_risk_reservations
   where intent_id = p_intent_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NOT_RESERVED'); end if;
  if p_fencing_token < v_existing.fencing_token then
    return jsonb_build_object('ok', false, 'reason', 'FENCED_OUT');
  end if;
  if not p_proven then
    update public.boo_risk_reservations
       set state = 'UNKNOWN', resolution = p_resolution where intent_id = p_intent_id;
    return jsonb_build_object('ok', false, 'reason', 'OUTCOME_UNPROVEN', 'state', 'UNKNOWN');
  end if;
  update public.boo_risk_reservations
     set state = 'RELEASED', resolved_at = now(), resolution = p_resolution
   where intent_id = p_intent_id;
  return jsonb_build_object('ok', true, 'reason', 'RELEASED');
end;
$$;

revoke all on function public.boo_reserve_risk(text, text, numeric, bigint, numeric, text)
  from public, anon, authenticated;
revoke all on function public.boo_release_risk(text, bigint, text, boolean)
  from public, anon, authenticated;

-- ---- SHADOW ---------------------------------------------------------------
-- A strategy shadow, not an account observer: it carries candidate ranking,
-- per-symbol setup state, entry/exit decisions and simulated outcomes.

create table if not exists public.boo_shadow_runs (
  id bigserial primary key,
  release text not null,
  strategy_version text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'FAILED')),
  -- Proof that this process has no order capability (section 10).
  order_capability text not null default 'NONE_DECLARED',
  universe_size integer,
  ranked_count integer,
  candidates_excluded integer,
  setups_advanced integer,
  entries_simulated integer,
  exits_simulated integer,
  data_source text,
  error text,
  evidence jsonb not null default '{}'::jsonb
);
create index if not exists boo_shadow_runs_recent_idx on public.boo_shadow_runs (started_at desc);

-- Persisted per-symbol setup state. Survives restarts, which is what stops a
-- consumed setup from being re-entered after a redeploy.
create table if not exists public.boo_shadow_setups (
  setup_id text primary key,
  symbol text not null,
  state text not null,
  leg_low numeric,
  setup_low numeric,
  trigger_price numeric,
  atr_5m numeric,
  pullback_started_at timestamptz,
  armed_at timestamptz,
  consumed_at timestamptz,
  consumed_reason text,
  -- Newest 5m bar already consumed by the state machine. Without it a
  -- one-minute poll would re-apply the same closed bar and let one bar
  -- drive several transitions.
  last_bar_close_time bigint,
  -- Entry against a setup is allowed at most once, ever.
  entered_at timestamptz,
  strategy_version text not null,
  updated_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb
);
create index if not exists boo_shadow_setups_symbol_idx on public.boo_shadow_setups (symbol, state);

create table if not exists public.boo_shadow_decisions (
  id bigserial primary key,
  run_id bigint references public.boo_shadow_runs (id) on delete set null,
  setup_id text,
  symbol text not null,
  kind text not null check (kind in ('RANK', 'SETUP', 'ENTRY', 'HOLD', 'EXIT', 'REFUSED')),
  decision text not null,
  reason text,
  -- The event clock section 7 requires, so replay and shadow can be compared.
  exchange_event_time timestamptz,
  received_at timestamptz,
  feature_available_at timestamptz,
  decision_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb
);
create index if not exists boo_shadow_decisions_recent_idx on public.boo_shadow_decisions (decision_at desc);
create index if not exists boo_shadow_decisions_setup_idx on public.boo_shadow_decisions (setup_id);

-- Simulated positions, filled at prices that were only available AFTER the
-- signal, and closed by the same exit rules the live path would apply.
create table if not exists public.boo_shadow_positions (
  id bigserial primary key,
  setup_id text not null unique,
  symbol text not null,
  strategy_version text not null,
  entry_at timestamptz not null,
  entry_vwap numeric not null,
  quantity numeric not null,
  initial_stop numeric not null,
  initial_r numeric not null,
  current_stop numeric not null,
  trigger_price numeric not null,
  peak_executable_net numeric,
  state text not null default 'OPEN' check (state in ('OPEN', 'CLOSED')),
  exit_at timestamptz,
  exit_vwap numeric,
  strategy_exit_reason text,
  execution_exit_route text,
  gross_pnl numeric,
  fees numeric,
  funding numeric,
  net_pnl numeric,
  r_multiple numeric,
  evidence jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists boo_shadow_positions_state_idx on public.boo_shadow_positions (state, entry_at desc);

-- Row level security: these tables are written by the service role only.
alter table public.boo_entry_gate_control enable row level security;
alter table public.boo_strategy_approvals enable row level security;
alter table public.boo_entry_gate_decisions enable row level security;
alter table public.boo_risk_reservations enable row level security;
alter table public.boo_ledger_exceptions enable row level security;
alter table public.boo_shadow_runs enable row level security;
alter table public.boo_shadow_setups enable row level security;
alter table public.boo_shadow_decisions enable row level security;
alter table public.boo_shadow_positions enable row level security;

-- ==========================================================================
-- PART B -- additive columns on LIVE tables (operator applies at cutover)
-- ==========================================================================
-- Every column is nullable with no default change to existing rows, so
-- applying it cannot alter any current behaviour: until the executor is
-- redeployed nothing reads them, and the gate treats them as absent (refuse).

-- Loss state that must survive a restart (section 6, regression test 11).
alter table public.v11_long_regime_runtime
  add column if not exists boo_realized_today numeric,
  add column if not exists boo_realized_this_week numeric,
  add column if not exists boo_high_water_equity numeric,
  add column if not exists boo_consecutive_losses integer,
  add column if not exists boo_loss_basis_day date,
  add column if not exists boo_loss_basis_week date,
  add column if not exists boo_limit_reason text,
  add column if not exists boo_limit_resume_condition text;

-- Measured edge evidence. The gate refuses while boo_edge_source is ASSUMED,
-- which is deliberately the state these columns start in.
alter table public.trading_settings
  add column if not exists boo_measured_net_edge_bps numeric,
  add column if not exists boo_required_edge_bps numeric,
  add column if not exists boo_edge_source text;

-- ==========================================================================
-- ROLLBACK
-- ==========================================================================
-- PART B (safe: nothing outside the BOO build reads these columns)
--   alter table public.v11_long_regime_runtime
--     drop column if exists boo_realized_today,
--     drop column if exists boo_realized_this_week,
--     drop column if exists boo_high_water_equity,
--     drop column if exists boo_consecutive_losses,
--     drop column if exists boo_loss_basis_day,
--     drop column if exists boo_loss_basis_week,
--     drop column if exists boo_limit_reason,
--     drop column if exists boo_limit_resume_condition;
--   alter table public.trading_settings
--     drop column if exists boo_measured_net_edge_bps,
--     drop column if exists boo_required_edge_bps,
--     drop column if exists boo_edge_source;
--
-- PART A (drops SHADOW history and the gate's audit trail -- export first)
--   drop table if exists public.boo_shadow_positions;
--   drop table if exists public.boo_shadow_decisions;
--   drop table if exists public.boo_shadow_setups;
--   drop table if exists public.boo_shadow_runs;
--   drop table if exists public.boo_ledger_exceptions;
--   drop function if exists public.boo_reserve_risk(text, text, numeric, bigint, numeric, text);
--   drop function if exists public.boo_release_risk(text, bigint, text, boolean);
--   drop table if exists public.boo_risk_reservations;
--   drop table if exists public.boo_entry_gate_decisions;
--   drop table if exists public.boo_strategy_approvals;
--   drop table if exists public.boo_entry_gate_control;
--
-- NOTE: rolling back PART A while the BOO executor build is deployed makes
-- loadBooGateContext fail its read, which the gate treats as a refusal. That
-- halts new entries; it does not stop exits, protection or settlement.
