-- Install disabled. Activation requires a recorded release validation receipt.
-- Historic balances stay in their original journal. New physical calls are charged once.
create table public.ai_provider_limits (
 provider text primary key check(provider in ('deepseek','openai')),
 monthly_usd numeric not null check(monthly_usd>0),
 daily_usd numeric not null check(daily_usd>0),
 enabled boolean not null default false
);
insert into public.ai_provider_limits values ('deepseek',100,100.0/31,false),('openai',95,3,false);
create table public.ai_call_ledger (
 call_key text primary key, provider text not null references public.ai_provider_limits,
 model text not null, purpose text not null check(purpose in ('ENTRY','RECHECK','HOLD','EXIT','VERIFICATION')),
 parent_key text, data_version text not null, owner uuid not null default gen_random_uuid(),
 state text not null check(state in ('RESERVED','DISPATCHED','SETTLED','CANCELLED','UNKNOWN')),
 reserved_usd numeric not null check(reserved_usd>=0 and reserved_usd<10),
 actual_usd numeric check(actual_usd>=0 and actual_usd<10),
 input_tokens bigint,output_tokens bigint,cached_input_tokens bigint,
 request_id text,cost_basis text,latency_ms bigint,
 created_at timestamptz not null default clock_timestamp(),settled_at timestamptz,
 error text, unique(provider,parent_key,data_version)
);
create index ai_call_ledger_provider_month on public.ai_call_ledger(provider,created_at);
create table public.leader20_batches (
 id uuid primary key default gen_random_uuid(),epoch_id uuid not null,generation bigint not null,
 data_version text not null unique,owner uuid not null default gen_random_uuid(),
 state text not null check(state in ('RESERVED','DISPATCHED','DONE','SUPERSEDED','UNKNOWN')),
 reason text not null,requested_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '90 seconds',
 packet jsonb not null,result jsonb,call_key text references public.ai_call_ledger
);
create table public.leader20_batch_control (
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 last_slots integer, last_requested_at timestamptz,last_evidence_key text,
 generation bigint not null default 0, wake_reason text,wake_requested_at timestamptz,last_budget_block jsonb,
 release_receipt jsonb,
 constraint batch_release_requires_evidence check(not enabled or coalesce(
  release_receipt @> '{"budget_verified":true,"recall_verified":true,"concurrency_verified":true,"protection_verified":true}'::jsonb,false))
);
insert into public.leader20_batch_control(singleton) values(true);
alter table public.ai_provider_limits enable row level security;
alter table public.ai_call_ledger enable row level security;
alter table public.leader20_batches enable row level security;
alter table public.leader20_batch_control enable row level security;
revoke all on public.ai_provider_limits,public.ai_call_ledger,public.leader20_batches,public.leader20_batch_control from public,anon,authenticated;
grant all on public.ai_provider_limits,public.ai_call_ledger,public.leader20_batches,public.leader20_batch_control to service_role;

