-- V10-LANES-EXIT-R1
-- Adds durable state for distinct BULL/RANGE/BEAR exits.  This migration does
-- not enable live trading.  Fixed time values become maximum-hold risk
-- backstops; they are no longer sufficient exit decisions by themselves.

begin;

alter table public.v10_lane_flags
  drop constraint if exists v10_lane_flags_lane_check;
alter table public.v10_lane_flags
  add constraint v10_lane_flags_lane_check
  check (lane in ('BULL','RANGE','BEAR'));

insert into public.v10_lane_flags(
  lane,shadow_enabled,live_enabled,max_concurrent,notional_usdt,updated_at,
  engine_revision,spec_sha256,max_aggregate_notional_usdt,leverage,validated
) values (
  'BULL',false,false,2,40,now(),'V10-LANES-3.0.0',
  '9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
  240,3,false
)
on conflict(lane) do update set
  shadow_enabled=false,
  live_enabled=false,
  updated_at=now();

alter table public.v10_lane_positions
  add column if not exists original_quantity numeric,
  add column if not exists remaining_quantity numeric,
  add column if not exists t1_completed boolean not null default false,
  add column if not exists peak_price numeric,
  add column if not exists exit_policy_key text,
  add column if not exists exit_policy_revision text,
  add column if not exists exit_policy_spec_sha256 text,
  add column if not exists exit_state jsonb not null default '{}'::jsonb,
  add column if not exists last_exit_evaluated_bar_at timestamptz,
  add column if not exists last_exit_decision_at timestamptz,
  add column if not exists exit_reason text,
  add column if not exists exit_trigger_price numeric,
  add column if not exists risk_backstop_at timestamptz;

update public.v10_lane_positions
set original_quantity=coalesce(original_quantity,quantity),
    remaining_quantity=coalesce(remaining_quantity,quantity),
    peak_price=coalesce(peak_price,entry_price),
    risk_backstop_at=coalesce(risk_backstop_at,expected_exit_at)
where original_quantity is null
   or remaining_quantity is null
   or peak_price is null
   or risk_backstop_at is null;

alter table public.v10_lane_positions
  drop constraint if exists v10_lane_positions_original_quantity_ck,
  drop constraint if exists v10_lane_positions_remaining_quantity_ck,
  drop constraint if exists v10_lane_positions_peak_price_ck;
alter table public.v10_lane_positions
  add constraint v10_lane_positions_original_quantity_ck
    check (original_quantity is null or original_quantity > 0),
  add constraint v10_lane_positions_remaining_quantity_ck
    check (remaining_quantity is null or remaining_quantity >= 0),
  add constraint v10_lane_positions_peak_price_ck
    check (peak_price is null or peak_price > 0);

comment on column public.v10_lane_positions.expected_exit_at is
  'Legacy compatibility field. V10-LANES-EXIT-R1 must not close solely because this timestamp elapsed.';
comment on column public.v10_lane_positions.risk_backstop_at is
  'Maximum-hold emergency backstop after lane stop, target, residual protection and invalidation logic.';
comment on column public.v10_lane_positions.exit_state is
  'Deterministic V10 exit state: remaining quantity, T1 latch, peak, invalidation count and pending next-open action.';

create table if not exists public.v10_lane_exit_decisions (
  id bigint generated always as identity primary key,
  position_id uuid not null references public.v10_lane_positions(id) on delete cascade,
  signal_id uuid not null references public.v10_lane_signals(id) on delete cascade,
  lane text not null check (lane in ('BULL','RANGE','BEAR')),
  fingerprint text not null,
  exit_policy_key text not null,
  exit_policy_revision text not null,
  exit_policy_spec_sha256 text not null,
  completed_bar_at timestamptz not null,
  action text not null check (action in (
    'HOLD','PARTIAL_AT_TRIGGER','FULL_AT_TRIGGER','PARTIAL_NEXT_OPEN',
    'FULL_NEXT_OPEN','RISK_CIRCUIT'
  )),
  fraction numeric not null check (fraction >= 0 and fraction <= 1),
  trigger_price numeric,
  reason text not null,
  state_before jsonb not null,
  state_after jsonb not null,
  is_shadow boolean not null default true,
  order_intent_id uuid references public.v10_lane_order_intents(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  unique(position_id,completed_bar_at,exit_policy_spec_sha256)
);

create index if not exists v10_lane_exit_decisions_position_time_idx
  on public.v10_lane_exit_decisions(position_id,completed_bar_at desc);
create index if not exists v10_lane_exit_decisions_action_time_idx
  on public.v10_lane_exit_decisions(action,created_at desc);

alter table public.v10_lane_exit_decisions enable row level security;
revoke all on table public.v10_lane_exit_decisions from public,anon,authenticated;
grant select,insert,update on table public.v10_lane_exit_decisions to service_role;
grant usage,select on sequence public.v10_lane_exit_decisions_id_seq to service_role;

create table if not exists public.v10_lane_exit_runtime (
  singleton boolean primary key default true check(singleton),
  shadow_enabled boolean not null default false,
  live_enabled boolean not null default false,
  engine_revision text not null default 'V10-LANES-EXIT-R1.0.0',
  spec_sha256 text,
  last_completed_bar_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0 check(consecutive_failures >= 0),
  updated_at timestamptz not null default now()
);
insert into public.v10_lane_exit_runtime(singleton,shadow_enabled,live_enabled)
values(true,false,false)
on conflict(singleton) do update set
  shadow_enabled=false,
  live_enabled=false,
  updated_at=now();
alter table public.v10_lane_exit_runtime enable row level security;
revoke all on table public.v10_lane_exit_runtime from public,anon,authenticated;
grant select,update on table public.v10_lane_exit_runtime to service_role;

create or replace function public.reject_v10_lane_exit_decision_mutation()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if old.order_intent_id is null and new.order_intent_id is not null
     and new.id=old.id
     and new.position_id=old.position_id
     and new.signal_id=old.signal_id
     and new.completed_bar_at=old.completed_bar_at
     and new.exit_policy_spec_sha256=old.exit_policy_spec_sha256 then
    return new;
  end if;
  raise exception 'V10_LANE_EXIT_DECISION_IMMUTABLE' using errcode='55000';
end;
$$;

drop trigger if exists v10_lane_exit_decisions_immutable on public.v10_lane_exit_decisions;
create trigger v10_lane_exit_decisions_immutable
before update or delete on public.v10_lane_exit_decisions
for each row execute function public.reject_v10_lane_exit_decision_mutation();

revoke all on function public.reject_v10_lane_exit_decision_mutation() from public,anon,authenticated;

insert into public.v10_lane_deployment_audit(
  stage,engine_revision,spec_sha256,passed,details
) values (
  'REGIME_SPECIFIC_EXIT_SCHEMA_INSTALLED',
  'V10-LANES-EXIT-R1.0.0',
  'PENDING_GENERATED_SELECTION',
  true,
  jsonb_build_object(
    'live_enabled',false,
    'shadow_enabled',false,
    'time_exit_semantics','MAX_HOLD_RISK_BACKSTOP_ONLY',
    'lanes',jsonb_build_array('BULL','RANGE','BEAR')
  )
);

commit;
