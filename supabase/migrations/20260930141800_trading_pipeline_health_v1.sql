-- Component-scoped production health; no trading authority or strategy changes.
create or replace function public.trading_pipeline_health_v1()
returns jsonb language sql stable set search_path to '' as $$
with cap as (select heartbeat_at,metrics from doa_capture.control where id=1),
reviews as (select count(*) filter(where state='RUNNING' and created_at>clock_timestamp()-interval '5 minutes') running_recent,
 count(*) filter(where state='DONE' and created_at>clock_timestamp()-interval '15 minutes') done_15m,
 count(*) filter(where error='REVIEW_EXPIRED_PROVIDER_OUTCOME_UNCERTAIN' and completed_at>clock_timestamp()-interval '15 minutes') uncertain_15m
 from public.gpt_final_entry_reviews),
provider as (select count(*) filter(where provider='openai' and state='SETTLED' and created_at>clock_timestamp()-interval '15 minutes') openai_settled_15m,
 count(*) filter(where provider='deepseek' and state='CANCELLED' and created_at>clock_timestamp()-interval '15 minutes') deepseek_failed_15m from public.ai_call_ledger),
execution as (select count(*) filter(where state='READY_TO_EXECUTE') ready,
 count(*) filter(where state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING')) active,
 count(*) filter(where state='READY_TO_EXECUTE' and valid_until<=clock_timestamp()) expired_ready from public.leader20_execution_dispatches),
positions as (select count(*) filter(where state='OPEN') open_positions,
 count(*) filter(where state='OPEN' and metadata#>>'{exitProtection,health}'='PROTECTED') protected_positions from public.v11_long_regime_positions)
select jsonb_build_object('observed_at',clock_timestamp(),
 'capture',jsonb_build_object('health',case when cap.heartbeat_at is null or clock_timestamp()-cap.heartbeat_at>interval '25 seconds' then 'DOWN'
  when coalesce((cap.metrics->>'synced')::int,0)<coalesce((cap.metrics->>'watched')::int,0) then 'DEGRADED' else 'UP' end,
  'version',cap.metrics->>'version','watched',(cap.metrics->>'watched')::int,'synced',(cap.metrics->>'synced')::int,'heartbeat_at',cap.heartbeat_at),
 'decision',jsonb_build_object('health',case when reviews.uncertain_15m>0 then 'DEGRADED' else 'UP' end,
  'running_recent',reviews.running_recent,'done_15m',reviews.done_15m,'provider_outcome_uncertain_15m',reviews.uncertain_15m),
 'provider',jsonb_build_object('openai',case when provider.openai_settled_15m>0 then 'UP' else 'IDLE' end,
  'deepseek',case when provider.deepseek_failed_15m>0 then 'DEGRADED' else 'UP_OR_IDLE' end,
  'openai_settled_15m',provider.openai_settled_15m,'deepseek_failed_15m',provider.deepseek_failed_15m),
 'execution',jsonb_build_object('health',case when execution.expired_ready>0 then 'DEGRADED' else 'UP' end,
  'ready',execution.ready,'active',execution.active,'expired_ready',execution.expired_ready),
 'position',jsonb_build_object('health',case when positions.open_positions>positions.protected_positions then 'DEGRADED' else 'UP' end,
  'open',positions.open_positions,'protected',positions.protected_positions))
from cap,reviews,provider,execution,positions $$;
revoke all on function public.trading_pipeline_health_v1() from public,anon,authenticated;
grant execute on function public.trading_pipeline_health_v1() to service_role;