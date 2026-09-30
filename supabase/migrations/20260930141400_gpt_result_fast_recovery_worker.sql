-- Fast durable recovery for provider-derived review results.
create or replace function public.gpt_final_review_recover_ready(p_limit integer default 30)
returns jsonb language plpgsql set search_path to '' as $$
declare j record; out jsonb; recovered integer:=0; skipped integer:=0;
begin
 if p_limit<1 or p_limit>100 then raise exception 'REVIEW_RECOVERY_LIMIT'; end if;
 for j in
  select job_key from public.gpt_final_entry_reviews
  where state='RUNNING' and provider_ledger=true
   and record#>>'{result,origin}'='OPENAI_API'
   and jsonb_typeof(record#>'{result,raw_response}')='object'
   and nullif(record#>>'{result,request_id}','') is not null
  order by created_at limit p_limit for update skip locked
 loop
  out:=public.gpt_final_review_promote_stored(j.job_key);
  if coalesce((out->>'recovered')::boolean,false) then recovered:=recovered+1; else skipped:=skipped+1; end if;
 end loop;
 return jsonb_build_object('recovered',recovered,'skipped',skipped);
end $$;
revoke all on function public.gpt_final_review_recover_ready(integer) from public, anon, authenticated;
grant execute on function public.gpt_final_review_recover_ready(integer) to service_role;
do $$
declare existing bigint;
begin
 select jobid into existing from cron.job where jobname='gpt-final-review-durable-recovery';
 if existing is not null then perform cron.unschedule(existing); end if;
 perform cron.schedule('gpt-final-review-durable-recovery','5 seconds','select public.gpt_final_review_recover_ready(30)');
end $$;