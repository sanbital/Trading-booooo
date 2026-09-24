-- V30 live front policy (operator decision 2026-09-24): CEC0040 accepts the explicit
-- V30_SCORE entry branch (a V30 admission without a B06133 branch). Its P142 exit style
-- is retestAnchor, the same as R62. Only the branch whitelist and the style mapping
-- change; EWMA, reject-run, probe cadence, enforcement and target semantics are identical.
-- register_target now also refuses an unmapped branch instead of inserting a NULL style.
CREATE OR REPLACE FUNCTION public.v11_cec0040_decide(p_signal_id uuid, p_decision_at timestamp with time zone, p_symbol text, p_branch text, p_bootstrap boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
     or p_branch not in ('R62','BUYER_SHARE_RESCUE','BOTH','V30_SCORE') then
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
$function$;

CREATE OR REPLACE FUNCTION public.v11_cec0040_register_target(p_position_id uuid, p_signal_id uuid, p_symbol text, p_branch text, p_entry_at timestamp with time zone, p_actual_entry_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    when 'BUYER_SHARE_RESCUE' then 'rangeFloor' when 'BOTH' then 'pivotFloor'
    when 'V30_SCORE' then 'retestAnchor' end;
  if v_style is null then
    raise exception 'CEC0040_TARGET_REGISTRATION_INVALID';
  end if;
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
$function$;
