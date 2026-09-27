begin;

alter table evolution_private.budget
  add column if not exists spent numeric not null default 0,
  add column if not exists settled_calls integer not null default 0,
  add column if not exists released_calls integer not null default 0;

create table if not exists evolution_private.api_reservations (
  id uuid primary key,
  day date not null,
  provider text not null check (provider in ('gpt','deepseek')),
  kind text not null,
  reserved_usd numeric not null check (reserved_usd > 0 and reserved_usd <= 1),
  actual_usd numeric,
  state text not null default 'RESERVED' check (state in ('RESERVED','SETTLED','RELEASED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz
);

create index if not exists evolution_api_reservations_open
  on evolution_private.api_reservations(day,expires_at)
  where state='RESERVED';

revoke all on evolution_private.api_reservations from public,anon,authenticated,service_role;

create or replace function public.evolution_reserve_api_v2(
  p_provider text,
  p_kind text,
  p_usd numeric
) returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  c public.evolution_control%rowtype;
  b evolution_private.budget%rowtype;
  rid uuid := extensions.gen_random_uuid();
  expired_usd numeric := 0;
  expired_n integer := 0;
begin
  if p_provider not in ('gpt','deepseek')
     or p_kind is null or length(p_kind) not between 1 and 80
     or p_usd is null or p_usd <= 0 or p_usd > 1 then
    return null;
  end if;

  select * into c from public.evolution_control where singleton;
  if not c.enabled then return null; end if;

  insert into evolution_private.budget(day) values(current_date) on conflict do nothing;
  select * into b from evolution_private.budget where day=current_date for update;

  with released as (
    update evolution_private.api_reservations
       set state='RELEASED', actual_usd=0, settled_at=now()
     where day=current_date and state='RESERVED' and expires_at<=now()
     returning reserved_usd
  )
  select coalesce(sum(reserved_usd),0), count(*)::integer
    into expired_usd,expired_n
    from released;

  if expired_n>0 then
    update evolution_private.budget
       set reserved=greatest(0,reserved-expired_usd),
           released_calls=released_calls+expired_n
     where day=current_date;
  end if;

  select * into b from evolution_private.budget where day=current_date;
  if b.calls+1>c.max_daily_api_calls
     or b.spent+b.reserved+p_usd>c.daily_api_cap_usd then
    return null;
  end if;

  insert into evolution_private.api_reservations(id,day,provider,kind,reserved_usd,expires_at)
  values(rid,current_date,p_provider,p_kind,p_usd,now()+interval '5 minutes');

  update evolution_private.budget
     set calls=calls+1,reserved=reserved+p_usd
   where day=current_date;

  return rid;
end
$function$;

create or replace function public.evolution_settle_api(
  p_reservation uuid,
  p_actual_usd numeric,
  p_success boolean
) returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  r evolution_private.api_reservations%rowtype;
  charged numeric;
begin
  if p_reservation is null or p_success is null
     or p_actual_usd is null or p_actual_usd < 0 or p_actual_usd > 5 then
    return false;
  end if;

  select * into r
    from evolution_private.api_reservations
   where id=p_reservation
   for update;
  if not found or r.state<>'RESERVED' then return false; end if;

  perform 1 from evolution_private.budget where day=r.day for update;
  charged:=case when p_success then p_actual_usd else 0 end;

  update evolution_private.budget
     set reserved=greatest(0,reserved-r.reserved_usd),
         spent=spent+charged,
         settled_calls=settled_calls+case when p_success then 1 else 0 end,
         released_calls=released_calls+case when p_success then 0 else 1 end
   where day=r.day;

  update evolution_private.api_reservations
     set state=case when p_success then 'SETTLED' else 'RELEASED' end,
         actual_usd=charged,
         settled_at=now()
   where id=p_reservation;

  return true;
end
$function$;

-- Compatibility for the short deployment window where the old worker may still call v1.
-- It pessimistically books that legacy reservation as spent instead of leaking an outstanding reserve.
create or replace function public.evolution_reserve_api(p_calls integer,p_usd numeric)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare c public.evolution_control%rowtype;b evolution_private.budget%rowtype;
begin
  if p_calls not between 1 and 12 or p_usd not between .001 and 1 then return false;end if;
  select * into c from public.evolution_control where singleton; if not c.enabled then return false;end if;
  insert into evolution_private.budget(day)values(current_date)on conflict do nothing;
  select * into b from evolution_private.budget where day=current_date for update;
  if b.calls+p_calls>c.max_daily_api_calls or b.spent+b.reserved+p_usd>c.daily_api_cap_usd then return false;end if;
  update evolution_private.budget set calls=calls+p_calls,spent=spent+p_usd where day=current_date;
  return true;
end
$function$;

-- Reconstruct today's true spend from completed cached provider responses.
with priced as (
  select
    count(*)::integer as n,
    coalesce(sum(
      case
        when result->>'provider'='gpt'
          then coalesce((result->>'cost_usd')::numeric,0)
        when result->>'provider'='deepseek' then
          (
            coalesce((result->'usage'->>'prompt_cache_hit_tokens')::numeric,
                     (result->'usage'->'prompt_tokens_details'->>'cached_tokens')::numeric,0)
            * case when extract(isodow from created_at at time zone 'UTC') between 1 and 5
                         and (extract(hour from created_at at time zone 'UTC') between 1 and 3
                              or extract(hour from created_at at time zone 'UTC') between 6 and 9)
                   then 0.006 else 0.003 end
            +
            coalesce((result->'usage'->>'prompt_cache_miss_tokens')::numeric,
                     greatest(0,
                       coalesce((result->'usage'->>'prompt_tokens')::numeric,0)
                       - coalesce((result->'usage'->>'prompt_cache_hit_tokens')::numeric,
                                  (result->'usage'->'prompt_tokens_details'->>'cached_tokens')::numeric,0)
                     ),0)
            * case when extract(isodow from created_at at time zone 'UTC') between 1 and 5
                         and (extract(hour from created_at at time zone 'UTC') between 1 and 3
                              or extract(hour from created_at at time zone 'UTC') between 6 and 9)
                   then 0.3 else 0.15 end
            +
            coalesce((result->'usage'->>'completion_tokens')::numeric,0)
            * case when extract(isodow from created_at at time zone 'UTC') between 1 and 5
                         and (extract(hour from created_at at time zone 'UTC') between 1 and 3
                              or extract(hour from created_at at time zone 'UTC') between 6 and 9)
                   then 1.2 else 0.6 end
          ) / 1000000
        else 0
      end
    ),0) as usd
  from public.evolution_provider_cache
  where created_at>=date_trunc('day',now())
    and created_at<date_trunc('day',now())+interval '1 day'
)
update evolution_private.budget b
   set spent=priced.usd,
       reserved=0,
       settled_calls=priced.n,
       released_calls=greatest(b.calls-priced.n,0)
  from priced
 where b.day=current_date;

revoke all on function public.evolution_reserve_api_v2(text,text,numeric) from public,anon,authenticated;
revoke all on function public.evolution_settle_api(uuid,numeric,boolean) from public,anon,authenticated;
grant execute on function public.evolution_reserve_api_v2(text,text,numeric) to service_role;
grant execute on function public.evolution_settle_api(uuid,numeric,boolean) to service_role;

commit;
