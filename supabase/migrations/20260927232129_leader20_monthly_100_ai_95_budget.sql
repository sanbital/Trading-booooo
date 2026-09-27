-- Applied to production as 20260927232129_leader20_monthly_100_ai_95_budget.
-- User approval 2026-09-28: USD 100/month total, of which USD 95 is AI and USD 5 is an incremental storage planning allowance.
-- Keep existing UTC-day offsets, historical ledger, USD 0.25 per-job reservation, and exposure-aware reserve.
begin;
set local lock_timeout = '2s';
do $$
declare c public.gpt_final_review_control%rowtype;
begin
  select * into c from public.gpt_final_review_control where singleton for update;
  if c.singleton is null or c.mode <> 'ENFORCE' or c.monthly_cap_usd <> 45 or c.daily_cap_usd <> 1.25
     or c.approval_ref <> 'USER-APPROVED-2026-09-27-MONTHLY50-AI45-STORAGE5' then
    raise exception 'BUDGET_BASELINE_CHANGED_REVIEW_REQUIRED';
  end if;
end $$;
alter table public.gpt_final_review_control
  drop constraint gpt_final_review_control_monthly_cap_usd_check;
alter table public.gpt_final_review_control
  add constraint gpt_final_review_control_monthly_cap_usd_check
  check (monthly_cap_usd between 0 and 95 and monthly_cap_usd::text not in ('NaN','Infinity','-Infinity'));
alter table public.gpt_final_review_control
  drop constraint gpt_final_review_control_daily_cap_usd_check;
alter table public.gpt_final_review_control
  add constraint gpt_final_review_control_daily_cap_usd_check
  check (daily_cap_usd between 0 and 3 and daily_cap_usd::text not in ('NaN','Infinity','-Infinity'));
update public.gpt_final_review_control
set monthly_cap_usd = 95,
    daily_cap_usd = 3,
    approval_ref = 'USER-APPROVED-2026-09-28-MONTHLY100-AI95-STORAGE5',
    set_reason = 'User approved USD100/month total: AI95 plus storage allowance5; daily AI3 with existing exposure reserve and USD0.25 preauthorization; report capacity shortage',
    set_by = 'user-request-2026-09-28',
    updated_at = clock_timestamp()
where singleton;
commit;
