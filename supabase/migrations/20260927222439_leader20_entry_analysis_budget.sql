-- Reallocate the existing daily allowance; no cap increase, history reset or activation.
-- Uncertain API charges keep their full USD 0.25 reservation until usage is known.
begin;
set local lock_timeout='1s';
create function public.leader20_entry_budget_limits() returns jsonb
language sql stable security definer set search_path='' as $$
 with exposure as (
  select count(*)::integer n from public.v11_long_regime_positions
  where state='OPEN' or remaining_quantity>0.0000000001 or metadata->>'exitAccountingPending'='true'
 ), capacity as (
  select c.daily_cap_usd,c.max_calls_per_day,e.n,
   least(c.daily_cap_usd,case when e.n=0 then 0.50 else greatest(c.daily_cap_usd*0.5,0.25*(e.n+1)) end) protected
  from public.gpt_final_review_control c cross join exposure e where c.singleton
 ) select jsonb_build_object('exposure_count',n,'protected_usd',protected,
   'entry_cap_usd',greatest(0,daily_cap_usd-protected),
   'entry_max_calls',case when daily_cap_usd>0 then floor(max_calls_per_day*greatest(0,daily_cap_usd-protected)/daily_cap_usd)::integer else 0 end)
 from capacity;
$$;
revoke all on function public.leader20_entry_budget_limits() from public,anon,authenticated;
grant execute on function public.leader20_entry_budget_limits() to service_role;
CREATE OR REPLACE FUNCTION public.gpt_final_review_claim(p_job_key text,p_record jsonb,p_cap_usd numeric,p_max_calls integer,p_reserve_usd numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='500ms' SET statement_timeout='2500ms' AS $$
DECLARE j public.gpt_final_entry_reviews; b public.gpt_final_review_daily_budget; d date := (now() AT TIME ZONE 'UTC')::date;
 ctl public.gpt_final_review_control; priority_review boolean; month_used numeric; spend_offset numeric; call_offset integer;
 entry_limits jsonb;
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
 entry_limits:=public.leader20_entry_budget_limits();
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
 IF (NOT coalesce(priority_review,false) AND (b.calls-call_offset>=(entry_limits->>'entry_max_calls')::integer OR b.reserved_usd-spend_offset+p_reserve_usd>(entry_limits->>'entry_cap_usd')::numeric))
 OR month_used+p_reserve_usd>ctl.monthly_cap_usd
 OR b.calls>=p_max_calls OR b.reserved_usd+p_reserve_usd>p_cap_usd THEN
  RAISE EXCEPTION 'API_BUDGET_EXHAUSTED';
 END IF;
 UPDATE public.gpt_final_review_daily_budget SET calls=calls+1,reserved_usd=reserved_usd+p_reserve_usd,cap_usd=p_cap_usd,max_calls=p_max_calls WHERE utc_day=d;
 RETURN jsonb_build_object('created',true,'row',to_jsonb(j));
END $$;
REVOKE ALL ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) TO service_role;


create or replace function public.leader20_schedule() returns jsonb language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype; w public.leader20_campaigns%rowtype; c jsonb; point jsonb;
 sample jsonb; elapsed numeric; request_reason text; requests integer:=0; at_time timestamptz:=clock_timestamp(); held boolean; entry_limits jsonb; monthly_room boolean;
