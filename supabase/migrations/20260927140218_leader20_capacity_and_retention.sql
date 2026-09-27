-- User authorized monthly USD 50 including AI and incremental storage; existing hosting excluded, 2026-09-27.
-- This does not activate Leader20, reset consumed budget, or change trading risk controls.
begin;
set local lock_timeout='1s';
alter table public.leader20_control add column last_scheduler_at timestamptz;
alter table public.leader20_control add column watch_limit integer not null default 10 check(watch_limit between 1 and 20);
alter table public.gpt_final_review_control
 add column budget_effective_day date not null default (now() at time zone 'UTC')::date,
 add column daily_spend_offset numeric not null default 0 check(daily_spend_offset>=0 and daily_spend_offset::text not in ('NaN','Infinity','-Infinity')),
 add column daily_call_offset integer not null default 0 check(daily_call_offset>=0);
update public.gpt_final_review_control c set daily_spend_offset=b.reserved_usd,daily_call_offset=b.calls
 from public.gpt_final_review_daily_budget b where c.singleton and b.utc_day=c.budget_effective_day;
alter table public.gpt_final_review_control add column monthly_cap_usd numeric not null default 40 check(monthly_cap_usd between 0 and 40 and monthly_cap_usd::text not in ('NaN','Infinity','-Infinity'));
alter table public.gpt_final_review_control drop constraint gpt_final_review_control_daily_cap_usd_check;
alter table public.gpt_final_review_control add constraint gpt_final_review_control_daily_cap_usd_check
 check(daily_cap_usd between 0 and 1.25 and daily_cap_usd::text not in ('NaN','Infinity','-Infinity'));
alter table public.gpt_final_review_control drop constraint gpt_final_review_control_max_calls_per_day_check;
alter table public.gpt_final_review_control add constraint gpt_final_review_control_max_calls_per_day_check check(max_calls_per_day between 0 and 100);
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
 select coalesce(sum(reserved_usd),0) into month_used from public.gpt_final_review_daily_budget where utc_day>=date_trunc('month',d)::date and utc_day<(date_trunc('month',d)+interval '1 month')::date;
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

