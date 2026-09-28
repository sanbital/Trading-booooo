-- Preserve the exact legacy provider split while avoiding repeated detoasting of
-- historical review packets under the paid-call reservation advisory lock.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.gpt_final_entry_reviews
 add column legacy_deepseek_usd numeric generated always as (
  case when reserved_usd is null then 0 else
   least(coalesce(settled_usd,reserved_usd,0),case
    when model='deepseek-flash' then coalesce(settled_usd,reserved_usd,0)
    when settled_usd is not null and record#>>'{result,arbitration,deepseek,model}'='deepseek-flash'
     and jsonb_typeof(record#>'{result,arbitration,deepseek,usage,prompt_tokens}')='number'
     and jsonb_typeof(record#>'{result,arbitration,deepseek,usage,completion_tokens}')='number'
    then ((record#>>'{result,arbitration,deepseek,usage,prompt_tokens}')::numeric*.3+
          (record#>>'{result,arbitration,deepseek,usage,completion_tokens}')::numeric*1.2)/1000000
    else 0 end)
  end
 ) stored;

-- The old function still exists here. Abort the entire migration if any daily
-- or monthly allocation changes, including unknown and historically settled rows.
do $$
declare d date; old_day numeric; old_month numeric; new_day numeric; new_month numeric;
begin
 for d in select distinct budget_day from public.gpt_final_entry_reviews where budget_day is not null loop
  old_day:=public.ai_legacy_deepseek_used(d,true);
  old_month:=public.ai_legacy_deepseek_used(d,false);
  select coalesce(sum(legacy_deepseek_usd) filter(where budget_day=d),0),
   coalesce(sum(legacy_deepseek_usd) filter(where budget_day>=date_trunc('month',d)::date
     and budget_day<(date_trunc('month',d)+interval '1 month')::date),0)
   into new_day,new_month from public.gpt_final_entry_reviews where reserved_usd is not null;
  if old_day is distinct from new_day or old_month is distinct from new_month then
   raise exception 'LEGACY_PROVIDER_COST_PARITY_FAILED';
  end if;
 end loop;
end $$;

create or replace function public.ai_legacy_deepseek_used(p_day date,p_daily boolean default false)
returns numeric language sql stable set search_path='' as $$
 select coalesce(sum(legacy_deepseek_usd),0)
 from public.gpt_final_entry_reviews where reserved_usd is not null and
 budget_day>=case when p_daily then p_day else date_trunc('month',p_day)::date end
 and budget_day<case when p_daily then p_day+1 else (date_trunc('month',p_day)+interval '1 month')::date end;
$$;

comment on column public.gpt_final_entry_reviews.legacy_deepseek_usd is
 'Exact stored projection of the pre-provider-ledger DeepSeek allocation; recomputed on source row changes. Not an additional charge.';
