begin;

do $block$
declare
  runtime_row public.v10_lane_executor_runtime%rowtype;
  range_flag public.v10_lane_flags%rowtype;
  claim_definition text;
begin
  select * into runtime_row
  from public.v10_lane_executor_runtime
  where singleton
  for update;
  if runtime_row.engine_revision<>'V10-LANE-EXECUTOR-1.0.0'
     or runtime_row.signal_revision<>'V10-LANES-3.0.0'
     or runtime_row.signal_spec_sha256<>'9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f' then
    raise exception 'V10_RANGE_EXECUTOR_IDENTITY_MISMATCH' using errcode='55000';
  end if;

  select * into range_flag
  from public.v10_lane_flags
  where lane='RANGE'
  for update;
  if range_flag.validated is not true
     or range_flag.engine_revision<>'V10-LANES-3.0.0'
     or range_flag.spec_sha256<>'9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f' then
    raise exception 'V10_RANGE_VALIDATION_IDENTITY_MISMATCH' using errcode='55000';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.claim_v10_lane_signal_v3()'::regprocedure
  ) into claim_definition;
  if pg_catalog.strpos(claim_definition,'v10_lane_claims_pkey')=0 then
    raise exception 'V10_RANGE_CLAIM_FIX_MISSING' using errcode='55000';
  end if;
end;
$block$;

update public.v10_lane_flags
set
  validated=true,
  shadow_enabled=false,
  live_enabled=true,
  max_concurrent=1,
  notional_usdt=40,
  max_aggregate_notional_usdt=40,
  leverage=3,
  engine_revision='V10-LANES-3.0.0',
  spec_sha256='9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
  updated_at=clock_timestamp()
where lane='RANGE';

update public.v10_lane_flags
set validated=false,shadow_enabled=false,live_enabled=false,updated_at=clock_timestamp()
where lane in ('BULL','BEAR');

update public.v10_lane_executor_runtime
set live_enabled=true,last_error=null,consecutive_failures=0,updated_at=clock_timestamp()
where singleton;

update public.v10_lane_exit_runtime
set shadow_enabled=false,live_enabled=true,last_error=null,consecutive_failures=0,
    updated_at=clock_timestamp()
where singleton;

update public.v10_lane_execution_circuit
set is_open=false,reason=null,opened_at=null,updated_at=clock_timestamp()
where singleton;

update public.v10_lane_release_state
set
  release_state='RANGE_LIVE_ENABLED',
  ready=true,
  holdout_decision='PASS_RANGE_ONLY_BULL_BEAR_DISABLED',
  validated_lanes='["RANGE"]'::jsonb,
  gates=gates||jsonb_build_object(
    'range_executor_preflight',true,
    'range_claim_fix_verified',true,
    'range_live_enabled',true,
    'bull_live_enabled',false,
    'bear_live_enabled',false,
    'margin_usdt',40,
    'leverage',3,
    'max_concurrent',1
  ),
  promoted_at=clock_timestamp(),
  updated_at=clock_timestamp()
where engine_revision='V10-LANES-3.0.0';

insert into public.v10_lane_deployment_audit(
  stage,engine_revision,spec_sha256,edge_function_slug,passed,details
)
values(
  'RANGE_LIVE_REENABLED_AFTER_CLAIM_FIX','V10-LANES-3.0.0',
  '9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
  'v10-lane-signal-generator + v10-lane-executor',true,
  jsonb_build_object(
    'lane','RANGE','shadow_enabled',false,'live_enabled',true,
    'claim_fix_verified',true,'margin_usdt',40,'leverage',3,'max_concurrent',1,
    'bull_live_enabled',false,'bear_live_enabled',false
  )
);

commit;
