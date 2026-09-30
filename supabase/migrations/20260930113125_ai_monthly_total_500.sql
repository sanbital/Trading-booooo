-- Raise the approved AI spending envelope to USD 500 per month in total.
--
-- WHY
-- ---
-- On 2026-09-30 the envelope was already spent and new entries had stopped paying for
-- themselves. Measured at the time of this change:
--
--   ai_monthly_spend_used()            = 115.23  against gpt_final_review_control.monthly_cap_usd = 100
--   ai_provider_month_used('openai')   = 100.70  against ai_provider_limits.monthly_usd           = 120
--   ai_provider_month_used('deepseek') =  14.53  against ai_provider_limits.monthly_usd           = 100
--
-- The legacy claim path was over its ceiling, so gpt_final_review_claim raised
-- API_BUDGET_EXHAUSTED for every request. On the provider ledger the OpenAI low-priority
-- ceiling is monthly_usd - protected_month = 120 - 20 = 100, which 100.70 had already passed,
-- so ai_call_reserve returned API_PROTECTED_POSITION_RESERVE for ENTRY, RECHECK and
-- VERIFICATION. Only HOLD, EXIT and ENTRY_FAILURE could still reserve. Open-position
-- protection was never at risk; new entry analysis was fully stopped.
--
-- WHAT
-- ----
-- Total monthly ceiling 220 -> 500, split evenly at 250 per provider, and the same ceiling
-- on the legacy path. The protection reserve keeps its share of the total (25/220 = 11.4%
-- before, 55/500 = 11.0% after), so raising the entry allowance does not quietly erode the
-- money held back for HOLD and EXIT on open positions.
--
-- Daily limits are deliberately unchanged: ai_provider_limits.daily_usd (100 deepseek,
-- 50 openai), gpt_final_review_control.daily_cap_usd (50) and max_calls_per_day (10000)
-- already sit above the monthly ceiling's daily share, so the monthly total is the binding
-- guard, exactly as before. No history, offset or unknown reservation is erased.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Provider ledger: 250 + 250 = the approved 500 total.
update public.ai_provider_limits set monthly_usd=250 where provider in ('deepseek','openai');

-- Legacy claim path shares the same 500 ceiling, so neither accounting is the odd one out.
-- approval_ref is the audit record of what the user approved; callers read it from this row
-- (configFromControl) and echo it back, so it stays in step with the amount it authorises.
update public.gpt_final_review_control set monthly_cap_usd=500,
 approval_ref='USER-REQUEST-20260930-MONTHLY500-TOTAL-AI',updated_at=now() where singleton;

-- Protection reserve, scaled with the total it is carved out of:
--   openai   20 -> 42   (20 * 250/120 = 41.67, rounded up in protection's favour)
--   deepseek  5 -> 13   (5 * 250/100 = 12.50, rounded up in protection's favour)
-- The daily reserve is scaled the same way. It stays dominated by
-- leader20_entry_budget_limits()->>'protected_usd' (25 whenever a position is open), so this
-- only raises the floor for the no-exposure case. Edited in place from the deployed body so
-- nothing else in the function can drift; the markers fail the migration if it has changed.
do $migration$
declare source text;
 m_month text:=$m$ protected_month:=case when p_provider='openai' then 20 else 5 end;$m$;
 m_day text:=$m$ protected_day:=case when p_provider='openai' then 1 else .25 end;$m$;
begin
 select pg_get_functiondef('public.ai_call_reserve(text,text,text,text,text,text,numeric)'::regprocedure) into source;
 if strpos(source,m_month)=0 or strpos(source,m_day)=0 then
  raise exception 'AI_CALL_RESERVE_PROTECTION_BASELINE_CHANGED';
 end if;
 source:=replace(source,m_month,$m$ protected_month:=case when p_provider='openai' then 42 else 13 end;$m$);
 source:=replace(source,m_day,$m$ protected_day:=case when p_provider='openai' then 2 else .65 end;$m$);
 source:=replace(source,$m$within unchanged $100 totals.$m$,$m$within the approved $500 monthly total.$m$);
 execute source;
end $migration$;

notify pgrst,'reload schema';
commit;