CREATE OR REPLACE FUNCTION public.gpt_final_review_complete(p_job_key text,p_owner uuid,p_record jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='500ms' SET statement_timeout='2500ms' AS $$
DECLARE j public.gpt_final_entry_reviews; r jsonb := p_record->'result'; u jsonb := p_record#>'{result,usage}';
 v_attempted boolean := coalesce((p_record#>>'{result,attempted}')::boolean,false);
 v_cost numeric := CASE WHEN jsonb_typeof(p_record#>'{result,api_cost_usd}')='number' THEN (p_record#>>'{result,api_cost_usd}')::numeric END;
 v_settled numeric;
BEGIN
 perform pg_advisory_xact_lock(20260927,40);
 IF jsonb_typeof(p_record)<>'object' OR jsonb_typeof(r)<>'object' THEN RAISE EXCEPTION 'REVIEW_RESULT_INVALID'; END IF;
 SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key FOR UPDATE;
 IF j.job_key IS NULL OR j.owner IS DISTINCT FROM p_owner OR j.state<>'RUNNING' THEN RAISE EXCEPTION 'REVIEW_RESULT_CAS'; END IF;
 v_settled := CASE WHEN NOT v_attempted THEN 0 WHEN v_cost IS NOT NULL AND v_cost>=0 AND v_cost::text NOT IN ('NaN','Infinity','-Infinity') THEN v_cost END;
 UPDATE public.gpt_final_entry_reviews SET state='DONE',record=p_record,completed_at=clock_timestamp(),
  settled_usd=v_settled,model=p_record#>>'{result,model_requested}',prompt_hash=p_record->>'prompt_hash',schema_hash=p_record->>'schema_hash',
  source_commit=p_record->>'source_commit',candidate_id=p_record#>>'{packet,candidate_id}',snapshot_hash=p_record#>>'{packet,snapshot_hash}',
  decision=r->>'decision',valid=coalesce((r->>'valid')::boolean,false),error=left(r->>'error',200),attempted=v_attempted,
  request_id=left(r->>'request_id',200),
  input_tokens=CASE WHEN jsonb_typeof(u->'input_tokens')='number' THEN (u->>'input_tokens')::integer END,
  cached_input_tokens=CASE WHEN jsonb_typeof(u#>'{input_tokens_details,cached_tokens}')='number' THEN (u#>>'{input_tokens_details,cached_tokens}')::integer END,
  output_tokens=CASE WHEN jsonb_typeof(u->'output_tokens')='number' THEN (u->>'output_tokens')::integer END,
  api_cost_usd=v_cost,cost_basis=left(r->>'cost_basis',80),
  latency_ms=CASE WHEN jsonb_typeof(r->'latency_ms')='number' THEN (r->>'latency_ms')::integer END,
  api_started_at=CASE WHEN jsonb_typeof(r->'started_at_ms')='number' THEN to_timestamp((r->>'started_at_ms')::double precision/1000) END,
  api_completed_at=CASE WHEN jsonb_typeof(r->'completed_at_ms')='number' THEN to_timestamp((r->>'completed_at_ms')::double precision/1000) END,
  snapshot_at=CASE WHEN jsonb_typeof(p_record->'snapshot_at_ms')='number' THEN to_timestamp((p_record->>'snapshot_at_ms')::double precision/1000) END
 WHERE job_key=p_job_key;
 IF v_settled IS NOT NULL AND j.budget_day IS NOT NULL AND j.reserved_usd IS NOT NULL THEN
  UPDATE public.gpt_final_review_daily_budget SET reserved_usd=greatest(0,reserved_usd-(j.reserved_usd-v_settled)),settled_usd=settled_usd+v_settled
  WHERE utc_day=j.budget_day;
 END IF;
 RETURN jsonb_build_object('done',true,'settled_usd',v_settled);
END $$;
REVOKE ALL ON FUNCTION public.gpt_final_review_complete(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gpt_final_review_complete(text,uuid,jsonb) TO service_role;

create or replace function public.leader20_schedule() returns jsonb language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype; w public.leader20_campaigns%rowtype; c jsonb; point jsonb;
 sample jsonb; elapsed numeric; request_reason text; requests integer:=0; at_time timestamptz:=clock_timestamp(); held boolean;
begin
 if not pg_try_advisory_xact_lock(20260927,30) then return jsonb_build_object('requests',0,'reason','SCHEDULER_BUSY'); end if;
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled or ctl.epoch_id is null then return jsonb_build_object('requests',0); end if;
 if ctl.last_scheduler_at>at_time-interval '60 seconds' then return jsonb_build_object('requests',0,'reason','OBSERVATION_THROTTLED'); end if;
 update public.leader20_control set last_scheduler_at=at_time where singleton;
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
  if exists(select 1 from public.gpt_final_review_daily_budget b cross join public.gpt_final_review_control g where g.singleton and b.utc_day=(at_time at time zone 'UTC')::date
    and (b.reserved_usd-case when b.utc_day=g.budget_effective_day then g.daily_spend_offset else 0 end+0.25>g.daily_cap_usd*0.5
     or b.calls-case when b.utc_day=g.budget_effective_day then g.daily_call_offset else 0 end>=g.max_calls_per_day*0.5)) then update public.leader20_campaigns set reason='DEFER_API_BUDGET' where symbol=w.symbol; continue; end if;
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

alter table public.leader20_control
 add column cold_archive_max_bytes bigint not null default 0 check(cold_archive_max_bytes between 0 and 8589934592),
 add column cold_archive_state text not null default 'PENDING',
 add column archive_last_verified_at timestamptz;
create table public.leader20_archive_objects (
 id uuid primary key default gen_random_uuid(),
 state text not null check(state in ('PENDING','VERIFIED','DELETING','DELETED')),
 object_path text not null unique,
 owner uuid not null, lease_until timestamptz not null,
 row_count integer not null default 0 check(row_count between 0 and 1000),
 min_at timestamptz, max_at timestamptz,
 raw_sha256 text, object_sha256 text,
 bytes bigint not null default 8388608 check(bytes between 1 and 8388608),
 created_at timestamptz not null default clock_timestamp(), verified_at timestamptz, deleted_at timestamptz,
 check(state='PENDING' or (raw_sha256 ~ '^[a-f0-9]{64}$' and object_sha256 ~ '^[a-f0-9]{64}$' and row_count>0))
);
alter table public.leader20_archive_objects enable row level security;
revoke all on public.leader20_archive_objects from public,anon,authenticated,service_role;
grant select on public.leader20_archive_objects to service_role;
alter table public.leader20_micro_archive add column archive_object_id uuid references public.leader20_archive_objects(id);
create index leader20_archive_unexported on public.leader20_micro_archive(at,symbol) where archive_object_id is null;
create index leader20_archive_object_rows on public.leader20_micro_archive(archive_object_id,at,symbol);
create index leader20_archive_object_expiry on public.leader20_archive_objects(state,max_at);

-- Only the authenticated existing capture Edge Function can call this RPC.
-- A lease/CAS protects retry, immutable object verification, and retention transitions.
create function public.leader20_archive_maintenance(p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='500ms' set statement_timeout='10s' as $$
declare o public.leader20_archive_objects%rowtype; ctl public.leader20_control%rowtype;
 v_owner uuid:=(p_body->>'owner')::uuid; v_id uuid; v_count integer; v_rows jsonb; v_now timestamptz:=clock_timestamp();
begin
 if not pg_try_advisory_xact_lock(20260927,140218) then return jsonb_build_object('state','BUSY'); end if;
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled or ctl.archive_max_bytes<=0 then return jsonb_build_object('state','DISABLED'); end if;
 if p_action='claim' then
  if v_owner is null then raise exception 'ARCHIVE_OWNER_REQUIRED'; end if;
  -- Retries finish a previously verified expired object's deletion first.
  select * into o from public.leader20_archive_objects where state='DELETING' or (state='VERIFIED' and max_at<v_now-interval '30 days')
   order by max_at limit 1 for update;
  if o.id is not null then
   if o.state='DELETING' and o.lease_until>v_now then return jsonb_build_object('state','BUSY'); end if;
   update public.leader20_archive_objects set state='DELETING',owner=v_owner,lease_until=v_now+interval '120 seconds' where id=o.id returning * into o;
   return jsonb_build_object('state','DELETE','object',to_jsonb(o));
  end if;
  -- Purge hot rows only when a downloaded object checksum was verified.
  with expired as(select a.symbol,a.at from public.leader20_micro_archive a join public.leader20_archive_objects b on b.id=a.archive_object_id
    where a.at<v_now-interval '72 hours' and b.state in ('VERIFIED','DELETED') order by a.at limit 5000)
  delete from public.leader20_micro_archive a using expired e where a.symbol=e.symbol and a.at=e.at;
  select * into o from public.leader20_archive_objects where state='PENDING' order by created_at limit 1 for update;
  if o.id is not null then
   if o.lease_until>v_now then return jsonb_build_object('state','BUSY'); end if;
   update public.leader20_archive_objects set owner=v_owner,lease_until=v_now+interval '120 seconds' where id=o.id returning * into o;
  else
   if not exists(select 1 from public.leader20_micro_archive where archive_object_id is null and at<v_now-interval '120 seconds') then
    return jsonb_build_object('state','IDLE'); end if;
   if (select coalesce(sum(bytes),0) from public.leader20_archive_objects where state<>'DELETED')+8388608>ctl.cold_archive_max_bytes then
    update public.leader20_control set cold_archive_state='CAP_REACHED',
     active_strategy=case when active_strategy='LEADER20_DYNAMIC_1' then 'PAUSED' else active_strategy end,
     generation=generation+case when active_strategy='LEADER20_DYNAMIC_1' then 1 else 0 end where singleton;
    return jsonb_build_object('state','CAP_REACHED');
   end if;
   v_id:=gen_random_uuid();
   insert into public.leader20_archive_objects(id,state,object_path,owner,lease_until)
    values(v_id,'PENDING','v1/'||v_id::text||'.json.gz',v_owner,v_now+interval '120 seconds') returning * into o;
   with chosen as(select symbol,at from public.leader20_micro_archive where archive_object_id is null and at<v_now-interval '120 seconds'
     order by at,symbol limit 1000 for update skip locked)
   update public.leader20_micro_archive a set archive_object_id=o.id from chosen c where a.symbol=c.symbol and a.at=c.at;
   update public.leader20_archive_objects set row_count=(select count(*) from public.leader20_micro_archive where archive_object_id=o.id),
    min_at=(select min(at) from public.leader20_micro_archive where archive_object_id=o.id),
    max_at=(select max(at) from public.leader20_micro_archive where archive_object_id=o.id) where id=o.id returning * into o;
   if o.row_count=0 then raise exception 'ARCHIVE_EMPTY_CLAIM'; end if;
  end if;
  select jsonb_agg(jsonb_build_object('symbol',symbol,'at',at,'received_at',received_at,'payload',payload) order by at,symbol)
   into v_rows from public.leader20_micro_archive where archive_object_id=o.id;
  return jsonb_build_object('state','UPLOAD','object',to_jsonb(o),'rows',v_rows);
 elsif p_action in ('verified','deleted') then
  select * into o from public.leader20_archive_objects where id=(p_body->>'id')::uuid for update;
  if o.id is null or o.owner is distinct from v_owner or o.lease_until<=v_now then raise exception 'ARCHIVE_OWNER_CAS'; end if;
  if p_action='verified' then
   if o.state<>'PENDING' or (p_body->>'row_count')::integer is distinct from o.row_count
    or coalesce(p_body->>'raw_sha256','') !~ '^[a-f0-9]{64}$' or coalesce(p_body->>'object_sha256','') !~ '^[a-f0-9]{64}$'
    or coalesce((p_body->>'bytes')::bigint,0) not between 1 and 8388608 then raise exception 'ARCHIVE_VERIFICATION_INVALID'; end if;
   update public.leader20_archive_objects set state='VERIFIED',raw_sha256=p_body->>'raw_sha256',object_sha256=p_body->>'object_sha256',
    bytes=(p_body->>'bytes')::bigint,verified_at=v_now where id=o.id;
   update public.leader20_control set cold_archive_state='READY',archive_last_verified_at=v_now where singleton;
  else
   if o.state<>'DELETING' or o.max_at>=v_now-interval '30 days' then raise exception 'ARCHIVE_RETENTION_NOT_MET'; end if;
   update public.leader20_archive_objects set state='DELETED',deleted_at=v_now where id=o.id;
  end if;
  return jsonb_build_object('state','DONE');
 end if;
 raise exception 'ARCHIVE_ACTION_INVALID';
end $$;
revoke all on function public.leader20_archive_maintenance(text,jsonb) from public,anon,authenticated;
grant execute on function public.leader20_archive_maintenance(text,jsonb) to service_role;

create or replace function public.doa_capture_rpc(p_action text,p_body jsonb default '{}'::jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare result jsonb; ctl public.leader20_control%rowtype; watches jsonb; scheduling jsonb;
begin
 result:=public.doa_capture_rpc_before_leader20(p_action,p_body);
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled or result->>'enabled'<>'true' then return result; end if;
 if p_action='watch' then
  select jsonb_agg(x order by priority,symbol) into watches from (
   select symbol,min(priority) priority,true candles,jsonb_agg(distinct role) roles from (
    select m.symbol,2 priority,'SCANNER_LEADER' role from public.leader20_members m where m.epoch_id=ctl.epoch_id and m.rank<=ctl.watch_limit
    union all select p.symbol,0,'OPEN_POSITION' from public.v11_long_regime_positions p
      where p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'
    union all select x->>'symbol',0,'OPEN_POSITION' from jsonb_array_elements(coalesce(result->'watch','[]')) x
      where x->'roles' ? 'OPEN_POSITION'
    union all select x->>'symbol',3,r #>> '{}' from jsonb_array_elements(coalesce(result->'watch','[]')) x
      cross join lateral jsonb_array_elements(x->'roles') r where ctl.active_strategy='LEGACY'
    union all select 'BTCUSDT',1,'MARKET_SENSOR'
   ) s group by symbol
  ) x;
  return result||jsonb_build_object('watch',coalesce(watches,'[]'::jsonb),'leader20_epoch_id',ctl.epoch_id);
 elsif p_action='ingest' and coalesce(result->>'duplicate','false')<>'true' then
  if ctl.archive_max_bytes<=0 or pg_total_relation_size('public.leader20_micro_archive')+octet_length(p_body::text)>ctl.archive_max_bytes then
   update public.leader20_control set archive_state=case when archive_max_bytes<=0 then 'BUDGET_UNAPPROVED' else 'CAP_REACHED' end,
    active_strategy=case when active_strategy='LEADER20_DYNAMIC_1' then 'PAUSED' else active_strategy end,
    generation=generation+case when active_strategy='LEADER20_DYNAMIC_1' then 1 else 0 end where singleton;
   return result||jsonb_build_object('leader20_archive','BUDGET_OR_CAP_BLOCKED');
  end if;
  insert into public.leader20_micro_archive(symbol,at,received_at,payload)
   select symbol,at,received_at,payload from doa_capture.live_micro m where exists(
    select 1 from jsonb_array_elements(p_body->'rows') r where r->>'kind'='micro' and r->>'symbol'=m.symbol and (r->>'at')::timestamptz=m.at)
   and (m.symbol='BTCUSDT' or exists(select 1 from public.leader20_members u where u.epoch_id=ctl.epoch_id and u.rank<=ctl.watch_limit and u.symbol=m.symbol)
    or exists(select 1 from public.v11_long_regime_positions p where p.symbol=m.symbol and (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true')))
   on conflict do nothing;
  update public.leader20_control set archive_state='READY' where singleton;
  begin scheduling:=public.leader20_schedule();
  exception when others then scheduling:=jsonb_build_object('error','LEADER20_SCHEDULE_FAILED'); end;
  return result||jsonb_build_object('leader20_scheduler',scheduling);
 end if;
 return result;
end $$;
create or replace function public.leader20_entry_authority(p_signal_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare ctl public.leader20_control%rowtype; s public.v11_long_regime_signals%rowtype; e public.leader20_review_events%rowtype;
begin
 select * into ctl from public.leader20_control where singleton;
 select * into s from public.v11_long_regime_signals where id=p_signal_id;
 if not found then return jsonb_build_object('allowed',false,'reason','SIGNAL_MISSING'); end if;
 if s.features->'leader20'->>'version' is distinct from 'LEADER20_DYNAMIC_1' then
  return jsonb_build_object('allowed',ctl.active_strategy='LEGACY','reason','STRATEGY_OWNERSHIP'); end if;
 select * into e from public.leader20_review_events where signal_id=s.id;
 if not exists(select 1 from public.leader20_members m where m.epoch_id=ctl.epoch_id and m.symbol=s.symbol and m.rank<=ctl.watch_limit) or ctl.cold_archive_state<>'READY' or (ctl.archive_last_verified_at is null or ctl.archive_last_verified_at<now()-interval '15 minutes') or e.id is null or not ctl.observation_enabled or ctl.archive_state<>'READY' or ctl.archive_max_bytes<=0 or ctl.active_strategy<>'LEADER20_DYNAMIC_1' or e.epoch_id<>ctl.epoch_id or e.generation<>ctl.generation
   or (s.features->'leader20'->>'event_id') is distinct from e.id::text or (s.features->'leader20'->>'epoch_id') is distinct from e.epoch_id::text
   or (s.features->'leader20'->>'generation')::bigint is distinct from e.generation or s.symbol<>e.symbol
   or s.status not in ('NEW','CLAIMED','ORDERED','FILLED') or e.expires_at<=now() or e.state not in ('REVIEWING','ORDERED')
   or not exists(select 1 from public.leader20_epochs where id=e.epoch_id and next_refresh_at>now())
 then return jsonb_build_object('allowed',false,'reason','DEFER_UNIVERSE_STALE_OR_GENERATION'); end if;
 if exists(select 1 from public.v11_long_regime_positions where symbol=s.symbol and closed_at>=e.requested_at) then
  return jsonb_build_object('allowed',false,'reason','POST_SETTLEMENT_APPROVAL_REQUIRED'); end if;
 return jsonb_build_object('allowed',true,'generation',ctl.generation,'epoch_id',e.epoch_id);
end $$;

update public.gpt_final_review_control set daily_cap_usd=1.25,max_calls_per_day=100,monthly_cap_usd=40,
 approval_ref='USER-APPROVED-2026-09-27-MONTHLY50-AI40-STORAGE10',
 set_reason='User monthly USD 50 ceiling: AI <=40/month and <=1.25/day, incremental storage allowance <=10/month. Top10; event 30min / fair 6h / one request globally per 30min; half daily capacity reserved for HOLD and final recheck.',
 set_by='migration:leader20_capacity_and_retention',updated_at=now() where singleton;
update public.gpt_final_review_daily_budget b set cap_usd=c.daily_cap_usd+c.daily_spend_offset,max_calls=c.max_calls_per_day+c.daily_call_offset from public.gpt_final_review_control c where c.singleton and b.utc_day=c.budget_effective_day;
update public.leader20_control set archive_max_bytes=4294967296,cold_archive_max_bytes=8589934592,updated_at=now() where singleton;
commit;
