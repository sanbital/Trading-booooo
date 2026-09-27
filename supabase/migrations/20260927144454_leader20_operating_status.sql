-- Read-only reporting: capacity was approved separately; reports grant no trading authority.
begin;
create or replace function public.leader20_status() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('strategy','LEADER20_DYNAMIC_1','control',to_jsonb(c),
   'epoch',(select to_jsonb(e)-'snapshot' from public.leader20_epochs e where e.id=c.epoch_id),
   'members',(select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('actively_watched',m.rank<=c.watch_limit) order by rank),'[]') from public.leader20_members m where m.epoch_id=c.epoch_id),
   'campaigns',(select coalesce(jsonb_agg(to_jsonb(w) order by w.last_requested_at nulls first,w.symbol),'[]') from public.leader20_campaigns w where w.state<>'RETIRED'),
   'queue',(select coalesce(jsonb_object_agg(state,n),'{}') from (select state,count(*) n from public.leader20_review_events group by state) q),
   'archive_bytes',pg_total_relation_size('public.leader20_micro_archive'),
   'cold_archive_bytes',(select coalesce(sum(bytes),0) from public.leader20_archive_objects where state<>'DELETED'),
   'budget',(select to_jsonb(b)-'set_reason'-'set_by' from public.gpt_final_review_control b where singleton),
   'month_reserved_and_settled_usd',(select coalesce(sum(reserved_usd),0) from public.gpt_final_review_daily_budget where utc_day>=date_trunc('month',now() at time zone 'UTC')::date),
   'strategy_active',c.active_strategy='LEADER20_DYNAMIC_1',
   'live_activation_ready',c.active_strategy='LEADER20_DYNAMIC_1' and c.observation_enabled and c.archive_state='READY'
     and c.cold_archive_state='READY' and c.archive_last_verified_at>now()-interval '15 minutes'
     and exists(select 1 from public.leader20_epochs e where e.id=c.epoch_id and e.next_refresh_at>now())
     and exists(select 1 from public.trading_settings s where s.id=1 and s.mode='LIVE_LIMITED' and not s.pause_new_entries and s.pause_lock_reason is null),
   'readiness_scope','CURRENT_STRATEGY_AND_STORAGE_CONTROLS; PER_SYMBOL_DATA_AND_EXECUTION_GATES_STILL_APPLY',
   'performance_validated',false,
   'release_requirements',jsonb_build_array('VERIFIED_RUNTIME_PARITY','APPROVED_AI_CAPACITY','VERIFIED_RAW_RETENTION','FORWARD_OBSERVATION','QUIESCENT_ENTRY_SWITCH'))
 from public.leader20_control c where singleton;
$$;
revoke all on function public.leader20_status() from public,anon,authenticated;
grant execute on function public.leader20_status() to service_role;
commit;
