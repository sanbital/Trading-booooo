-- Additive preparation only. This migration never changes live strategy ownership,
-- account sizing, risk limits, AI budgets, open positions, or protection orders.
begin;
set local lock_timeout = '1s';
-- This strategy uses percentage native protection, not an invented ATR.
alter table public.v11_long_regime_positions alter column entry_atr drop not null;
alter table public.v11_long_regime_positions add constraint leader20_nullable_atr
 check(entry_atr is not null or coalesce(metadata->'entryFeatures'->'leader20'->>'version'='LEADER20_DYNAMIC_1',false)) not valid;

create table public.leader20_control (
 singleton boolean primary key default true check(singleton),
 observation_enabled boolean not null default false,
 archive_max_bytes bigint not null default 0 check(archive_max_bytes>=0),
 archive_state text not null default 'BUDGET_UNAPPROVED',
 active_strategy text not null default 'LEGACY' check(active_strategy in ('LEGACY','LEADER20_DYNAMIC_1','PAUSED')),
 generation bigint not null default 1 check(generation>0),
 epoch_id uuid,
 updated_at timestamptz not null default now()
);
insert into public.leader20_control(singleton) values(true);
create table public.leader20_epochs (
 id uuid primary key default gen_random_uuid(),
 scheduled_at timestamptz not null unique,
 observed_at timestamptz not null,
 effective_at timestamptz not null default clock_timestamp(),
 next_refresh_at timestamptz not null,
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 check(scheduled_at<=observed_at and observed_at<=effective_at and effective_at<next_refresh_at)
);
alter table public.leader20_control add foreign key(epoch_id) references public.leader20_epochs(id);
create table public.leader20_members (
 epoch_id uuid references public.leader20_epochs(id),
 symbol text not null check(symbol ~ '^[A-Z0-9]{1,24}USDT$'),
 rank integer not null check(rank between 1 and 20),
 price_change_percent numeric not null, quote_volume numeric not null check(quote_volume>=0),
 primary key(epoch_id,symbol), unique(epoch_id,rank)
);
create table public.leader20_campaigns (
 symbol text primary key check(symbol ~ '^[A-Z0-9]{1,24}USDT$'),
 epoch_id uuid references public.leader20_epochs(id),
 state text not null default 'WARMING_UP', reason text,
 last_bucket_at timestamptz, bucket_count integer not null default 0,
 last_requested_at timestamptz, last_request_sample jsonb,
 last_decision text, next_review_conditions jsonb,
 last_settled_at timestamptz, updated_at timestamptz not null default now()
);
create table public.leader20_review_events (
 id uuid primary key default gen_random_uuid(),
 epoch_id uuid not null references public.leader20_epochs(id),
 symbol text not null references public.leader20_campaigns(symbol),
 generation bigint not null, requested_at timestamptz not null default now(),
 snapshot_end_ms bigint not null, snapshot_hash text not null,
 reason text not null, priority integer not null check(priority between 0 and 3),
 state text not null default 'REQUESTED' check(state in ('REQUESTED','REVIEWING','DEFERRED','ORDERED','RETIRED')),
 signal_id uuid references public.v11_long_regime_signals(id), expires_at timestamptz,
 result jsonb,
 unique(epoch_id,symbol,generation,snapshot_hash)
);
create unique index leader20_single_flight on public.leader20_review_events(symbol)
 where state in ('REQUESTED','REVIEWING');
create index leader20_fair_queue on public.leader20_review_events(requested_at,priority) where state='REQUESTED';

