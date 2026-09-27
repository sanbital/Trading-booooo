with members as (
 select m.symbol,m.rank,m.rank<=c.watch_limit as actively_watched,
   case when m.rank<=c.watch_limit then public.doa_context_for_role_v1(m.symbol,now(),'TRADE_CANDIDATE',null) else null end as capture
 from public.leader20_members m join public.leader20_control c on c.epoch_id=m.epoch_id and c.singleton
)
select jsonb_build_object('checked_at',now(),
 'members',(select count(*) from members),
 'watched_members',(select count(*) from members where actively_watched),
 'fresh_full_members',(select count(*) from members where capture->>'status'='AVAILABLE' and (capture->>'buckets')::integer=24 and (capture->>'end_ms')::numeric>extract(epoch from now())*1000-10000),
 'coverage',(select jsonb_agg(jsonb_build_object('symbol',symbol,'rank',rank,'actively_watched',actively_watched,'status',coalesce(capture->>'status','OUTSIDE_COST_PROFILE'),'reason',capture->>'reason','buckets',capture->'buckets','end_ms',capture->'end_ms') order by rank) from members),
 'heartbeat_age_seconds',(select extract(epoch from now()-heartbeat_at) from doa_capture.control where id=1),
 'active_strategy',(select active_strategy from public.leader20_control where singleton),
 'archive_max_bytes',(select archive_max_bytes from public.leader20_control where singleton),
 'open_positions',(select count(*) from public.v11_long_regime_positions where state='OPEN'));
