-- CEC0040 deployment state. The controller starts disabled, is causally backfilled,
-- and may be enabled immediately after the bootstrap ledger passes its integrity
-- gates. Existing positions are not rewritten by this migration.

create table if not exists public.v11_cec0040_state (
  singleton boolean primary key default true check (singleton),
  policy_version text not null,
  target_version text not null,
  config_hash text not null,
  config jsonb not null,
  ewma_usdt numeric,
  training_count integer not null check (training_count >= 0),
  reject_run integer not null check (reject_run between 0 and 2),
  seeded_through timestamptz not null,
  last_decision_at timestamptz,
  bootstrap_complete boolean not null default false,
  bootstrap_completed_at timestamptz,
  bootstrap_scanned_through timestamptz,
  enforcement_enabled boolean not null default false,
  enforcement_changed_at timestamptz,
  enforcement_reason text,
  seed_evidence jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  check ((training_count < 10) or ewma_usdt is not null),
  check (ewma_usdt is null or ewma_usdt <> 'NaN'::numeric)
);

create table if not exists public.v11_cec0040_decisions (
  signal_id uuid primary key references public.v11_long_regime_signals(id) on delete restrict,
  policy_version text not null,
  decision_at timestamptz not null,
  symbol text not null,
  branch text not null check (branch in ('R62','BUYER_SHARE_RESCUE','BOTH')),
  model_action text not null check (model_action in ('ADMIT','PROBE','REJECT')),
  effective_allowed boolean not null,
  enforcement_enabled boolean not null,
  prediction_usdt numeric,
  training_count integer not null check (training_count >= 0),
  reject_run_before integer not null check (reject_run_before between 0 and 2),
  reject_run_after integer not null check (reject_run_after between 0 and 2),
  evidence jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  check (prediction_usdt is null or prediction_usdt <> 'NaN'::numeric)
);

create table if not exists public.v11_cec0040_targets (
  position_id uuid primary key references public.v11_long_regime_positions(id) on delete restrict,
  signal_id uuid not null unique references public.v11_long_regime_signals(id) on delete restrict,
  policy_version text not null,
  target_version text not null,
  symbol text not null,
  branch text not null check (branch in ('R62','BUYER_SHARE_RESCUE','BOTH')),
  style text not null check (style in ('retestAnchor','rangeFloor','pivotFloor')),
  entry_at timestamptz not null,
  actual_entry_price numeric not null check (actual_entry_price > 0),
  status text not null default 'PENDING' check (status in ('PENDING','RESOLVED','APPLIED','ERROR')),
  observed_through timestamptz,
  target_exit_at timestamptz,
  target_net_usdt numeric,
  replay jsonb,
  resolved_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (target_net_usdt is null or target_net_usdt <> 'NaN'::numeric),
  check ((status in ('RESOLVED','APPLIED')) = (target_exit_at is not null and target_net_usdt is not null)),
  check (applied_at is null or status = 'APPLIED')
);

create index if not exists v11_cec0040_decisions_time_idx
  on public.v11_cec0040_decisions(decision_at, signal_id);
create index if not exists v11_cec0040_targets_pending_idx
  on public.v11_cec0040_targets(entry_at, position_id)
  where status = 'PENDING';
create index if not exists v11_cec0040_targets_fold_idx
  on public.v11_cec0040_targets(target_exit_at, entry_at desc)
  where status = 'RESOLVED';

alter table public.v11_cec0040_state enable row level security;
alter table public.v11_cec0040_decisions enable row level security;
alter table public.v11_cec0040_targets enable row level security;
revoke all on public.v11_cec0040_state from anon, authenticated;
revoke all on public.v11_cec0040_decisions from anon, authenticated;
revoke all on public.v11_cec0040_targets from anon, authenticated;
grant select, insert, update, delete on public.v11_cec0040_state to service_role;
grant select, insert, update, delete on public.v11_cec0040_decisions to service_role;
grant select, insert, update, delete on public.v11_cec0040_targets to service_role;