-- Capture archive is append-only and private. No purge is installed until archive
-- checksum/retention and storage capacity have been approved and verified.
create table public.leader20_micro_archive (
 symbol text not null, at timestamptz not null, received_at timestamptz not null,
 payload jsonb not null, primary key(symbol,at)
);
create index leader20_archive_time on public.leader20_micro_archive(at);
do $$ declare t text; begin
 foreach t in array array['leader20_control','leader20_epochs','leader20_members','leader20_campaigns','leader20_review_events','leader20_micro_archive'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public, anon, authenticated',t);
   execute format('grant select,insert,update on public.%I to service_role',t);
 end loop;
end $$;

create function public.leader20_publish_epoch(p_snapshot jsonb,p_previous uuid default null) returns jsonb
language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype; eid uuid; item jsonb; observed timestamptz; scheduled timestamptz; next_at timestamptz;
begin
 select * into ctl from public.leader20_control where singleton for update;
 if not ctl.observation_enabled then raise exception 'LEADER20_OBSERVATION_DISABLED'; end if;
 if ctl.epoch_id is distinct from p_previous then return jsonb_build_object('published',false,'reason','EPOCH_RACE'); end if;
 observed:=to_timestamp((p_snapshot->>'observed_at_ms')::numeric/1000);
 scheduled:=to_timestamp((p_snapshot->>'scheduled_at_ms')::numeric/1000);
 next_at:=to_timestamp((p_snapshot->>'next_refresh_at_ms')::numeric/1000);
 if not (p_snapshot ?& array['strategy','selection_version','members','covered_count','expected_count','observed_at_ms','scheduled_at_ms','next_refresh_at_ms','source_hash']) then raise exception 'LEADER20_INVALID_EPOCH'; end if;
 if p_snapshot->>'strategy'<>'LEADER20_DYNAMIC_1' or
    p_snapshot->>'selection_version'<>'BINANCE_USDM_COIN_ROLLING24H_TOP20_6H_KST_1' or
    jsonb_array_length(p_snapshot->'members')<>20 or
    (p_snapshot->>'covered_count')::integer<>(p_snapshot->>'expected_count')::integer or
    (p_snapshot->>'expected_count')::integer<20 or observed>clock_timestamp()+interval '1 second' or
    observed<clock_timestamp()-interval '30 seconds' or next_at<=clock_timestamp() or
    next_at<>(date_trunc('day',observed at time zone 'Asia/Seoul')+
      (floor(extract(hour from observed at time zone 'Asia/Seoul')/6)+1)*interval '6 hours') at time zone 'Asia/Seoul'
 then raise exception 'LEADER20_INVALID_EPOCH'; end if;
 if p_previous is not null and exists(select 1 from public.leader20_epochs where id=p_previous and next_refresh_at>scheduled)
 then raise exception 'LEADER20_EPOCH_NOT_DUE'; end if;
 insert into public.leader20_epochs(scheduled_at,observed_at,next_refresh_at,snapshot,source_hash)
 values(scheduled,observed,next_at,p_snapshot,p_snapshot->>'source_hash') returning id into eid;
 for item in select * from jsonb_array_elements(p_snapshot->'members') loop
  insert into public.leader20_members values(eid,item->>'symbol',(item->>'rank')::integer,
    (item->>'price_change_percent')::numeric,(item->>'quote_volume')::numeric);
 end loop;
 insert into public.leader20_campaigns(symbol,epoch_id)
 select symbol,eid from public.leader20_members where epoch_id=eid
 on conflict(symbol) do update set epoch_id=excluded.epoch_id,state=case when public.leader20_campaigns.state='RETIRED' then 'WARMING_UP' else public.leader20_campaigns.state end,updated_at=now();
 update public.leader20_campaigns w set state=case when exists(select 1 from public.v11_long_regime_positions p
   where p.symbol=w.symbol and (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true')) then 'MANAGE_ONLY' else 'RETIRED' end,
   reason='UNIVERSE_EXPIRED',updated_at=now()
 where not exists(select 1 from public.leader20_members m where m.epoch_id=eid and m.symbol=w.symbol);
 update public.leader20_review_events set state='RETIRED' where epoch_id<>eid and state in ('REQUESTED','REVIEWING');
 update public.leader20_control set epoch_id=eid,updated_at=now() where singleton;
 return jsonb_build_object('published',true,'epoch_id',eid);
end $$;

-- Closed-position rounding residue uses the existing exit settlement zero tolerance (1e-10).
-- An OPEN position or pending accounting is always retained, regardless of quantity.
-- Per-symbol failure isolation; this function can only request reviews, never orders.
create function public.leader20_schedule() returns jsonb language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype; w public.leader20_campaigns%rowtype; c jsonb; point jsonb;
 sample jsonb; elapsed numeric; request_reason text; requests integer:=0; at_time timestamptz:=clock_timestamp(); held boolean;
begin
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled or ctl.epoch_id is null then return jsonb_build_object('requests',0); end if;
 update public.leader20_review_events e set state=case when s.status in ('ORDERED','FILLED','CLOSED') then 'ORDERED' else 'DEFERRED' end,
   result=coalesce(e.result,'{}'::jsonb)||jsonb_build_object('signal_status',s.status,'reason',s.reject_reason)
 from public.v11_long_regime_signals s where e.signal_id=s.id and e.state='REVIEWING' and
   (s.status in ('REJECTED','ORDERED','FILLED','CLOSED') or e.expires_at<=at_time);
 for w in select * from public.leader20_campaigns where state<>'RETIRED' order by last_requested_at nulls first,symbol for update skip locked loop
 begin
  held:=exists(select 1 from public.v11_long_regime_positions p where p.symbol=w.symbol and (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'));
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
  if held then continue; end if; -- The existing protected position manager has priority.
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
    when elapsed>=120 then 'FAIR_REEVALUATION'
    when elapsed>=15 and (w.state='DATA_UNAVAILABLE' or
      abs((sample->>'mid')::numeric/nullif((w.last_request_sample->>'mid')::numeric,0)-1)>=0.0005 or
      sign((sample->>'flow')::numeric)<>sign((w.last_request_sample->>'flow')::numeric) or
      abs((sample->>'imbalance')::numeric-(w.last_request_sample->>'imbalance')::numeric)>=0.15) then 'EVIDENCE_CHANGED' end;
  if request_reason is null then continue; end if;
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

create function public.leader20_materialize_event(p_event_id uuid,p_features jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare e public.leader20_review_events%rowtype; ctl public.leader20_control%rowtype; sid uuid; stamp timestamptz:=clock_timestamp(); f jsonb;
begin
 select * into ctl from public.leader20_control where singleton for share;
 select * into e from public.leader20_review_events where id=p_event_id for update;
 if e.id is null or e.state<>'REQUESTED' or ctl.active_strategy<>'LEADER20_DYNAMIC_1' or e.epoch_id<>ctl.epoch_id or e.generation<>ctl.generation
  or not exists(select 1 from public.leader20_epochs where id=e.epoch_id and next_refresh_at>stamp)
 then return jsonb_build_object('created',false,'reason','EVENT_NOT_CURRENT'); end if;
 f:=p_features||jsonb_build_object('leader20',jsonb_build_object('version','LEADER20_DYNAMIC_1','symbol',e.symbol,
   'epoch_id',e.epoch_id,'event_id',e.id,'generation',e.generation,'requested_at_ms',floor(extract(epoch from stamp)*1000),
   'expires_at_ms',floor(extract(epoch from stamp+interval '120 seconds')*1000),'snapshot_end_ms',e.snapshot_end_ms),
   'signal5Close',floor(extract(epoch from stamp)*1000),'signal5Open',floor(extract(epoch from stamp)*1000));
 insert into public.v11_long_regime_signals(revision,lane,symbol,side,signal_bar_at,entry_bar_at,features,status,updated_at)
 values('V11-LONG-REGIME-1.0.1','BULL',e.symbol,'LONG',stamp,stamp,f,'NEW',stamp) returning id into sid;
 update public.leader20_review_events set signal_id=sid,state='REVIEWING',expires_at=stamp+interval '120 seconds' where id=e.id;
 return jsonb_build_object('created',true,'signal_id',sid);
end $$;

create function public.leader20_entry_authority(p_signal_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare ctl public.leader20_control%rowtype; s public.v11_long_regime_signals%rowtype; e public.leader20_review_events%rowtype;
begin
 select * into ctl from public.leader20_control where singleton;
 select * into s from public.v11_long_regime_signals where id=p_signal_id;
 if not found then return jsonb_build_object('allowed',false,'reason','SIGNAL_MISSING'); end if;
 if s.features->'leader20'->>'version' is distinct from 'LEADER20_DYNAMIC_1' then
  return jsonb_build_object('allowed',ctl.active_strategy='LEGACY','reason','STRATEGY_OWNERSHIP'); end if;
 select * into e from public.leader20_review_events where signal_id=s.id;
 if e.id is null or not ctl.observation_enabled or ctl.archive_state<>'READY' or ctl.archive_max_bytes<=0 or ctl.active_strategy<>'LEADER20_DYNAMIC_1' or e.epoch_id<>ctl.epoch_id or e.generation<>ctl.generation
   or (s.features->'leader20'->>'event_id') is distinct from e.id::text or (s.features->'leader20'->>'epoch_id') is distinct from e.epoch_id::text
   or (s.features->'leader20'->>'generation')::bigint is distinct from e.generation or s.symbol<>e.symbol
   or s.status not in ('NEW','CLAIMED','ORDERED','FILLED') or e.expires_at<=now() or e.state not in ('REVIEWING','ORDERED')
   or not exists(select 1 from public.leader20_epochs where id=e.epoch_id and next_refresh_at>now())
 then return jsonb_build_object('allowed',false,'reason','DEFER_UNIVERSE_STALE_OR_GENERATION'); end if;
 if exists(select 1 from public.v11_long_regime_positions where symbol=s.symbol and closed_at>=e.requested_at) then
  return jsonb_build_object('allowed',false,'reason','POST_SETTLEMENT_APPROVAL_REQUIRED'); end if;
 return jsonb_build_object('allowed',true,'generation',ctl.generation,'epoch_id',e.epoch_id);
end $$;

-- Durable interpretation audit. This does not grant entry, alter the coordinator's
-- ticket, or make a delayed answer current again.
create function public.leader20_record_review() returns trigger language plpgsql set search_path='' as $$
declare marker jsonb; answer jsonb; outcome text; e public.leader20_review_events%rowtype;
begin
 marker:=new.record->'packet'->'leader20';
 if marker->>'version' is distinct from 'LEADER20_DYNAMIC_1' then return new; end if;
 select * into e from public.leader20_review_events where id=(marker->>'event_id')::uuid;
 if e.id is null or e.signal_id::text is distinct from new.record->'identity'->>'signal_id' then return new; end if;
 answer:=new.record->'result'->'answer';
 outcome:=case when new.record->'result'->>'valid'='true' and answer->>'action'='ENTER' then 'ENTER' else 'DEFER' end;
 update public.leader20_review_events set result=coalesce(result,'{}'::jsonb)||jsonb_build_object(
   'action',outcome,'review_job_key',new.job_key,'snapshot_hash',new.record->'packet'->>'snapshot_hash',
   'pressure_state',answer->>'pressure_state','decision_reason',answer->>'decision_reason',
   'counter_evidence',answer->'counter_evidence','thesis_invalidation',answer->>'thesis_invalidation',
   'next_review_conditions',answer->>'next_review_conditions','error',new.record->'result'->>'error') where id=e.id;
 update public.leader20_campaigns w set last_decision=outcome,next_review_conditions=answer->'next_review_conditions',updated_at=clock_timestamp()
 where w.symbol=e.symbol and w.epoch_id=e.epoch_id and w.last_requested_at<=e.requested_at and
   exists(select 1 from public.leader20_control c where c.epoch_id=e.epoch_id and c.generation=e.generation);
 return new;
end $$;
create trigger leader20_review_audit after update of state on public.gpt_final_entry_reviews
 for each row when(new.state='DONE' and old.state is distinct from new.state) execute function public.leader20_record_review();
revoke all on function public.leader20_record_review() from public,anon,authenticated;

-- Service-only operations surface; original packets remain in the existing AI
-- journal and the original bucket archive. No browser can mutate these controls.
create function public.leader20_status() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('strategy','LEADER20_DYNAMIC_1','control',to_jsonb(c),
   'epoch',(select to_jsonb(e)-'snapshot' from public.leader20_epochs e where e.id=c.epoch_id),
   'members',(select coalesce(jsonb_agg(to_jsonb(m) order by rank),'[]') from public.leader20_members m where m.epoch_id=c.epoch_id),
   'campaigns',(select coalesce(jsonb_agg(to_jsonb(w) order by w.last_requested_at nulls first,w.symbol),'[]') from public.leader20_campaigns w where w.state<>'RETIRED'),
   'queue',(select coalesce(jsonb_object_agg(state,n),'{}') from (select state,count(*) n from public.leader20_review_events group by state) q),
   'archive_bytes',pg_total_relation_size('public.leader20_micro_archive'),
   'live_activation_ready',false,
   'release_requirements',jsonb_build_array('VERIFIED_RUNTIME_PARITY','APPROVED_AI_CAPACITY','VERIFIED_RAW_RETENTION','FORWARD_OBSERVATION','QUIESCENT_ENTRY_SWITCH'))
 from public.leader20_control c where singleton;
$$;
revoke all on function public.leader20_status() from public,anon,authenticated;
grant execute on function public.leader20_status() to service_role;

-- Preserve the exact currently installed ingest implementation and all of its
-- authentication, lease, rate, causality and budget behaviour.
alter function public.doa_capture_rpc(text,jsonb) rename to doa_capture_rpc_before_leader20;
create function public.doa_capture_rpc(p_action text,p_body jsonb default '{}'::jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare result jsonb; ctl public.leader20_control%rowtype; watches jsonb; scheduling jsonb;
begin
 result:=public.doa_capture_rpc_before_leader20(p_action,p_body);
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled or result->>'enabled'<>'true' then return result; end if;
 if p_action='watch' then
  select jsonb_agg(x order by priority,symbol) into watches from (
   select symbol,min(priority) priority,true candles,jsonb_agg(distinct role) roles from (
    select m.symbol,2 priority,'SCANNER_LEADER' role from public.leader20_members m where m.epoch_id=ctl.epoch_id
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
   on conflict do nothing;
  update public.leader20_control set archive_state='READY' where singleton;
  begin scheduling:=public.leader20_schedule();
  exception when others then scheduling:=jsonb_build_object('error','LEADER20_SCHEDULE_FAILED'); end;
  return result||jsonb_build_object('leader20_scheduler',scheduling);
 end if;
 return result;
end $$;
revoke all on function public.doa_capture_rpc(text,jsonb),public.doa_capture_rpc_before_leader20(text,jsonb) from public,anon,authenticated;
grant execute on function public.doa_capture_rpc(text,jsonb),public.doa_capture_rpc_before_leader20(text,jsonb) to service_role;

revoke all on function public.leader20_publish_epoch(jsonb,uuid),public.leader20_schedule(),
 public.leader20_materialize_event(uuid,jsonb),public.leader20_entry_authority(uuid) from public,anon,authenticated;
grant execute on function public.leader20_publish_epoch(jsonb,uuid),public.leader20_schedule(),
 public.leader20_materialize_event(uuid,jsonb),public.leader20_entry_authority(uuid) to service_role;
commit;
