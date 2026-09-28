-- Protect open-position reviews before low-priority analysis. Total provider limits are unchanged.
CREATE OR REPLACE FUNCTION public.ai_call_reserve(p_key text, p_provider text, p_model text, p_purpose text, p_parent text, p_version text, p_reserve numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare l public.ai_provider_limits%rowtype; j public.ai_call_ledger%rowtype; legacy_day numeric;ds_day numeric;cap jsonb;
 used numeric; month_used numeric; protected_month numeric; protected_day numeric; low_priority boolean; entry_used numeric; protected numeric; entry_cap numeric; day_start timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
 perform pg_advisory_xact_lock(20260927,40);
 perform pg_advisory_xact_lock(20260928,51);
 select * into j from public.ai_call_ledger where call_key=p_key;
 if found then
  if j.provider<>p_provider or j.model<>p_model or j.purpose<>p_purpose or j.data_version<>p_version or j.parent_key is distinct from p_parent then
   raise exception 'API_CALL_IDENTITY_CONFLICT'; end if;
  return jsonb_build_object('created',false,'row',to_jsonb(j));
 end if;
 select * into l from public.ai_provider_limits where provider=p_provider for update;
 if not found or not l.enabled then return jsonb_build_object('created',false,'reason','PROVIDER_LEDGER_DISABLED'); end if;
 if p_purpose in ('ENTRY','RECHECK') and (select enabled from public.leader20_batch_control where singleton) then
  perform pg_advisory_xact_lock(20260928,52);
  cap:=public.leader20_batch_capacity();
  if (cap->>'available')::integer<1 then return jsonb_build_object('created',false,'reason','API_NO_ENTRY_CAPACITY','capacity',cap); end if;
 end if;
 if p_reserve is null or p_reserve<=0 or p_reserve>=10 or p_reserve::text in ('NaN','Infinity','-Infinity') then raise exception 'API_RESERVE_INVALID'; end if;
 if (p_provider='deepseek' and p_model<>'deepseek-flash') or (p_provider='openai' and p_model<>'gpt-5.4-mini-2026-03-17') then raise exception 'API_MODEL_NOT_PRICED'; end if;
 select coalesce(sum(case when state='CANCELLED' then 0 else coalesce(actual_usd,reserved_usd) end),0),
 coalesce(sum(case when purpose in ('ENTRY','RECHECK','VERIFICATION') and state<>'CANCELLED' then coalesce(actual_usd,reserved_usd) else 0 end),0)
 into used,entry_used from public.ai_call_ledger where provider=p_provider and created_at>=day_start;
 select greatest(0,b.reserved_usd-case when b.utc_day=g.budget_effective_day then g.daily_spend_offset else 0 end)
 into legacy_day from public.gpt_final_review_daily_budget b cross join public.gpt_final_review_control g
 where g.singleton and b.utc_day=(now() at time zone 'UTC')::date;
 ds_day:=public.ai_legacy_deepseek_used((now() at time zone 'UTC')::date,true);
 -- Unknown legacy daily allocation is conservatively retained, including protection.
 legacy_day:=case when p_provider='deepseek' then ds_day else greatest(0,coalesce(legacy_day,0)-ds_day) end;
 used:=used+legacy_day;entry_used:=entry_used+legacy_day;
 -- Fixed monetary reserve calibrated from the latest provider ledger, within unchanged $100 totals.
 low_priority:=p_purpose not in ('HOLD','EXIT','ENTRY_FAILURE');
 protected_month:=case when p_provider='openai' then 20 else 5 end;
 protected_day:=case when p_provider='openai' then 1 else .25 end;
 month_used:=public.ai_provider_month_used(p_provider);
 protected:=least(l.daily_usd,greatest(protected_day,coalesce((public.leader20_entry_budget_limits()->>'protected_usd')::numeric,.5)));
 if low_priority and (month_used+p_reserve>greatest(0,l.monthly_usd-protected_month) or used+p_reserve>greatest(0,l.daily_usd-protected)) then
  return jsonb_build_object('created',false,'reason','API_PROTECTED_POSITION_RESERVE','provider',p_provider,'purpose',p_purpose,
   'protected_month_usd',protected_month,'protected_day_usd',protected,'month_used_usd',month_used);
 end if;
 entry_cap:=greatest(0,l.daily_usd-protected);
 if public.ai_provider_month_used(p_provider)+p_reserve>l.monthly_usd or used+p_reserve>l.daily_usd or
  (p_purpose in ('ENTRY','RECHECK','VERIFICATION') and entry_used+p_reserve>entry_cap) then
  return jsonb_build_object('created',false,'reason','API_BUDGET_EXHAUSTED','provider',p_provider,
   'purpose',p_purpose,'additional_usd',greatest(used+p_reserve-l.daily_usd,
     public.ai_provider_month_used(p_provider)+p_reserve-l.monthly_usd,
     case when p_purpose in ('ENTRY','RECHECK','VERIFICATION') then entry_used+p_reserve-entry_cap else 0 end));
 end if;
 insert into public.ai_call_ledger(call_key,provider,model,purpose,parent_key,data_version,state,reserved_usd)
 values(p_key,p_provider,p_model,p_purpose,p_parent,p_version,'RESERVED',p_reserve) returning * into j;
 return jsonb_build_object('created',true,'row',to_jsonb(j));
end $function$
;