insert into public.v11_cec0040_state (
  singleton,policy_version,target_version,config_hash,config,ewma_usdt,
  training_count,reject_run,seeded_through,enforcement_enabled,seed_evidence
) values (
  true,'CEC0040_CAUSAL_EDGE_CONTROLLER_1','CEC0040_P142_MEAN44_1',
  '3b0ebe775334e24a020887532cec7b57d014a7a7383a06e217d0949b3113630f',
  '{"scope":"global","alpha":0.05,"trainingTarget":"P142_MEAN44","winsorUsdt":20,"minTrainingTrades":10,"admissionThresholdUsdt":0,"probeEveryRejectedSignals":3,"targetNotionalUsdt":600}'::jsonb,
  0.9945815883759598,116,0,'2026-09-20T07:03:54.503Z',false,
  jsonb_build_object(
    'kind','FROZEN_30D_CAUSAL_REPLAY',
    'rows',275,
    'maturedTargets',116,
    'pendingTargets',0,
    'leakageViolations',0,
    'causalControllerSha256','5b599b885e618025d293b139bc70a979f80b24e93dd504d525564615cdd4345e',
    'targetLibrarySha256','106895671fcda6ff4ab7cf1160d027e50a2619b15c8294f3b6992a2da2c68115',
    'sharedDataSha256','8a54fe62446d66ea6323ff53a52153ab1329cf07bc37cfc25faf5b317c7e39c9',
    'extendedValidationSha256','fb91d7ee9547be1d99600d307296b4fb5435e006f157399d40629a105f5162e9'
  )
) on conflict (singleton) do nothing;

