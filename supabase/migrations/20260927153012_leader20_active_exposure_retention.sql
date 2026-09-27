-- Retention must not remove evidence for open/unsettled exposure or an explicit replay pin.
-- Persist a complete symbol manifest before hot rows are purged. Unknown manifests fail closed.
begin;
set local lock_timeout='1s';
alter table public.leader20_archive_objects
 add column symbols text[] not null default '{}',
 add column retention_pinned boolean not null default false,
 add constraint leader20_archive_pin_before_delete check(not retention_pinned or state not in ('DELETING','DELETED'));
with manifests as (
 select a.archive_object_id,array_agg(distinct a.symbol order by a.symbol) as symbols
 from public.leader20_micro_archive a join public.leader20_archive_objects b on b.id=a.archive_object_id
 group by a.archive_object_id,b.row_count having count(*)=b.row_count and b.row_count>0
)
update public.leader20_archive_objects b set symbols=m.symbols from manifests m where b.id=m.archive_object_id;

create or replace function public.leader20_archive_maintenance(p_action text,p_body jsonb default '{}') returns jsonb
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
  select * into o from public.leader20_archive_objects b
   where (b.state='DELETING' or (b.state='VERIFIED' and b.max_at<v_now-interval '30 days'))
    and not b.retention_pinned and cardinality(b.symbols)>0
    and not exists(select 1 from public.v11_long_regime_positions p where p.symbol=any(b.symbols)
      and (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'))
   order by b.max_at limit 1 for update;
  if o.id is not null then
   if o.state='DELETING' and o.lease_until>v_now then return jsonb_build_object('state','BUSY'); end if;
   update public.leader20_archive_objects set state='DELETING',owner=v_owner,lease_until=v_now+interval '120 seconds' where id=o.id returning * into o;
   return jsonb_build_object('state','DELETE','object',to_jsonb(o));
  end if;
  -- Purge hot rows only when a downloaded object checksum was verified.
  with expired as(select a.symbol,a.at from public.leader20_micro_archive a join public.leader20_archive_objects b on b.id=a.archive_object_id
    where a.at<v_now-interval '72 hours' and b.state in ('VERIFIED','DELETED')
     and not b.retention_pinned and cardinality(b.symbols)>0
     and not exists(select 1 from public.v11_long_regime_positions p where p.symbol=a.symbol
       and (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'))
    order by a.at limit 5000)
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
   update public.leader20_archive_objects set
    symbols=(select array_agg(distinct symbol order by symbol) from public.leader20_micro_archive where archive_object_id=o.id),
    row_count=(select count(*) from public.leader20_micro_archive where archive_object_id=o.id),
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
   update public.leader20_archive_objects set state='VERIFIED',
    symbols=(select array_agg(distinct symbol order by symbol) from public.leader20_micro_archive where archive_object_id=o.id),
    raw_sha256=p_body->>'raw_sha256',object_sha256=p_body->>'object_sha256',
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
-- Only the database operator can create a replay pin; service role retains SELECT only.
commit;
