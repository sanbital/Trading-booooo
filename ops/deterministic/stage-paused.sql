begin;
set local lock_timeout='750ms';
set local statement_timeout='5000ms';
do $$ begin
 if not exists(select 1 from public.trading_settings where id=1 and pause_new_entries
   and mode='LIVE_LIMITED' and not emergency_liquidation and not manual_intervention_required)
 then raise exception 'ENTRY_PAUSE_REQUIRED';end if;
 if not exists(select 1 from public.leader20_control where singleton and active_strategy='LEADER20_DYNAMIC_1' and watch_limit=10)
 then raise exception 'LEGACY_CONTROL_CHANGED';end if;
 if not exists(select 1 from public.trading_scheduler_control where scheduler_key='trading-production' and enabled)
 then raise exception 'EXTERNAL_CLOCK_REQUIRED';end if;
end $$;
update public.leader20_control set active_strategy='PAUSED',generation=generation+1,updated_at=clock_timestamp() where singleton;
update public.leader20_batch_control set enabled=false,generation=generation+1 where singleton;
update public.gpt_final_review_control set mode='OFF',enforce_approved=false,updated_at=clock_timestamp() where singleton;
update public.trading_scheduler_jobs set enabled=false where scheduler_key='trading-production'
 and (target->>'endpoint' in ('v10-lane-executor','v10-lane-signal-generator')
 or job_key in ('gpt-review-expire','gpt-final-review-durable-recovery','bounded-clock-telemetry'));
-- Canonical sync, account maintenance, native monitoring, reservation sweep and
-- bounded archive retention retain their existing jobs and fences.
commit;