create or replace function public.v11_cec0040_decide(
  p_signal_id uuid,
  p_decision_at timestamptz,
  p_symbol text,
  p_branch text,
  p_bootstrap boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  s public.v11_cec0040_state%rowtype;
  d public.v11_cec0040_decisions%rowtype;
  t public.v11_cec0040_targets%rowtype;
  v_prediction numeric;
  v_action text;
  v_allowed boolean;
  v_before integer;
  v_after integer;
  v_y numeric;
  v_cutoff timestamptz;
begin
  if p_signal_id is null or p_decision_at is null or p_symbol !~ '^[A-Z0-9]{2,60}USDT$'
     or p_branch not in ('R62','BUYER_SHARE_RESCUE','BOTH') then
    raise exception 'CEC0040_DECISION_INPUT_INVALID';
  end if;

  select * into s from public.v11_cec0040_state where singleton for update;
  if not found or s.policy_version <> 'CEC0040_CAUSAL_EDGE_CONTROLLER_1'
     or s.target_version <> 'CEC0040_P142_MEAN44_1'
     or s.config_hash <> '3b0ebe775334e24a020887532cec7b57d014a7a7383a06e217d0949b3113630f' then
    raise exception 'CEC0040_STATE_IDENTITY_INVALID';
  end if;
  if not s.bootstrap_complete and not coalesce(p_bootstrap,false) then
    return jsonb_build_object('ready',false,'reason','CEC0040_BOOTSTRAP_REQUIRED',
      'policyVersion',s.policy_version,'enforcementEnabled',s.enforcement_enabled);
  end if;

  select * into d from public.v11_cec0040_decisions where signal_id = p_signal_id;
  if found then
    if d.decision_at <> p_decision_at or d.symbol <> p_symbol or d.branch <> p_branch then
      raise exception 'CEC0040_DECISION_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('ready',true,'idempotent',true,'policyVersion',d.policy_version,
      'action',d.model_action,'modelAllowed',d.model_action in ('ADMIT','PROBE'),
      'effectiveAllowed',case when s.enforcement_enabled then d.model_action in ('ADMIT','PROBE') else true end,
      'enforcementEnabled',s.enforcement_enabled,
      'predictionUsdt',d.prediction_usdt,'trainingCount',d.training_count,
      'rejectRunBefore',d.reject_run_before,'rejectRunAfter',d.reject_run_after);
  end if;

  if p_decision_at <= s.seeded_through or (s.last_decision_at is not null and p_decision_at < s.last_decision_at) then
    raise exception 'CEC0040_DECISION_TIME_REGRESSION';
  end if;

  v_cutoff := p_decision_at - interval '1 millisecond';
  if exists (
    select 1
    from public.v11_cec0040_decisions d0
    join public.v11_long_regime_positions p0 on p0.signal_id=d0.signal_id
    left join public.v11_cec0040_targets t0 on t0.position_id=p0.id
    where d0.model_action in ('ADMIT','PROBE') and t0.position_id is null
  ) then
    return jsonb_build_object('ready',false,'reason','CEC0040_TARGET_REGISTRATION_LAG',
      'policyVersion',s.policy_version,'enforcementEnabled',s.enforcement_enabled);
  end if;
  if exists (
    select 1 from public.v11_cec0040_targets x
    where x.status = 'PENDING' and x.entry_at < p_decision_at
      and (x.observed_through is null or x.observed_through < v_cutoff)
  ) then
    return jsonb_build_object('ready',false,'reason','CEC0040_TARGET_OBSERVATION_LAG',
      'policyVersion',s.policy_version,'enforcementEnabled',s.enforcement_enabled);
  end if;
  if exists (select 1 from public.v11_cec0040_targets x where x.status='ERROR') then
    return jsonb_build_object('ready',false,'reason','CEC0040_TARGET_ERROR',
      'policyVersion',s.policy_version,'enforcementEnabled',s.enforcement_enabled);
  end if;

  -- The frozen simulator scans its pending array backwards at each decision.  Preserve
  -- that exact order by folding newly mature targets in reverse admission order.
  for t in
    select * from public.v11_cec0040_targets x
    where x.status = 'RESOLVED' and x.target_exit_at <= p_decision_at
    order by x.entry_at desc, x.position_id desc
    for update
  loop
    v_y := greatest(-20::numeric,least(20::numeric,t.target_net_usdt));
    if s.training_count = 0 then s.ewma_usdt := v_y;
    else s.ewma_usdt := 0.05::numeric*v_y + 0.95::numeric*s.ewma_usdt;
    end if;
    s.training_count := s.training_count + 1;
    update public.v11_cec0040_targets set status='APPLIED',applied_at=clock_timestamp(),updated_at=clock_timestamp()
      where position_id=t.position_id;
  end loop;

  v_before := s.reject_run;
  v_prediction := case when s.training_count < 10 then null else s.ewma_usdt end;
  if v_prediction is null or v_prediction >= 0 then
    v_action := 'ADMIT'; v_after := 0;
  elsif s.reject_run + 1 >= 3 then
    v_action := 'PROBE'; v_after := 0;
  else
    v_action := 'REJECT'; v_after := s.reject_run + 1;
  end if;
  v_allowed := case when s.enforcement_enabled then v_action in ('ADMIT','PROBE') else true end;

  insert into public.v11_cec0040_decisions(
    signal_id,policy_version,decision_at,symbol,branch,model_action,effective_allowed,
    enforcement_enabled,prediction_usdt,training_count,reject_run_before,reject_run_after,evidence
  ) values (
    p_signal_id,s.policy_version,p_decision_at,p_symbol,p_branch,v_action,v_allowed,
    s.enforcement_enabled,v_prediction,s.training_count,v_before,v_after,
    jsonb_build_object('targetVersion',s.target_version,'configHash',s.config_hash,
      'seededThrough',s.seeded_through,'evaluatedAt',clock_timestamp())
  );
  update public.v11_cec0040_state set ewma_usdt=s.ewma_usdt,training_count=s.training_count,
    reject_run=v_after,last_decision_at=p_decision_at,updated_at=clock_timestamp()
    where singleton;
  return jsonb_build_object('ready',true,'idempotent',false,'policyVersion',s.policy_version,
    'action',v_action,'modelAllowed',v_action in ('ADMIT','PROBE'),'effectiveAllowed',v_allowed,
    'enforcementEnabled',s.enforcement_enabled,'predictionUsdt',v_prediction,
    'trainingCount',s.training_count,'rejectRunBefore',v_before,'rejectRunAfter',v_after);
