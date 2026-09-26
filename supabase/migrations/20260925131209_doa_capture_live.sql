-- Independent capture only. No trading table writes, triggers, or executor changes.
begin;
create schema doa_capture;
revoke all on schema doa_capture from public,anon,authenticated;
grant usage on schema doa_capture to service_role;
create table doa_capture.control (
 id integer primary key check(id=1), enabled boolean not null default false,
 protocol_sha256 text not null check(length(protocol_sha256)=64), starts_at timestamptz not null,
 ends_at timestamptz not null, bytes_reserved bigint not null default 0,
 requests integer not null default 0, heartbeat_at timestamptz, metrics jsonb,
 lease_owner text,lease_until timestamptz,
 check(ends_at>starts_at and ends_at<=starts_at+interval '14 days'),
 check(bytes_reserved between 0 and 500000000),check(requests between 0 and 200000)
);
create table doa_capture.candidates (
 signal_id uuid primary key,symbol text not null,candidate_at timestamptz not null,
 observed_at timestamptz not null default now(),status text,position_id uuid,fill_at timestamptz,
 entry_price numeric,executor_patch text,split text not null,coverage_status text not null default 'PENDING'
);
create table doa_capture.observations (
 kind text not null check(kind in ('micro','candle')),symbol text not null check(symbol ~ '^[A-Z0-9]{2,24}USDT$'),
 at timestamptz not null,received_at timestamptz not null default now(),payload jsonb not null,
 primary key(kind,symbol,at),check(octet_length(payload::text)<=8192)
);
create table doa_capture.batches (id uuid primary key,created_at timestamptz not null default now());
create index doa_capture_candidate_time on doa_capture.candidates(candidate_at);
create index doa_capture_observation_ttl on doa_capture.observations(at);
alter table doa_capture.control enable row level security;
alter table doa_capture.candidates enable row level security;
alter table doa_capture.observations enable row level security;
alter table doa_capture.batches enable row level security;
revoke all on all tables in schema doa_capture from public,anon,authenticated;
grant select,insert,update,delete on all tables in schema doa_capture to service_role;