begin
 if not pg_try_advisory_xact_lock(20260927,30) then return jsonb_build_object('requests',0,'reason','SCHEDULER_BUSY'); end if;
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled or ctl.epoch_id is null then return jsonb_build_object('requests',0); end if;
 if ctl.last_scheduler_at>at_time-interval '60 seconds' then return jsonb_build_object('requests',0,'reason','OBSERVATION_THROTTLED'); end if;
 update public.leader20_control set last_scheduler_at=at_time where singleton;
 entry_limits:=public.leader20_entry_budget_limits();
 select public.ai_monthly_spend_used()+0.25<=monthly_cap_usd into monthly_room from public.gpt_final_review_control where singleton;
 update public.leader20_review_events e set state=case when s.status in ('ORDERED','FILLED','CLOSED') then 'ORDERED' else 'DEFERRED' end,
   result=coalesce(e.result,'{}'::jsonb)||jsonb_build_object('signal_status',s.status,'reason',s.reject_reason)
 from public.v11_long_regime_signals s where e.signal_id=s.id and e.state='REVIEWING' and
   (s.status in ('REJECTED','ORDERED','FILLED','CLOSED') or e.expires_at<=at_time);
 for w in select * from public.leader20_campaigns where state<>'RETIRED' order by last_requested_at nulls first,symbol for update skip locked loop
 begin
  held:=exists(select 1 from public.v11_long_regime_positions p where p.symbol=w.symbol and (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'));
  if not held and not exists(select 1 from public.leader20_members m where m.epoch_id=ctl.epoch_id and m.symbol=w.symbol and m.rank<=ctl.watch_limit) then
   update public.leader20_campaigns set state='OUTSIDE_WATCH',reason='CAPACITY_TOP10',updated_at=at_time where symbol=w.symbol; continue;
  end if;
  c:=public.doa_context_for_role_v1(w.symbol,at_time,'TRADE_CANDIDATE',null);
  if c->>'status'<>'AVAILABLE' or coalesce((c->>'buckets')::integer,0)<>24 or
    (c->>'end_ms')::numeric<=extract(epoch from at_time)*1000-10000 then
   update public.leader20_campaigns set state=case when held then 'MANAGE_ONLY' when last_requested_at is null then 'WARMING_UP' else 'DATA_UNAVAILABLE' end,
     reason=coalesce(c->>'reason','DATA_UNAVAILABLE'),bucket_count=coalesce((c->>'buckets')::integer,0),updated_at=at_time where symbol=w.symbol;
   continue;
  end if;
  point:=c->'trajectory'->23;
  sample:=jsonb_build_object('mid',(point->>'mid')::numeric,'imbalance',(point->>'imbalance')::numeric,
    'flow',(select sum((x->>'aggressive_buy')::numeric-(x->>'aggressive_sell')::numeric)
     from jsonb_array_elements(c->'trajectory') with ordinality as a(x,n) where n>21));
  update public.leader20_campaigns set last_bucket_at=to_timestamp((c->>'end_ms')::numeric/1000),bucket_count=24,
    state=case when held then case when epoch_id=ctl.epoch_id then 'OPEN' else 'MANAGE_ONLY' end else 'WATCHING' end,
    reason=null,updated_at=at_time where symbol=w.symbol;
  if held then continue; end if;
  if not exists(select 1 from public.leader20_members m where m.epoch_id=ctl.epoch_id and m.symbol=w.symbol and m.rank<=ctl.watch_limit) then continue; end if; -- The existing protected position manager has priority.
  if ctl.active_strategy<>'LEADER20_DYNAMIC_1' then continue; end if;
  if w.epoch_id<>ctl.epoch_id or not exists(select 1 from public.leader20_epochs where id=ctl.epoch_id and next_refresh_at>at_time) then
   update public.leader20_campaigns set state='DEFERRED',reason='DEFER_UNIVERSE_STALE' where symbol=w.symbol; continue;
  end if;
  select max(closed_at) into w.last_settled_at from public.v11_long_regime_positions where symbol=w.symbol and state='CLOSED';
  if w.last_settled_at is not null and (c->>'start_ms')::numeric<=extract(epoch from w.last_settled_at)*1000 then
   update public.leader20_campaigns set reason='POST_SETTLEMENT_EVIDENCE_PENDING',last_settled_at=w.last_settled_at where symbol=w.symbol; continue;
  end if;
  if exists(select 1 from public.leader20_review_events where symbol=w.symbol and state in ('REQUESTED','REVIEWING')) then continue; end if;
  elapsed:=extract(epoch from at_time-w.last_requested_at);
  request_reason:=case when w.last_requested_at is null then 'INITIAL_COMPLETE_CAPTURE'
    when elapsed>=21600 then 'FAIR_REEVALUATION'
    when elapsed>=1800 and (w.state='DATA_UNAVAILABLE' or
      abs((sample->>'mid')::numeric/nullif((w.last_request_sample->>'mid')::numeric,0)-1)>=0.0005 or
      sign((sample->>'flow')::numeric)<>sign((w.last_request_sample->>'flow')::numeric) or
      abs((sample->>'imbalance')::numeric-(w.last_request_sample->>'imbalance')::numeric)>=0.15) then 'EVIDENCE_CHANGED' end;
  if request_reason is null then continue; end if;
  -- Global paid-review pacing, independent of symbol churn; no stale queued snapshots.
  if exists(select 1 from public.leader20_review_events where requested_at>at_time-interval '30 minutes') then continue; end if;
  if not coalesce(monthly_room,false) or exists(select 1 from public.gpt_final_review_daily_budget b cross join public.gpt_final_review_control g where g.singleton and b.utc_day=(at_time at time zone 'UTC')::date
    and (b.reserved_usd-case when b.utc_day=g.budget_effective_day then g.daily_spend_offset else 0 end+0.25>(entry_limits->>'entry_cap_usd')::numeric
     or b.calls-case when b.utc_day=g.budget_effective_day then g.daily_call_offset else 0 end>=(entry_limits->>'entry_max_calls')::integer)) then update public.leader20_campaigns set reason='DEFER_API_BUDGET' where symbol=w.symbol; continue; end if;
  insert into public.leader20_review_events(epoch_id,symbol,generation,requested_at,snapshot_end_ms,snapshot_hash,reason,priority)
   values(ctl.epoch_id,w.symbol,ctl.generation,at_time,(c->>'end_ms')::bigint,md5((c->'trajectory')::text),request_reason,case when request_reason='EVIDENCE_CHANGED' then 2 else 3 end)
   on conflict do nothing;
  if found then
   requests:=requests+1;
   update public.leader20_campaigns set last_requested_at=at_time,last_request_sample=sample,reason=request_reason where symbol=w.symbol;
  end if;
 exception when others then
  update public.leader20_campaigns set state='DATA_UNAVAILABLE',reason='CAPTURE_PARSE_OR_SCHEDULE_ERROR:'||SQLSTATE||':'||left(SQLERRM,160),updated_at=at_time where symbol=w.symbol;
 end;
 end loop;
 return jsonb_build_object('requests',requests,'authority','REVIEW_REQUEST_ONLY');
end $$;

revoke all on function public.leader20_schedule() from public,anon,authenticated;
grant execute on function public.leader20_schedule() to service_role;
update public.gpt_final_review_control set
 set_reason='User approved USD50/month: AI45 plus incremental storage allowance5; daily1.25 unchanged; exposure-aware entry reserve; unknown API costs remain reserved',
 updated_at=now() where singleton;
commit;