end;
$$;

create or replace function public.v11_cec0040_complete_bootstrap(
  p_expected_seeded_through timestamptz,
  p_scanned_through timestamptz,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare s public.v11_cec0040_state%rowtype;
begin
  if p_expected_seeded_through is null or p_scanned_through is null
     or p_scanned_through<p_expected_seeded_through
     or p_scanned_through>clock_timestamp()+interval '1 minute'
     or length(trim(coalesce(p_reason,'')))<12 then
    raise exception 'CEC0040_BOOTSTRAP_COMPLETION_INPUT_INVALID';
  end if;
  select * into s from public.v11_cec0040_state where singleton for update;
  if not found or s.seeded_through<>p_expected_seeded_through
     or s.policy_version<>'CEC0040_CAUSAL_EDGE_CONTROLLER_1'
     or s.target_version<>'CEC0040_P142_MEAN44_1'
     or s.config_hash<>'3b0ebe775334e24a020887532cec7b57d014a7a7383a06e217d0949b3113630f'
     or s.enforcement_enabled then
    raise exception 'CEC0040_BOOTSTRAP_COMPLETION_STATE_INVALID';
  end if;
  if s.bootstrap_complete then
    return jsonb_build_object('bootstrapComplete',true,'idempotent',true,
      'bootstrapCompletedAt',s.bootstrap_completed_at,'scannedThrough',s.bootstrap_scanned_through,
      'trainingCount',s.training_count,'lastDecisionAt',s.last_decision_at);
  end if;
  if exists (
    select 1 from public.v11_cec0040_decisions d
    join public.v11_long_regime_positions p on p.signal_id=d.signal_id
    left join public.v11_cec0040_targets t on t.position_id=p.id
    where d.model_action in ('ADMIT','PROBE') and t.position_id is null
  ) or exists (select 1 from public.v11_cec0040_targets where status='ERROR') then
    raise exception 'CEC0040_BOOTSTRAP_LEDGER_INVALID';
  end if;
  update public.v11_cec0040_state set bootstrap_complete=true,
    bootstrap_completed_at=clock_timestamp(),bootstrap_scanned_through=p_scanned_through,
    updated_at=clock_timestamp()
    where singleton returning * into s;
  return jsonb_build_object('bootstrapComplete',s.bootstrap_complete,
    'bootstrapCompletedAt',s.bootstrap_completed_at,'scannedThrough',p_scanned_through,
    'trainingCount',s.training_count,'lastDecisionAt',s.last_decision_at);
end;
$$;

create or replace function public.v11_cec0040_set_enforcement(
  p_enabled boolean,
  p_expected_config_hash text,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare s public.v11_cec0040_state%rowtype;
begin
  if p_enabled is null or p_expected_config_hash is null or length(trim(coalesce(p_reason,''))) < 12 then
    raise exception 'CEC0040_ENFORCEMENT_INPUT_INVALID';
  end if;
  select * into s from public.v11_cec0040_state where singleton for update;
  if not found or s.config_hash<>p_expected_config_hash
     or s.policy_version<>'CEC0040_CAUSAL_EDGE_CONTROLLER_1'
     or s.target_version<>'CEC0040_P142_MEAN44_1' then
    raise exception 'CEC0040_ENFORCEMENT_IDENTITY_INVALID';
  end if;
  if p_enabled then
    if not s.bootstrap_complete then raise exception 'CEC0040_BOOTSTRAP_REQUIRED'; end if;
    if exists (select 1 from public.v11_cec0040_targets where status='ERROR') then
      raise exception 'CEC0040_TARGET_ERROR';
    end if;
    if exists (
      select 1 from public.v11_cec0040_decisions d
      join public.v11_long_regime_positions p on p.signal_id=d.signal_id
      left join public.v11_cec0040_targets t on t.position_id=p.id
      where d.model_action in ('ADMIT','PROBE') and t.position_id is null
    ) then raise exception 'CEC0040_TARGET_REGISTRATION_LAG'; end if;
    if exists (
      select 1 from public.v11_cec0040_targets t
      where t.status='PENDING' and
        (t.observed_through is null or t.observed_through<date_trunc('minute',clock_timestamp())-interval '1 millisecond')
    ) then raise exception 'CEC0040_TARGET_OBSERVATION_LAG'; end if;
  end if;
  update public.v11_cec0040_state set enforcement_enabled=p_enabled,
    enforcement_changed_at=clock_timestamp(),enforcement_reason=trim(p_reason),updated_at=clock_timestamp()
    where singleton returning * into s;
  return jsonb_build_object('policyVersion',s.policy_version,'targetVersion',s.target_version,
    'configHash',s.config_hash,'enforcementEnabled',s.enforcement_enabled,
    'enforcementChangedAt',s.enforcement_changed_at,'reason',s.enforcement_reason,
    'trainingCount',s.training_count,'ewmaUsdt',s.ewma_usdt,'rejectRun',s.reject_run,
    'lastDecisionAt',s.last_decision_at);
end;
$$;

create or replace function public.v11_cec0040_missing_targets()
returns table(position_id uuid, signal_id uuid, symbol text, branch text,
  entry_at timestamptz, actual_entry_price numeric)
language sql
security invoker
set search_path = ''
as $$
  select p.id,d.signal_id,d.symbol,d.branch,p.entry_at,p.entry_price
  from public.v11_cec0040_decisions d
  join public.v11_long_regime_positions p on p.signal_id=d.signal_id
  left join public.v11_cec0040_targets t on t.position_id=p.id
  where d.model_action in ('ADMIT','PROBE') and t.position_id is null
  order by p.entry_at,p.id
  limit 4
$$;

create or replace function public.v11_cec0040_register_target(
  p_position_id uuid,
  p_signal_id uuid,
  p_symbol text,
  p_branch text,
  p_entry_at timestamptz,
  p_actual_entry_price numeric
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  d public.v11_cec0040_decisions%rowtype;
  v_style text;
  x public.v11_cec0040_targets%rowtype;
begin
  select * into d from public.v11_cec0040_decisions where signal_id=p_signal_id;
  if not found or d.model_action not in ('ADMIT','PROBE') or d.symbol<>p_symbol or d.branch<>p_branch
     or p_position_id is null or p_entry_at<d.decision_at or p_actual_entry_price<=0 then
    raise exception 'CEC0040_TARGET_REGISTRATION_INVALID';
  end if;
  v_style := case p_branch when 'R62' then 'retestAnchor'
    when 'BUYER_SHARE_RESCUE' then 'rangeFloor' when 'BOTH' then 'pivotFloor' end;
  insert into public.v11_cec0040_targets(position_id,signal_id,policy_version,target_version,
    symbol,branch,style,entry_at,actual_entry_price)
  values(p_position_id,p_signal_id,'CEC0040_CAUSAL_EDGE_CONTROLLER_1','CEC0040_P142_MEAN44_1',
    p_symbol,p_branch,v_style,p_entry_at,p_actual_entry_price)
  on conflict(position_id) do nothing;
  select * into x from public.v11_cec0040_targets where position_id=p_position_id;
  if x.signal_id<>p_signal_id or x.symbol<>p_symbol or x.branch<>p_branch or x.entry_at<>p_entry_at
     or x.actual_entry_price<>p_actual_entry_price then
    raise exception 'CEC0040_TARGET_IDEMPOTENCY_CONFLICT';
  end if;
  return jsonb_build_object('registered',true,'positionId',x.position_id,'status',x.status,
    'style',x.style,'targetVersion',x.target_version);
end;
$$;

create or replace function public.v11_cec0040_observe_target(
  p_position_id uuid,
  p_status text,
  p_observed_through timestamptz,
  p_target_exit_at timestamptz default null,
  p_target_net_usdt numeric default null,
  p_replay jsonb default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare x public.v11_cec0040_targets%rowtype;
begin
  if p_status not in ('PENDING','RESOLVED','ERROR') or p_observed_through is null then
    raise exception 'CEC0040_TARGET_OBSERVATION_INVALID';
  end if;
  select * into x from public.v11_cec0040_targets where position_id=p_position_id for update;
  if not found then raise exception 'CEC0040_TARGET_NOT_FOUND'; end if;
  if x.status='APPLIED' then return jsonb_build_object('status','APPLIED','idempotent',true); end if;
  if x.status='RESOLVED' then
    if p_status='RESOLVED' and x.target_exit_at=p_target_exit_at and x.target_net_usdt=p_target_net_usdt then
      return jsonb_build_object('status','RESOLVED','idempotent',true);
    end if;
    raise exception 'CEC0040_TARGET_RESOLUTION_CONFLICT';
  end if;
  if p_status='RESOLVED' and (p_target_exit_at is null or p_target_net_usdt is null
      or p_target_net_usdt='NaN'::numeric or p_target_exit_at>x.entry_at+interval '6 hours 2 minutes'
      or p_target_exit_at>p_observed_through) then
    raise exception 'CEC0040_TARGET_RESULT_INVALID';
  end if;
  update public.v11_cec0040_targets set status=p_status,
    observed_through=greatest(coalesce(observed_through,p_observed_through),p_observed_through),
    target_exit_at=case when p_status='RESOLVED' then p_target_exit_at else target_exit_at end,
    target_net_usdt=case when p_status='RESOLVED' then p_target_net_usdt else target_net_usdt end,
    replay=coalesce(p_replay,replay),resolved_at=case when p_status='RESOLVED' then clock_timestamp() else resolved_at end,
    updated_at=clock_timestamp() where position_id=p_position_id returning * into x;
  return jsonb_build_object('status',x.status,'idempotent',false,'observedThrough',x.observed_through,
    'targetExitAt',x.target_exit_at,'targetNetUsdt',x.target_net_usdt);
end;
$$;

revoke execute on function public.v11_cec0040_decide(uuid,timestamptz,text,text,boolean) from public, anon, authenticated;
revoke execute on function public.v11_cec0040_register_target(uuid,uuid,text,text,timestamptz,numeric) from public, anon, authenticated;
revoke execute on function public.v11_cec0040_observe_target(uuid,text,timestamptz,timestamptz,numeric,jsonb) from public, anon, authenticated;
revoke execute on function public.v11_cec0040_missing_targets() from public, anon, authenticated;
revoke execute on function public.v11_cec0040_set_enforcement(boolean,text,text) from public, anon, authenticated;
revoke execute on function public.v11_cec0040_complete_bootstrap(timestamptz,timestamptz,text) from public, anon, authenticated;
grant execute on function public.v11_cec0040_decide(uuid,timestamptz,text,text,boolean) to service_role;
grant execute on function public.v11_cec0040_register_target(uuid,uuid,text,text,timestamptz,numeric) to service_role;
grant execute on function public.v11_cec0040_observe_target(uuid,text,timestamptz,timestamptz,numeric,jsonb) to service_role;
grant execute on function public.v11_cec0040_missing_targets() to service_role;
grant execute on function public.v11_cec0040_set_enforcement(boolean,text,text) to service_role;
grant execute on function public.v11_cec0040_complete_bootstrap(timestamptz,timestamptz,text) to service_role;

comment on table public.v11_cec0040_state is 'Singleton CEC0040 causal EWMA state; shadow by default.';
comment on table public.v11_cec0040_targets is 'P142 three-path 44bp counterfactual target ledger for admitted CEC0040 fills.';