create function public.doa_capture_rpc(p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' set lock_timeout='250ms' as $$
declare c doa_capture.control%rowtype; owner_id text; n integer; sz bigint; physical bigint; out_json jsonb;
begin
 if p_action='status' then
   select to_jsonb(x)-'lease_owner' into out_json from doa_capture.control x where id=1;
   return out_json;
 end if;
 select * into c from doa_capture.control where id=1 for update;
 if c.id is null or not c.enabled or now()<c.starts_at or now()>=c.ends_at then return jsonb_build_object('enabled',false,'reason','DISABLED_OR_EXPIRED');end if;
 owner_id:=p_body->>'worker_id';
 if owner_id is null or owner_id !~ '^[a-zA-Z0-9-]{8,80}$' then raise exception 'worker identity required';end if;
 if c.lease_owner is not null and c.lease_owner<>owner_id and c.lease_until>now() then return jsonb_build_object('enabled',false,'reason','LEASE_BUSY');end if;
 sz:=octet_length(p_body::text);
 if sz>500000 then raise exception 'body cap';end if;
 select coalesce(sum(pg_catalog.pg_total_relation_size(cl.oid)),0) into physical from pg_catalog.pg_class cl join pg_catalog.pg_namespace ns on ns.oid=cl.relnamespace where ns.nspname='doa_capture' and cl.relkind='r';
 if c.requests>=200000 or c.bytes_reserved+sz>500000000 or physical>=1200000000 then
   update doa_capture.control set enabled=false,metrics=jsonb_build_object('stop_reason','CAP_REACHED') where id=1;
   return jsonb_build_object('enabled',false,'reason','CAP_REACHED');
 end if;
 update doa_capture.control set requests=requests+1,lease_owner=owner_id,lease_until=now()+interval '90 seconds',heartbeat_at=now() where id=1;
 if p_action='watch' then
   select count(*) into n from doa_capture.candidates;
   insert into doa_capture.candidates(signal_id,symbol,candidate_at,status,split)
   select s.id,s.symbol,s.created_at,s.status,case when s.created_at<c.starts_at+interval '4 days' then 'DEV' when s.created_at<c.starts_at+interval '9 days' then 'VALIDATION' else 'TEST' end
   from public.v11_long_regime_signals s where s.created_at>=c.starts_at and s.created_at<c.ends_at
   and s.features->>'strategy'='LEADER_MOMENTUM_V17' and not exists(select 1 from doa_capture.candidates d where d.signal_id=s.id)
   order by s.created_at,s.id limit greatest(0,2000-n);
   update doa_capture.candidates d set status=s.status,position_id=p.id,fill_at=p.entry_at,entry_price=p.entry_price,executor_patch=p.metadata->>'executorPatch'
   from public.v11_long_regime_signals s left join public.v11_long_regime_positions p on p.signal_id=s.id
   where d.signal_id=s.id and (d.status is distinct from s.status or d.position_id is distinct from p.id);
   -- Admission stops at 2000; finish already admitted candidates until the fixed end time.
   return jsonb_build_object('enabled',true,'ends_at',c.ends_at,'protocol_sha256',c.protocol_sha256,
    'windows',coalesce((select jsonb_agg(x) from (
      select symbol,candidate_at as at from doa_capture.candidates where candidate_at>now()-interval '4 minutes'
      union select symbol,entry_at from public.v11_long_regime_positions where entry_at>=c.starts_at and entry_at>now()-interval '4 minutes'
    )x),'[]'::jsonb),
    'watch',coalesce((select jsonb_agg(x) from (
      select symbol,min(priority) priority,bool_or(candles) candles from (
        select symbol,0 priority,true candles from public.v11_long_regime_positions where state='OPEN'
        union all select 'BTCUSDT',1,true
        union all select symbol,2,true from doa_capture.candidates where candidate_at>now()-interval '65 minutes'
        union all select symbol,3,false from public.v11_long_regime_signals where created_at>now()-interval '6 hours' and status='NEW' and features->>'strategy'='LEADER_MOMENTUM_V17'
        union all select t->>'symbol',4,false from jsonb_array_elements(coalesce((select details->'top10' from public.v17_market_scan_runs where captured_at>now()-interval '15 minutes' order by captured_at desc limit 1),'[]'::jsonb)) t
        union all select symbol,5,false from public.v11_long_regime_signals where created_at>now()-interval '6 hours' and features->>'strategy'='LEADER_MOMENTUM_V17'
      )w group by symbol order by min(priority),symbol limit 32
    )x),'[]'::jsonb));
 elsif p_action='ingest' then
   if jsonb_typeof(p_body->'rows')<>'array' or jsonb_array_length(p_body->'rows')>400 then raise exception 'row cap';end if;
   if exists(select 1 from doa_capture.batches where id=(p_body->>'batch_id')::uuid) then return jsonb_build_object('enabled',true,'duplicate',true);end if;
   if exists(select 1 from jsonb_array_elements(p_body->'rows') r where (r->>'at')::timestamptz<c.starts_at-interval '2 minutes' or (r->>'at')::timestamptz>now()+interval '5 seconds') then raise exception 'timestamp bounds';end if;
   if (select count(distinct r->>'symbol') from jsonb_array_elements(p_body->'rows') r)>32 then raise exception 'symbol cap';end if;
   insert into doa_capture.observations(kind,symbol,at,payload)
    select r->>'kind',r->>'symbol',(r->>'at')::timestamptz,r->'payload' from jsonb_array_elements(p_body->'rows') r on conflict do nothing;
   get diagnostics n=row_count;
   insert into doa_capture.batches(id) values((p_body->>'batch_id')::uuid);
   update doa_capture.control set bytes_reserved=bytes_reserved+sz,metrics=coalesce(p_body->'metrics','{}') where id=1;
   return jsonb_build_object('enabled',true,'inserted',n,'bytes_reserved',c.bytes_reserved+sz,'physical_bytes',physical);
 end if;
 raise exception 'invalid action';
end $$;
revoke all on function public.doa_capture_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.doa_capture_rpc(text,jsonb) to service_role;
-- No run activation or schedule in the migration. Activation follows deployment verification.
commit;
