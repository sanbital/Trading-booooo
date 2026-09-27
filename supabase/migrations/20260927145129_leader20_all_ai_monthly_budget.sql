-- Optional paid research must not bypass the user-approved monthly AI ceiling.
begin;
set local lock_timeout='1s';
update public.evolution_control set daily_api_cap_usd=0,max_daily_api_calls=0 where singleton;
alter table public.evolution_control add constraint evolution_paid_research_monthly50_disabled check(daily_api_cap_usd=0 and max_daily_api_calls=0);
create function public.ai_monthly_spend_used(p_day date default (now() at time zone 'UTC')::date)
returns numeric language sql stable security definer set search_path='' as $$
 select coalesce((select sum(reserved_usd) from public.gpt_final_review_daily_budget
   where utc_day>=date_trunc('month',p_day)::date and utc_day<(date_trunc('month',p_day)+interval '1 month')::date),0)
 +coalesce((select sum(spent+reserved) from evolution_private.budget
   where day>=date_trunc('month',p_day)::date and day<(date_trunc('month',p_day)+interval '1 month')::date),0);
$$;
revoke all on function public.ai_monthly_spend_used(date) from public,anon,authenticated;
grant execute on function public.ai_monthly_spend_used(date) to service_role;
CREATE OR REPLACE FUNCTION public.gpt_final_review_claim(p_job_key text,p_record jsonb,p_cap_usd numeric,p_max_calls integer,p_reserve_usd numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='500ms' SET statement_timeout='2500ms' AS $$
DECLARE j public.gpt_final_entry_reviews; b public.gpt_final_review_daily_budget; d date := (now() AT TIME ZONE 'UTC')::date;
 ctl public.gpt_final_review_control; priority_review boolean; month_used numeric; spend_offset numeric; call_offset integer;
 v_purpose text := coalesce(p_record->>'purpose','PRODUCTION');
BEGIN
 IF p_cap_usd IS NULL OR p_max_calls IS NULL OR p_reserve_usd IS NULL OR p_cap_usd<=0 OR p_max_calls<=0 OR p_reserve_usd<0.10 OR p_cap_usd::text IN ('NaN','Infinity','-Infinity') OR p_reserve_usd::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'APPROVED_API_BUDGET_REQUIRED';
 END IF;
 IF v_purpose NOT IN ('PRODUCTION','VERIFICATION','DRYRUN') THEN RAISE EXCEPTION 'REVIEW_PURPOSE_INVALID'; END IF;
 SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key;
 IF j.job_key IS NOT NULL THEN RETURN jsonb_build_object('created',false,'row',to_jsonb(j)); END IF;
 perform pg_advisory_xact_lock(20260927,40);
 -- The current approved control, not a caller's stale config, is authoritative.
 SELECT * INTO ctl FROM public.gpt_final_review_control WHERE singleton;
 IF ctl.singleton IS NULL OR ctl.mode='OFF' OR ctl.approval_ref IS NULL OR (ctl.mode='ENFORCE' AND NOT ctl.enforce_approved)
 OR p_record->>'api_approval_ref' IS DISTINCT FROM ctl.approval_ref THEN RAISE EXCEPTION 'APPROVED_API_BUDGET_REQUIRED'; END IF;
 month_used:=public.ai_monthly_spend_used(d);
 spend_offset:=case when d=ctl.budget_effective_day then ctl.daily_spend_offset else 0 end;
 call_offset:=case when d=ctl.budget_effective_day then ctl.daily_call_offset else 0 end;
 p_cap_usd:=ctl.daily_cap_usd+spend_offset; p_max_calls:=ctl.max_calls_per_day+call_offset;
 -- Server-side floor applies to all deployed callers, including older bundles.
 p_reserve_usd:=greatest(p_reserve_usd,0.25);
 priority_review:=v_purpose='PRODUCTION' AND (nullif(p_record#>>'{identity,position_id}','') IS NOT NULL
   OR p_record->>'kind'='FD1_FINAL_RECHECK');
 INSERT INTO public.gpt_final_review_daily_budget(utc_day,cap_usd,max_calls) VALUES(d,p_cap_usd,p_max_calls) ON CONFLICT(utc_day) DO NOTHING;
 SELECT * INTO b FROM public.gpt_final_review_daily_budget WHERE utc_day=d FOR UPDATE;
 -- Re-check under the budget lock: a concurrent claimer of the same job may have won.
 INSERT INTO public.gpt_final_entry_reviews(job_key,state,record,purpose,budget_day,reserved_usd,signal_id,symbol)
 VALUES(p_job_key,'RUNNING',p_record,v_purpose,d,p_reserve_usd,p_record#>>'{identity,signal_id}',p_record#>>'{identity,symbol}')
 ON CONFLICT(job_key) DO NOTHING RETURNING * INTO j;
 IF j.job_key IS NULL THEN
  SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key;
  RETURN jsonb_build_object('created',false,'row',to_jsonb(j));
 END IF;
 IF (NOT coalesce(priority_review,false) AND (b.calls-call_offset>=floor(ctl.max_calls_per_day*0.5) OR b.reserved_usd-spend_offset+p_reserve_usd>ctl.daily_cap_usd*0.5))
 OR month_used+p_reserve_usd>ctl.monthly_cap_usd
 OR b.calls>=p_max_calls OR b.reserved_usd+p_reserve_usd>p_cap_usd THEN
  RAISE EXCEPTION 'API_BUDGET_EXHAUSTED';
 END IF;
 UPDATE public.gpt_final_review_daily_budget SET calls=calls+1,reserved_usd=reserved_usd+p_reserve_usd,cap_usd=p_cap_usd,max_calls=p_max_calls WHERE utc_day=d;
 RETURN jsonb_build_object('created',true,'row',to_jsonb(j));
END $$;
REVOKE ALL ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) TO service_role;


-- Keep local research, ingestion, policy monitoring and previously stored evidence.
-- New paid research is disabled; existing trading protection is unchanged.
do $$ declare j bigint; begin
 select jobid into j from cron.job where jobname='self-evolution-research-minute';
 if j is not null then perform cron.alter_job(j,schedule:='*/5 * * * *'); end if;
end $$;
commit;
