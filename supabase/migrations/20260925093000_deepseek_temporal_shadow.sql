-- Finite, private research queue. No trading-table writes or promotion procedure.
create table public.deepseek_temporal_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  max_pairs integer not null default 420 check(max_pairs between 0 and 420),
  claimed_pairs integer not null default 0 check(claimed_pairs between 0 and 420)
);
insert into public.deepseek_temporal_control(singleton) values(true);
create table public.deepseek_temporal_jobs (
  id text primary key,
  source text not null check(source in ('HISTORICAL_DEVELOPMENT','PROSPECTIVE')),
  partition text not null check(partition in ('DEVELOPMENT','VALIDATION','TEST','PURGED')),
  group_key text not null,
  as_of_ms bigint not null,
  packet jsonb not null,
  previous jsonb not null default '[]',
  state text not null default 'NEW' check(state in ('NEW','RUNNING','DONE','ERROR')),
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);
create index deepseek_temporal_queue_idx on public.deepseek_temporal_jobs(state,as_of_ms);
alter table public.deepseek_temporal_control enable row level security;
alter table public.deepseek_temporal_jobs enable row level security;
revoke all on public.deepseek_temporal_control,public.deepseek_temporal_jobs from public,anon,authenticated;
grant select,update on public.deepseek_temporal_control to service_role;
grant select,insert,update on public.deepseek_temporal_jobs to service_role;

create function public.deepseek_temporal_claim()
returns setof public.deepseek_temporal_jobs language plpgsql security definer set search_path='' as $$
declare c public.deepseek_temporal_control; j public.deepseek_temporal_jobs;
begin
  select * into c from public.deepseek_temporal_control where singleton for update;
  if not c.enabled or now()>=c.expires_at or c.claimed_pairs>=c.max_pairs then return; end if;
  -- The control lock serializes intake, deduplication and the finite call reservation.
  insert into public.deepseek_temporal_jobs(id,source,partition,group_key,as_of_ms,packet,previous)
  select 'L:'||r.job_key,'PROSPECTIVE',
    case when p.entry_at<c.started_at then 'PURGED'
      when r.created_at<c.started_at+interval '3 days' then 'VALIDATION'
      when p.entry_at<c.started_at+interval '3 days' then 'PURGED' else 'TEST' end,
    r.record->'identity'->>'position_id',(r.record->>'snapshot_at_ms')::bigint,r.record->'packet',
    coalesce((select jsonb_agg(h.x order by h.at) from (
      select (q.record->>'snapshot_at_ms')::bigint at,jsonb_build_object(
        'group_key',q.record->'identity'->>'position_id','as_of_ms',(q.record->>'snapshot_at_ms')::bigint,'packet',q.record->'packet') x
      from public.gpt_final_entry_reviews q
      where q.state='DONE' and q.record->'packet'->>'task'='HOLD'
        and q.record->'identity'->>'position_id'=r.record->'identity'->>'position_id'
        and (q.record->>'snapshot_at_ms')::bigint<(r.record->>'snapshot_at_ms')::bigint
        and (q.record->>'snapshot_at_ms')::bigint>=(r.record->>'snapshot_at_ms')::bigint-3600000
      order by (q.record->>'snapshot_at_ms')::bigint desc limit 3) h),'[]'::jsonb)
  from public.gpt_final_entry_reviews r
  join public.v11_long_regime_positions p on p.id::text=r.record->'identity'->>'position_id'
  where r.state='DONE' and r.purpose='PRODUCTION' and r.record->'packet'->>'task'='HOLD'
    and r.created_at>=c.started_at and r.created_at<c.expires_at
    and r.record->>'snapshot_at_ms' ~ '^[0-9]{13}$'
    and not exists(select 1 from public.deepseek_temporal_jobs q where q.id='L:'||r.job_key)
  order by r.created_at limit 20 on conflict do nothing;
  select * into j from public.deepseek_temporal_jobs where state='NEW' and partition<>'PURGED'
    order by as_of_ms,id limit 1 for update skip locked;
  if not found then return; end if;
  update public.deepseek_temporal_control set claimed_pairs=claimed_pairs+1 where singleton;
  return query update public.deepseek_temporal_jobs set state='RUNNING',claimed_at=now()
    where id=j.id and state='NEW' returning *;
  -- Never requeue RUNNING: a killed worker may already have incurred provider charges.
end $$;
revoke all on function public.deepseek_temporal_claim() from public,anon,authenticated;
grant execute on function public.deepseek_temporal_claim() to service_role;
