-- The 0.3% low-evidence ledger was introduced as an experimentation budget, but every
-- current LOB entry is low-evidence while the live cohort is young. Enforcing the ledger
-- therefore became a hidden daily trading stop, independent of the operator-approved
-- scalp_daily_loss_pct=30 safety rail. Keep the ledger and claims for observability while
-- making admission non-blocking. The existing daily loss circuit remains authoritative.

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
  v_exceeded boolean;
  v_row public.lob_exploration_budget_daily%rowtype;
begin
  select * into v_position
    from public.trading_positions
   where id=p_position_id
   for update;
  if not found then
    return jsonb_build_object(
      'allowed',false,'reason','POSITION_NOT_FOUND','enforcement','TELEMETRY_ONLY'
    );
  end if;
  if lower(v_position.exchange)<>lower(p_exchange) then
    return jsonb_build_object(
      'allowed',false,'reason','EXCHANGE_MISMATCH','enforcement','TELEMETRY_ONLY'
    );
  end if;

  select * into v_existing
    from public.lob_exploration_budget_claims
   where position_id=p_position_id;
  if found then
    return jsonb_build_object(
      'allowed',true,
      'idempotent',true,
      'enforcement','TELEMETRY_ONLY',
      'budget_exceeded',coalesce((v_existing.metadata->>'budget_exceeded')::boolean,false),
      'claimed_loss_quote',v_existing.claimed_loss_quote,
      'day_key',v_existing.day_key,
      'settled_at',v_existing.settled_at
    );
  end if;

  v_day := case
    when lower(p_exchange)='upbit' then (now() at time zone 'Asia/Seoul')::date
    else (now() at time zone 'UTC')::date
  end;
  select scalp_low_evidence_daily_loss_pct
    into v_pct
    from public.trading_settings
   where id=1;
  v_limit := greatest(0,coalesce(p_managed_capital_quote,0))
    * greatest(0,coalesce(v_pct,0.30))/100;
  v_claim := greatest(0,coalesce(p_worst_case_loss_quote,0));

  insert into public.lob_exploration_budget_daily(
    exchange,day_key,managed_capital_quote
  )
  values(
    lower(p_exchange),v_day,greatest(0,coalesce(p_managed_capital_quote,0))
  )
  on conflict(exchange,day_key) do update set
    managed_capital_quote=greatest(
      lob_exploration_budget_daily.managed_capital_quote,
      excluded.managed_capital_quote
    ),
    updated_at=now();

  select * into v_row
    from public.lob_exploration_budget_daily
   where exchange=lower(p_exchange) and day_key=v_day
   for update;
  v_exceeded :=
    v_row.reserved_loss_quote+v_row.realized_loss_quote+v_claim>v_limit;

  insert into public.lob_exploration_budget_claims(
    position_id,exchange,day_key,claimed_loss_quote,metadata
  )
  values(
    p_position_id,
    lower(p_exchange),
    v_day,
    v_claim,
    jsonb_build_object(
      'budget_exceeded',v_exceeded,
      'enforcement','TELEMETRY_ONLY',
      'limit_quote',v_limit,
      'used_quote_before_claim',v_row.reserved_loss_quote+v_row.realized_loss_quote
    )
  );

  update public.lob_exploration_budget_daily
     set reserved_loss_quote=reserved_loss_quote+v_claim,
         entry_count=entry_count+1,
         updated_at=now()
   where exchange=lower(p_exchange) and day_key=v_day
   returning * into v_row;

  return jsonb_build_object(
    'allowed',true,
    'enforcement','TELEMETRY_ONLY',
    'budget_exceeded',v_exceeded,
    'limit_quote',v_limit,
    'claimed_loss_quote',v_claim,
    'day_key',v_day,
    'row',to_jsonb(v_row)
  );
end;
$$;

comment on function public.claim_lob_exploration_budget_v610(uuid,text,numeric,numeric) is
  'Records low-evidence loss exposure as telemetry only. It cannot block entry; the operator-approved daily loss circuit is authoritative.';

revoke all on function public.claim_lob_exploration_budget_v610(uuid,text,numeric,numeric)
  from public,anon,authenticated;
grant execute on function public.claim_lob_exploration_budget_v610(uuid,text,numeric,numeric)
  to service_role;

comment on column public.trading_settings.scalp_low_evidence_daily_loss_pct is
  'Telemetry threshold for low-evidence exposure. Non-blocking; scalp_daily_loss_pct is the authoritative daily stop.';