-- Attribution never credits money whose original settlement is unknown. All unknown
-- historical cost stays explicitly charged to OpenAI, rather than disappearing.
alter function public.ai_monthly_spend_used(date) rename to ai_monthly_spend_used_before_provider_ledger;
create function public.ai_legacy_deepseek_used(p_day date,p_daily boolean default false) returns numeric
language sql stable set search_path='' as $$
 select coalesce(sum(least(coalesce(settled_usd,reserved_usd,0),case
  when model='deepseek-flash' then coalesce(settled_usd,reserved_usd,0)
  when settled_usd is not null and record#>>'{result,arbitration,deepseek,model}'='deepseek-flash'
   and jsonb_typeof(record#>'{result,arbitration,deepseek,usage,prompt_tokens}')='number'
   and jsonb_typeof(record#>'{result,arbitration,deepseek,usage,completion_tokens}')='number'
  then ((record#>>'{result,arbitration,deepseek,usage,prompt_tokens}')::numeric*.3+
        (record#>>'{result,arbitration,deepseek,usage,completion_tokens}')::numeric*1.2)/1000000
  else 0 end)),0)
 from public.gpt_final_entry_reviews where reserved_usd is not null and
 budget_day>=case when p_daily then p_day else date_trunc('month',p_day)::date end
 and budget_day<case when p_daily then p_day+1 else (date_trunc('month',p_day)+interval '1 month')::date end;
$$;
create function public.ai_provider_month_used(p_provider text,p_day date default (now() at time zone 'UTC')::date)
returns numeric language sql stable set search_path='' as $$
 select case when p_provider='deepseek' then public.ai_legacy_deepseek_used(p_day)
 else greatest(0,public.ai_monthly_spend_used_before_provider_ledger(p_day)-public.ai_legacy_deepseek_used(p_day)) end
 +coalesce((select sum(case when state='CANCELLED' then 0 else coalesce(actual_usd,reserved_usd) end)
 from public.ai_call_ledger where provider=p_provider
 and created_at>=date_trunc('month',p_day) at time zone 'UTC'
 and created_at<(date_trunc('month',p_day)+interval '1 month') at time zone 'UTC'),0);
$$;

create function public.ai_call_reserve(p_key text,p_provider text,p_model text,p_purpose text,
 p_parent text,p_version text,p_reserve numeric) returns jsonb
language plpgsql set search_path='' as $$
declare l public.ai_provider_limits%rowtype; j public.ai_call_ledger%rowtype; legacy_day numeric;ds_day numeric;cap jsonb;
 used numeric; entry_used numeric; protected numeric; entry_cap numeric; day_start timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
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
 protected:=least(l.daily_usd,coalesce((public.leader20_entry_budget_limits()->>'protected_usd')::numeric,.5));
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
end $$;

create function public.ai_call_transition(p_key text,p_owner uuid,p_state text,p_usage jsonb default null,
 p_request_id text default null,p_latency_ms bigint default null,p_error text default null)
returns jsonb language plpgsql set search_path='' as $$
declare j public.ai_call_ledger%rowtype; cost numeric; i bigint;o bigint;c bigint;
begin
 perform pg_advisory_xact_lock(20260928,51);
 select * into j from public.ai_call_ledger where call_key=p_key for update;
 if not found or j.owner<>p_owner then raise exception 'API_CALL_OWNER'; end if;
 if j.state=p_state and p_state in ('SETTLED','CANCELLED','UNKNOWN') then return jsonb_build_object('state',j.state,'duplicate',true); end if;
 if p_state='DISPATCHED' and j.state='RESERVED' then
  update public.ai_call_ledger set state=p_state where call_key=p_key;
 elsif p_state='CANCELLED' and j.state='RESERVED' then
  update public.ai_call_ledger set state=p_state,actual_usd=0,settled_at=clock_timestamp() where call_key=p_key;
 elsif p_state='UNKNOWN' and j.state='DISPATCHED' then
  update public.ai_call_ledger set state=p_state,error=p_error where call_key=p_key;
 elsif p_state='SETTLED' and j.state in ('DISPATCHED','UNKNOWN') then
  i:=(p_usage->>'input_tokens')::bigint;o:=(p_usage->>'output_tokens')::bigint;c:=coalesce((p_usage->>'cached_input_tokens')::bigint,0);
  if i is null or o is null or i<0 or o<0 or c<0 or c>i then raise exception 'API_USAGE_INVALID'; end if;
  cost:=case when j.provider='deepseek' then ((i-c)*.3+c*.006+o*1.2)/1000000
   else ((i-c)*.75+c*.075+o*4.5)/1000000 end;
  -- True metered usage is never truncated to a reservation, even if a provider exceeds it.
  update public.ai_call_ledger set state=p_state,actual_usd=cost,input_tokens=i,output_tokens=o,cached_input_tokens=c,
   request_id=p_request_id,cost_basis='TOKEN_RATE_PEAK_NOT_INVOICE',latency_ms=p_latency_ms,
   settled_at=clock_timestamp(),error=case when cost>reserved_usd then 'RESERVATION_EXCEEDED' else p_error end where call_key=p_key;
 else raise exception 'API_CALL_TRANSITION'; end if;
 return jsonb_build_object('state',p_state,'cost_usd',cost);
end $$;

-- Snapshot truth, DB exposure, and unresolved orders all occupy capacity. Freshness
-- failures and uncertain order outcomes cannot turn into a free entry slot.
create function public.leader20_batch_capacity() returns jsonb language plpgsql set search_path='' as $$
declare s public.trading_account_snapshots%rowtype; held text[]; pending integer; slots integer; free numeric;
begin
 select * into s from public.trading_account_snapshots where exchange='binance_futures' order by captured_at desc limit 1;
 if not found or s.positions_complete is distinct from true or s.captured_at<clock_timestamp()-interval '90 seconds' or s.captured_at>clock_timestamp() then
  return jsonb_build_object('available',0,'reason','ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE'); end if;
 select count(*) into pending from public.v11_long_regime_orders where state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
 and response_payload->>'v18ExposureFinal' is distinct from 'true';
 if s.available_quote is null or s.available_quote::text in ('NaN','Infinity','-Infinity') or jsonb_typeof(s.positions) is distinct from 'array'
 or exists(select 1 from jsonb_array_elements(s.positions) p where coalesce(p->>'symbol',p->>'market') is null
  or coalesce(p->>'quantity',p->>'positionAmt',p->>'position_amount') is null) then
  return jsonb_build_object('available',0,'reason','ACCOUNT_SNAPSHOT_UNREADABLE'); end if;
 select array_agg(distinct symbol) into held from (
  select symbol from public.v11_long_regime_positions where state='OPEN' or remaining_quantity>0.0000000001 or metadata->>'exitAccountingPending'='true'
  union select upper(coalesce(p->>'symbol',p->>'market')) from jsonb_array_elements(coalesce(s.positions,'[]')) p
   where abs(coalesce((p->>'quantity')::numeric,(p->>'positionAmt')::numeric,(p->>'position_amount')::numeric,0))>0
 ) x;
 free:=greatest(0,s.available_quote-pending*152.021375);
 slots:=greatest(0,least(10-coalesce(array_length(held,1),0)-pending,floor((free-.10)/152.021375)::integer));
 return jsonb_build_object('available',case when pending>0 then 0 else slots end,'held',coalesce(to_jsonb(held),'[]'),
  'pending_orders',pending,'available_quote',free,'snapshot_at',s.captured_at,
  'reason',case when pending>0 then 'PENDING_CAPITAL_RESERVED' when slots=0 then 'NO_ENTRY_CAPACITY' else null end);
end $$;

create function public.leader20_batch_claim(p_packet jsonb,p_evidence_key text,p_strong_change boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.leader20_batch_control%rowtype;l public.leader20_control%rowtype;cap jsonb;b public.leader20_batches%rowtype;
 reason text;at_time timestamptz:=clock_timestamp();strong boolean:=false;last_packet jsonb;
 estimate numeric;remaining_ticks integer;day_used numeric;entry_room numeric;
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into c from public.leader20_batch_control where singleton for update;
 if not c.enabled then return jsonb_build_object('created',false,'reason','BATCH_DISABLED'); end if;
 select * into l from public.leader20_control where singleton;
 cap:=public.leader20_batch_capacity();
 update public.leader20_batch_control set last_slots=(cap->>'available')::integer where singleton;
 if (cap->>'available')::integer=0 then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 select packet into last_packet from public.leader20_batches order by requested_at desc limit 1;
 select exists(select 1 from jsonb_array_elements(p_packet->'evidence') n
  join jsonb_array_elements(last_packet->'evidence') o on n->>0=o->>0
  where abs((n->>1)::numeric/nullif((o->>1)::numeric,0)-1)>=.002
   or (sign((n->>2)::numeric)<>sign((o->>2)::numeric) and abs((n->>3)::numeric-(o->>3)::numeric)>=.15)) into strong;
 if l.epoch_id::text is distinct from p_packet->>'epoch_id' or l.generation is distinct from (p_packet->>'generation')::bigint
 or not l.observation_enabled or l.active_strategy<>'LEADER20_DYNAMIC_1' then raise exception 'BATCH_GENERATION'; end if;
 if p_packet->>'version' is distinct from 'TOP10_DEEPSEEK_BATCH_2' then raise exception 'BATCH_LIVE_PROTOCOL_REQUIRED'; end if;
 if jsonb_array_length(p_packet->'symbols')<>10 or
 (select count(distinct x->>'id') from jsonb_array_elements(p_packet->'symbols')x)<>10 or
 exists(select 1 from jsonb_array_elements(p_packet->'symbols')x where not exists(
  select 1 from public.leader20_members where epoch_id=l.epoch_id and rank<=10 and symbol=x->>'id')) then raise exception 'BATCH_MEMBERSHIP'; end if;
 if (p_packet->>'as_of_ms')::numeric<extract(epoch from at_time)*1000-10000 or
  (p_packet->>'as_of_ms')::numeric>extract(epoch from at_time)*1000 then raise exception 'BATCH_STALE'; end if;
 reason:=case when c.last_slots=0 then 'SLOT_RELEASED' when c.last_requested_at is null or c.last_requested_at<=at_time-interval '10 minutes' then 'TEN_MINUTE'
  when p_strong_change and strong and p_evidence_key is distinct from c.last_evidence_key and c.last_requested_at<=at_time-interval '30 seconds' then 'EVIDENCE_CHANGED' end;
 if reason is null then return jsonb_build_object('created',false,'reason','NOT_DUE'); end if;
 -- Extra evidence wakes cannot consume the remaining day's periodic review allowance.
 -- This is cost admission only, never a filter on model decisions or candidate quality.
 if reason='EVIDENCE_CHANGED' then
  select greatest(.0001,coalesce(max((input_tokens*.3+output_tokens*1.2)/1000000),.02)) into estimate
   from public.ai_call_ledger where provider='deepseek' and parent_key like 'batch:%' and state='SETTLED'
    and created_at>at_time-interval '7 days';
  remaining_ticks:=ceil(extract(epoch from (date_trunc('day',at_time)+interval '1 day'-at_time))/600);
  select coalesce(sum(case when state='CANCELLED' then 0 else coalesce(actual_usd,reserved_usd) end),0) into day_used
   from public.ai_call_ledger where provider='deepseek' and created_at>=date_trunc('day',at_time);
  day_used:=day_used+public.ai_legacy_deepseek_used((at_time at time zone 'UTC')::date,true);
  select daily_usd-least(daily_usd,coalesce((public.leader20_entry_budget_limits()->>'protected_usd')::numeric,.5))-day_used
   into entry_room from public.ai_provider_limits where provider='deepseek';
  if entry_room < estimate*(remaining_ticks+1) then
   update public.leader20_batch_control set wake_reason='EXTRA_BATCH_BUDGET_RESERVED',
    last_budget_block=jsonb_build_object('at',at_time,'reason','EXTRA_BATCH_BUDGET_RESERVED',
     'extra_required_usd',estimate*(remaining_ticks+1)-entry_room,'periodic_requests_reserved',remaining_ticks) where singleton;
   return jsonb_build_object('created',false,'reason','EXTRA_BATCH_BUDGET_RESERVED','additional_usd',estimate*(remaining_ticks+1)-entry_room);
  end if;
 end if;
 if reason='SLOT_RELEASED' then
  update public.leader20_batches set state='SUPERSEDED' where state in ('RESERVED','DISPATCHED');
 end if;
 if exists(select 1 from public.leader20_batches where state in ('RESERVED','DISPATCHED') and expires_at>at_time) then
  return jsonb_build_object('created',false,'reason','BATCH_IN_FLIGHT'); end if;
 update public.leader20_batches set state='UNKNOWN' where state in ('RESERVED','DISPATCHED') and expires_at<=at_time;
 insert into public.leader20_batches(epoch_id,generation,data_version,state,reason,packet)
 values(l.epoch_id,l.generation,p_packet->>'batch_hash','RESERVED',reason,p_packet)
 on conflict(data_version) do nothing returning * into b;
 if b.id is null then return jsonb_build_object('created',false,'reason','DUPLICATE_CAPTURE'); end if;
 update public.leader20_batch_control set last_requested_at=at_time,last_evidence_key=p_evidence_key,generation=generation+1,wake_reason=reason where singleton;
 return jsonb_build_object('created',true,'row',to_jsonb(b),'capacity',cap);
end $$;

revoke all on function public.ai_legacy_deepseek_used(date,boolean),public.ai_provider_month_used(text,date),
 public.ai_call_reserve(text,text,text,text,text,text,numeric),public.ai_call_transition(text,uuid,text,jsonb,text,bigint,text),
 public.leader20_batch_capacity(),public.leader20_batch_claim(jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.ai_legacy_deepseek_used(date,boolean),public.ai_provider_month_used(text,date),
 public.ai_call_reserve(text,text,text,text,text,text,numeric),public.ai_call_transition(text,uuid,text,jsonb,text,bigint,text),
 public.leader20_batch_capacity(),public.leader20_batch_claim(jsonb,text,boolean) to service_role;

-- Keep old in-flight owners on their original settlement path. Per-call mode uses
-- reserved_usd=NULL, so the existing completion projection does not debit the old
-- daily total. It continues to store the complete review/audit record.
alter table public.gpt_final_entry_reviews add column provider_ledger boolean not null default false;
alter function public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) rename to gpt_final_review_claim_before_provider_ledger;
create function public.gpt_final_review_claim(p_job_key text,p_record jsonb,p_cap_usd numeric,p_max_calls integer,p_reserve_usd numeric)
returns jsonb language plpgsql set search_path='' as $$
declare j public.gpt_final_entry_reviews%rowtype;ctl public.gpt_final_review_control%rowtype;calls_used integer;call_offset integer;entry_limit integer;
begin
 if (select count(*) from public.ai_provider_limits where enabled)<>2 then
  return public.gpt_final_review_claim_before_provider_ledger(p_job_key,p_record,p_cap_usd,p_max_calls,p_reserve_usd); end if;
 perform pg_advisory_xact_lock(20260927,40);
 perform pg_advisory_xact_lock(20260928,51);
 select * into j from public.gpt_final_entry_reviews where job_key=p_job_key;
 if found then return jsonb_build_object('created',false,'row',to_jsonb(j)); end if;
 if p_record->>'transport_version' is distinct from 'AI_PROVIDER_LEDGER_1' then raise exception 'API_UNMETERED_CALLER'; end if;
 select * into ctl from public.gpt_final_review_control where singleton;
 if ctl.mode<>'ENFORCE' or not ctl.enforce_approved or ctl.approval_ref is distinct from p_record->>'api_approval_ref' then
  raise exception 'APPROVED_API_BUDGET_REQUIRED'; end if;
 call_offset:=case when ctl.budget_effective_day=(now() at time zone 'UTC')::date then ctl.daily_call_offset else 0 end;
 select greatest(0,coalesce((select calls from public.gpt_final_review_daily_budget where utc_day=(now() at time zone 'UTC')::date),0)-call_offset)
  +(select count(*) from public.gpt_final_entry_reviews where provider_ledger and budget_day=(now() at time zone 'UTC')::date) into calls_used;
 entry_limit:=coalesce((public.leader20_entry_budget_limits()->>'entry_max_calls')::integer,ctl.max_calls_per_day);
 if calls_used>=ctl.max_calls_per_day or (nullif(p_record#>>'{identity,position_id}','') is null and calls_used>=entry_limit) then
  raise exception 'API_BUDGET_EXHAUSTED'; end if;
 insert into public.gpt_final_entry_reviews(job_key,state,record,purpose,budget_day,reserved_usd,provider_ledger,signal_id,symbol)
 values(p_job_key,'RUNNING',p_record,coalesce(p_record->>'purpose','PRODUCTION'),(now() at time zone 'UTC')::date,null,true,
 p_record#>>'{identity,signal_id}',p_record#>>'{identity,symbol}') returning * into j;
 return jsonb_build_object('created',true,'row',to_jsonb(j));
end $$;
revoke all on function public.gpt_final_review_claim_before_provider_ledger(text,jsonb,numeric,integer,numeric),
 public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) from public,anon,authenticated;
grant execute on function public.gpt_final_review_claim_before_provider_ledger(text,jsonb,numeric,integer,numeric),
 public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) to service_role;

-- Legacy cadence stays installed and is used until the candidate is explicitly enabled.
alter function public.leader20_schedule() rename to leader20_schedule_before_batch;
create function public.leader20_schedule() returns jsonb language plpgsql set search_path='' as $$
begin
 if (select enabled from public.leader20_batch_control where singleton) then
  return jsonb_build_object('requests',0,'reason','BATCH_SCHEDULER_OWNS_ENTRY'); end if;
 return public.leader20_schedule_before_batch();
end $$;
revoke all on function public.leader20_schedule_before_batch(),public.leader20_schedule() from public,anon,authenticated;
grant execute on function public.leader20_schedule_before_batch(),public.leader20_schedule() to service_role;

create function public.leader20_batch_note_full() returns jsonb language plpgsql set search_path='' as $$
declare c jsonb;
begin
 perform pg_advisory_xact_lock(20260928,52);c:=public.leader20_batch_capacity();
 if (c->>'available')::integer=0 then
  update public.leader20_batch_control set last_slots=0,wake_reason=c->>'reason' where singleton;
  update public.leader20_review_events e set state='RETIRED' where result?'batch_id' and state in ('REQUESTED','REVIEWING')
   and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=e.signal_id and o.intent='OPEN_LONG'
    and o.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
    and o.response_payload->>'v18ExposureFinal' is distinct from 'true');
 end if;
 return c;
end $$;
create function public.leader20_batch_start(p_id uuid,p_owner uuid) returns jsonb language plpgsql set search_path='' as $$
declare b public.leader20_batches%rowtype;c jsonb;
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into b from public.leader20_batches where id=p_id and owner=p_owner for update;
 if not found or b.state<>'RESERVED' or b.expires_at<=clock_timestamp() then raise exception 'BATCH_START_CAS'; end if;
 c:=public.leader20_batch_capacity();
 if (c->>'available')::integer<1 then
  update public.leader20_batches set state='SUPERSEDED',result=c where id=p_id;
  update public.leader20_batch_control set last_slots=0 where singleton;
  return jsonb_build_object('allowed',false,'reason',c->>'reason');
 end if;
 update public.leader20_batches set state='DISPATCHED' where id=p_id;
 return jsonb_build_object('allowed',true);
end $$;
create function public.leader20_batch_finish(p_id uuid,p_owner uuid,p_result jsonb) returns jsonb language plpgsql set search_path='' as $$
declare b public.leader20_batches%rowtype;l public.leader20_control%rowtype;r jsonb;s jsonb;c jsonb; n integer:=0;
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into b from public.leader20_batches where id=p_id and owner=p_owner for update;
 if not found then raise exception 'BATCH_FINISH_OWNER'; end if;
 if b.state in ('DONE','SUPERSEDED') then return jsonb_build_object('events',0,'duplicate',true); end if;
 if b.state<>'DISPATCHED' then raise exception 'BATCH_FINISH_CAS'; end if;
 select * into l from public.leader20_control where singleton;
 c:=public.leader20_batch_capacity();
 if b.expires_at<=clock_timestamp() or b.epoch_id<>l.epoch_id or b.generation<>l.generation or (c->>'available')::integer<1
 or not (select enabled from public.leader20_batch_control where singleton)
 or exists(select 1 from public.leader20_batches where requested_at>b.requested_at) then
  update public.leader20_batches set state='SUPERSEDED',result=p_result||jsonb_build_object('blocked_reason','CAPACITY_OR_VERSION_CHANGED') where id=p_id;
  return jsonb_build_object('events',0,'reason','CAPACITY_OR_VERSION_CHANGED');
 end if;
 update public.leader20_review_events set state='RETIRED' where result?'batch_id' and result->>'batch_id'<>b.id::text and state in ('REQUESTED','REVIEWING');
 for r in select * from jsonb_array_elements(p_result->'results') loop
  if r->>'decision'<>'PASS' or r->>'valid'<>'true' or r->>'grounding' is distinct from 'SYMBOL_CELLS_VERIFIED_V1' then continue; end if;
  select x into s from jsonb_array_elements(b.packet->'symbols') x where x->>'id'=r->>'id';
  if s is null or s->>'state'<>'READY' or s->>'data_version' is distinct from r->>'version' or s->>'last_ms' is distinct from r->>'last_ms'
   or (select count(*) from jsonb_array_elements(p_result->'results')x where x->>'id'=r->>'id')<>1
   or c->'held' ? (r->>'id') then continue; end if;
  insert into public.leader20_review_events(epoch_id,symbol,generation,requested_at,snapshot_end_ms,snapshot_hash,reason,priority,result)
  values(b.epoch_id,r->>'id',b.generation,clock_timestamp(),(r->>'last_ms')::bigint,r->>'version','DEEPSEEK_BATCH_PASS',1,
   jsonb_build_object('batch_id',b.id,'batch_advice',r)) on conflict do nothing;
  if found then n:=n+1; end if;
 end loop;
 update public.leader20_batches set state='DONE',result=p_result where id=p_id;
 return jsonb_build_object('events',n,'reason',p_result->>'error');
end $$;

-- Wrap materialization instead of replacing the QNT/capture or trading implementation.
alter function public.leader20_materialize_event(uuid,jsonb) rename to leader20_materialize_event_before_batch;
create function public.leader20_materialize_event(p_event_id uuid,p_features jsonb) returns jsonb language plpgsql set search_path='' as $$
declare r jsonb; e public.leader20_review_events%rowtype;
begin
 select * into e from public.leader20_review_events where id=p_event_id for update;
 r:=public.leader20_materialize_event_before_batch(p_event_id,p_features);
 if r->>'created'='true' and e.result?'batch_advice' then
  update public.v11_long_regime_signals set features=jsonb_set(features,'{leader20}',features->'leader20'||
   jsonb_build_object('batch_id',e.result->'batch_id','batch_advice',e.result->'batch_advice')) where id=(r->>'signal_id')::uuid;
 end if;
 return r;
end $$;
revoke all on function public.leader20_batch_note_full(),public.leader20_batch_start(uuid,uuid),
 public.leader20_batch_finish(uuid,uuid,jsonb),public.leader20_materialize_event_before_batch(uuid,jsonb),
 public.leader20_materialize_event(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.leader20_batch_note_full(),public.leader20_batch_start(uuid,uuid),
 public.leader20_batch_finish(uuid,uuid,jsonb),public.leader20_materialize_event_before_batch(uuid,jsonb),
 public.leader20_materialize_event(uuid,jsonb) to service_role;

-- pg_net dispatches only after commit. A confirmed 0→positive transition wakes the
-- existing authenticated observer; the atomic batch claim still owns deduplication.
-- Notification failure must NEVER roll back a position, order or protection write.
create function public.leader20_batch_slot_wake() returns trigger language plpgsql set search_path='' as $$
declare ctl public.leader20_batch_control%rowtype;c jsonb;token text;
begin
 select * into ctl from public.leader20_batch_control where singleton;
 if not ctl.enabled then return null; end if;
 perform pg_advisory_xact_lock(20260928,52);
 select * into ctl from public.leader20_batch_control where singleton for update;
 c:=public.leader20_batch_capacity();
 if (c->>'available')::integer<1 then
  update public.leader20_batch_control set last_slots=0,wake_reason=c->>'reason' where singleton;
  update public.leader20_review_events e set state='RETIRED' where result?'batch_id' and state in ('REQUESTED','REVIEWING')
   and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=e.signal_id and o.intent='OPEN_LONG'
    and o.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
    and o.response_payload->>'v18ExposureFinal' is distinct from 'true');
 elsif ctl.last_slots=0 and (ctl.wake_requested_at is null or ctl.wake_requested_at<clock_timestamp()-interval '10 seconds') then
  select t.token into token from public.edge_internal_tokens t where name='v10-lane-signal-generator';
  if token is null then raise exception 'BATCH_WAKE_TOKEN_MISSING'; end if;
  perform net.http_post(url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',
   headers:=jsonb_build_object('Content-Type','application/json','x-v10-lane-token',token),
   body:='{"mode":"leader20-observe"}'::jsonb,timeout_milliseconds:=40000);
  update public.leader20_batch_control set wake_requested_at=clock_timestamp(),wake_reason='SLOT_RELEASED' where singleton;
 end if;
 return null;
exception when others then
 raise log 'LEADER20_BATCH_WAKE_FAILED:%',sqlstate;return null;
end $$;
create trigger leader20_batch_position_wake after insert or update or delete on public.v11_long_regime_positions
 for each statement execute function public.leader20_batch_slot_wake();
create trigger leader20_batch_order_wake after insert or update or delete on public.v11_long_regime_orders
 for each statement execute function public.leader20_batch_slot_wake();
create trigger leader20_batch_account_wake after insert or update on public.trading_account_snapshots
 for each statement execute function public.leader20_batch_slot_wake();
revoke all on function public.leader20_batch_slot_wake() from public,anon,authenticated;
grant execute on function public.leader20_batch_slot_wake() to service_role;

-- Existing executor already invokes this authority immediately before entry/recheck/
-- dispatch. Retire approvals from earlier batches; never resurrect a pre-full BUY.
alter function public.leader20_entry_authority(uuid) rename to leader20_entry_authority_before_batch;
create function public.leader20_entry_authority(p_signal_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare prior jsonb;s public.v11_long_regime_signals%rowtype;b public.leader20_batches%rowtype;l record;
begin
 prior:=public.leader20_entry_authority_before_batch(p_signal_id);
 if prior->>'allowed'<>'true' or not(select enabled from public.leader20_batch_control where singleton) then return prior; end if;
 select * into s from public.v11_long_regime_signals where id=p_signal_id;
 select * into b from public.leader20_batches where id::text=s.features#>>'{leader20,batch_id}';
 if not found or b.state<>'DONE' or b.expires_at<=clock_timestamp()
  or exists(select 1 from public.leader20_batches where requested_at>b.requested_at)
  or s.features#>>'{leader20,batch_advice,decision}' is distinct from 'PASS' then
  return jsonb_build_object('allowed',false,'reason','BATCH_APPROVAL_SUPERSEDED_OR_EXPIRED'); end if;
 for l in select * from public.ai_provider_limits loop
  if not l.enabled or public.ai_provider_month_used(l.provider)>=l.monthly_usd then
   return jsonb_build_object('allowed',false,'reason','API_BUDGET_EXHAUSTED','provider',l.provider); end if;
 end loop;
 return prior;
end $$;
revoke all on function public.leader20_entry_authority(uuid),public.leader20_entry_authority_before_batch(uuid) from public,anon,authenticated;
grant execute on function public.leader20_entry_authority(uuid),public.leader20_entry_authority_before_batch(uuid) to service_role;

-- Computed on every read, not a stale monthly estimate. Unknown physical outcomes
-- retain reservations. Other legacy ledgers remain in month_used but not in rate_24h.
create function public.ai_provider_budget_status() returns jsonb language sql stable set search_path='' as $$
 with history as (
  select coalesce(settled_usd,reserved_usd,0) charged,
   least(coalesce(settled_usd,reserved_usd,0),case when model='deepseek-flash' then coalesce(settled_usd,reserved_usd,0)
    when settled_usd is not null and record#>>'{result,arbitration,deepseek,model}'='deepseek-flash'
     and jsonb_typeof(record#>'{result,arbitration,deepseek,usage,prompt_tokens}')='number'
     and jsonb_typeof(record#>'{result,arbitration,deepseek,usage,completion_tokens}')='number'
    then ((record#>>'{result,arbitration,deepseek,usage,prompt_tokens}')::numeric*.3+
          (record#>>'{result,arbitration,deepseek,usage,completion_tokens}')::numeric*1.2)/1000000 else 0 end) ds,
   case when settled_usd is null then reserved_usd else 0 end unknown
  from public.gpt_final_entry_reviews where not provider_ledger and created_at>=now()-interval '24 hours'
 ), rates as (
  select l.*,public.ai_provider_month_used(l.provider) month_used,
   coalesce((select sum(case when state='CANCELLED' then 0 else coalesce(actual_usd,reserved_usd) end)
    from public.ai_call_ledger where provider=l.provider and created_at>=now()-interval '24 hours'),0)
   +coalesce((select sum(case when l.provider='deepseek' then ds else charged-ds end) from history),0) rate_24h,
   coalesce((select sum(reserved_usd) from public.ai_call_ledger where provider=l.provider and state in ('RESERVED','DISPATCHED','UNKNOWN')),0)
    +case when l.provider='openai' then coalesce((select sum(unknown) from history),0) else 0 end pending_reserve
  from public.ai_provider_limits l
 ) select jsonb_build_object('as_of',now(),'rate_basis','REVIEW_LEDGER_LAST24H_INCLUDING_UNRESOLVED_NOT_INVOICE',
  'providers',(select jsonb_agg(jsonb_build_object('provider',provider,'limit_usd',monthly_usd,'month_used_usd',month_used,
   'remaining_usd',greatest(0,monthly_usd-month_used),'last24h_usd',rate_24h,'run_rate_31d_usd',rate_24h*31,
   'days_to_cap',case when rate_24h>0 then greatest(0,monthly_usd-month_used)/rate_24h end,
   'unresolved_reserve_usd',pending_reserve,'entry_enabled',enabled and month_used<monthly_usd)) from rates));
$$;
revoke all on function public.ai_provider_budget_status() from public,anon,authenticated;
grant execute on function public.ai_provider_budget_status() to service_role;

-- The legacy total is retained as a raw input to provider attribution. The public
-- reporting total includes new physical calls exactly once; it is never fed back
-- into attribution (which would double charge OpenAI).
create function public.ai_monthly_spend_used(p_day date default (now() at time zone 'UTC')::date)
returns numeric language sql stable set search_path='' as $$
 select public.ai_provider_month_used('deepseek',p_day)+public.ai_provider_month_used('openai',p_day);
$$;
revoke all on function public.ai_monthly_spend_used(date),public.ai_monthly_spend_used_before_provider_ledger(date) from public,anon,authenticated;
grant execute on function public.ai_monthly_spend_used(date),public.ai_monthly_spend_used_before_provider_ledger(date) to service_role;
notify pgrst,'reload schema';
