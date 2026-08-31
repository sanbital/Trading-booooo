-- V10 regime-specific exit runtime, shadow-only cutover.
-- Deliberately does not close the V10 circuit, enable live lane flags,
-- change trading_settings.mode, clear pause_new_entries, or submit orders.

create table if not exists public.v10_lane_exit_policy_registry (
  lane text primary key check (lane in ('BULL','RANGE','BEAR')),
  policy_key text not null unique,
  family text not null,
  research_revision text not null,
  engine_revision text not null,
  spec_sha256 text not null,
  parameters jsonb not null,
  research_metrics jsonb not null,
  validated boolean not null default false,
  live_eligible boolean not null default false,
  shadow_only boolean not null default true,
  active boolean not null default true,
  registered_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (not live_eligible or validated),
  check (not live_eligible or not shadow_only)
);

create table if not exists public.v10_lane_exit_shadow_state (
  position_id uuid primary key references public.v10_lane_positions(id) on delete cascade,
  policy_key text not null,
  policy_revision text not null,
  spec_sha256 text not null,
  state jsonb not null,
  last_evaluated_bar_at timestamptz,
  terminal boolean not null default false,
  terminal_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists v10_lane_exit_shadow_state_active_idx
  on public.v10_lane_exit_shadow_state (terminal, last_evaluated_bar_at)
  where not terminal;

alter table public.v10_lane_exit_policy_registry enable row level security;
alter table public.v10_lane_exit_shadow_state enable row level security;
revoke all on public.v10_lane_exit_policy_registry from anon, authenticated;
revoke all on public.v10_lane_exit_shadow_state from anon, authenticated;
grant select, insert, update, delete on public.v10_lane_exit_policy_registry to service_role;
grant select, insert, update, delete on public.v10_lane_exit_shadow_state to service_role;

insert into public.v10_lane_exit_policy_registry (
  lane,policy_key,family,research_revision,engine_revision,spec_sha256,
  parameters,research_metrics,validated,live_eligible,shadow_only,active,updated_at
) values
(
  'BULL','BULL_R7_SP_T22P5_Q0P30_F0_G6P75','PARTIAL_CONTINUATION',
  'V10_REGIME_SPECIFIC_EXITS_R7_20260831','V10-LANES-EXIT-RUNTIME-1.0.0',
  'f6480355e2e0c987afe1af7a8b66dc61d5fd35b1fa165d1ad940f3b5b331741d',
  '{"maxHoldHours":12,"t1Roe":22.5,"t1Fraction":0.30,"residualFloorRoe":0,"trailGivebackRoe":6.75}'::jsonb,
  '{"trades":673,"meanNetBps":86.188,"profitFactor":1.8811,"maxDrawdownBps":-7343.0,"expectancyRetention":0.9312,"drawdownImprovementPct":11.068,"worstYearMeanBps":67.825,"positiveYears":6,"positiveHalfYears":10,"neighbourPassShare":0.75,"finalEligible":true}'::jsonb,
  true,true,false,true,clock_timestamp()
),
(
  'RANGE','RANGE_R7_STATE_T1P00_A18_G0P75','FULL_STATE_TARGET',
  'V10_REGIME_SPECIFIC_EXITS_R7_20260831','V10-LANES-EXIT-RUNTIME-1.0.0',
  'f6480355e2e0c987afe1af7a8b66dc61d5fd35b1fa165d1ad940f3b5b331741d',
  '{"maxHoldHours":6,"targetBbImprovement":1.0,"trailArmRoe":18,"trailGivebackRoe":0.75}'::jsonb,
  '{"trades":984,"meanNetBps":75.892,"profitFactor":1.9335,"maxDrawdownBps":-5220.3,"expectancyRetention":0.8947,"drawdownImprovementPct":4.077,"worstYearMeanBps":13.599,"positiveYears":6,"positiveHalfYears":11,"neighbourPassShare":1.0,"finalEligible":true}'::jsonb,
  true,true,false,true,clock_timestamp()
),
(
  'BEAR','BEAR_R8_STATE_T1P76_R0P0200_B0P40','STATE_RECOVERY',
  'V10_REGIME_SPECIFIC_EXITS_R8_20260831','V10-LANES-EXIT-RUNTIME-1.0.0',
  'f6480355e2e0c987afe1af7a8b66dc61d5fd35b1fa165d1ad940f3b5b331741d',
  '{"maxHoldHours":24,"targetBbImprovement":1.76,"failureAfterHours":4,"failureMaxReturn":-0.02,"failureMaxBbImprovement":0.4}'::jsonb,
  '{"trades":161,"meanNetBps":289.578,"profitFactor":3.1418,"maxDrawdownBps":-3474.8,"expectancyRetention":0.8164,"drawdownImprovementPct":30.226,"worstYearMeanBps":25.121,"positiveYears":6,"positiveHalfYears":10,"neighbourPassShare":0.6667,"finalEligible":false}'::jsonb,
  false,false,true,true,clock_timestamp()
)
on conflict (lane) do update set
  policy_key=excluded.policy_key,
  family=excluded.family,
  research_revision=excluded.research_revision,
  engine_revision=excluded.engine_revision,
  spec_sha256=excluded.spec_sha256,
  parameters=excluded.parameters,
  research_metrics=excluded.research_metrics,
  validated=excluded.validated,
  live_eligible=excluded.live_eligible,
  shadow_only=excluded.shadow_only,
  active=excluded.active,
  updated_at=clock_timestamp();

insert into public.v10_lane_exit_runtime (
  singleton,shadow_enabled,live_enabled,engine_revision,spec_sha256,
  consecutive_failures,updated_at
) values (
  true,true,false,'V10-LANES-EXIT-RUNTIME-1.0.0',
  'f6480355e2e0c987afe1af7a8b66dc61d5fd35b1fa165d1ad940f3b5b331741d',
  0,clock_timestamp()
)
on conflict (singleton) do update set
  shadow_enabled=true,
  live_enabled=false,
  engine_revision=excluded.engine_revision,
  spec_sha256=excluded.spec_sha256,
  last_error=null,
  consecutive_failures=0,
  updated_at=clock_timestamp();

create or replace function public.record_v10_lane_exit_runtime_failure(p_error text)
returns void
language sql
security definer
set search_path=''
as $$
  update public.v10_lane_exit_runtime
  set last_error=left(coalesce(p_error,'UNKNOWN'),2000),
      consecutive_failures=consecutive_failures+1,
      updated_at=clock_timestamp()
  where singleton;
$$;

revoke all on function public.record_v10_lane_exit_runtime_failure(text) from public, anon, authenticated;
grant execute on function public.record_v10_lane_exit_runtime_failure(text) to service_role;

comment on table public.v10_lane_exit_policy_registry is
  'Immutable-identity registry for regime-specific V10 exit policies. BEAR remains shadow-only until a final-eligible candidate exists.';
comment on table public.v10_lane_exit_shadow_state is
  'Shadow state separated from live v10_lane_positions; never drives exchange orders in V10-LANES-EXIT-RUNTIME-1.0.0.';
