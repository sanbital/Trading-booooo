-- Retire unused research execution, retain evidence, and count its existing costs.
begin;
set local lock_timeout='1s';
update shadow_le.control set enabled=false,gpt_enabled=false,v2_discovery_gpt=false,v2_parity_enabled=false,
 set_by='USER_MONTHLY50_20260927',reason='Retired unused paid research under monthly 50 USD cost profile',updated_at=now() where singleton;
alter table shadow_le.control add constraint leader20_monthly50_shadow_disabled
 check(not enabled and not gpt_enabled and not v2_discovery_gpt and not v2_parity_enabled);
select cron.alter_job(jobid,active:=false) from cron.job where jobname in (
 'v16-momentum-shadow-5m',
 'v16-momentum-broad-shadow-5m',
 'v16-production-canary-5m',
 'v18-strategy-shadow-observe',
 'qv3-entry-exit-shadow-observe',
 'boo-r1-shadow-20260916',
 'leader-emerging-shadow-wait',
 'leader-emerging-shadow-outcome',
 'leader-emerging-shadow-fd1early',
 'leader-emerging-shadow-scan',
 'leader-emerging-shadow-parity',
 'leader-emerging-shadow-v2wait',
 'leader-emerging-shadow-fd1audit');
create or replace function public.ai_monthly_spend_used(p_day date default (now() at time zone 'UTC')::date)
returns numeric language sql stable security definer set search_path='' as $$
 select coalesce((select sum(reserved_usd) from public.gpt_final_review_daily_budget
   where utc_day>=date_trunc('month',p_day)::date and utc_day<(date_trunc('month',p_day)+interval '1 month')::date),0)
 +coalesce((select sum(spent+reserved) from evolution_private.budget
   where day>=date_trunc('month',p_day)::date and day<(date_trunc('month',p_day)+interval '1 month')::date),0)
 +coalesce((select sum(coalesce(s.usd,r.usd)) from shadow_le.budget r
   left join shadow_le.budget s on s.kind='SETTLE' and s.reservation_id=r.entry_id
   where r.kind='RESERVE' and r.utc_day>=date_trunc('month',p_day)::date and r.utc_day<(date_trunc('month',p_day)+interval '1 month')::date),0)
 +coalesce((select sum(coalesce(s.usd,r.usd)) from shadow_le.v2_budget r
   left join shadow_le.v2_budget s on s.kind='SETTLE' and s.reservation_id=r.entry_id
   where r.kind='RESERVE' and r.utc_day>=date_trunc('month',p_day)::date and r.utc_day<(date_trunc('month',p_day)+interval '1 month')::date),0)
 +coalesce((select sum(coalesce(cost_usd,0.012)) from shadow_le.fd1_thesis_reviews
   where created_at>=date_trunc('month',p_day) at time zone 'UTC'
   and created_at<(date_trunc('month',p_day)+interval '1 month') at time zone 'UTC'),0);
$$;
revoke all on function public.ai_monthly_spend_used(date) from public,anon,authenticated;
grant execute on function public.ai_monthly_spend_used(date) to service_role;
commit;
