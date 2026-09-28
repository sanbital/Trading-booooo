CREATE OR REPLACE FUNCTION public.leader20_materialize_event_before_batch(p_event_id uuid, p_features jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare e public.leader20_review_events%rowtype; ctl public.leader20_control%rowtype; sid uuid; stamp timestamptz:=clock_timestamp(); f jsonb;
begin
 select * into ctl from public.leader20_control where singleton for share;
 select * into e from public.leader20_review_events where id=p_event_id for update;
 if e.id is null or e.state<>'REQUESTED' or ctl.active_strategy<>'LEADER20_DYNAMIC_1' or e.epoch_id<>ctl.epoch_id or e.generation<>ctl.generation
  or not exists(select 1 from public.leader20_epochs where id=e.epoch_id and next_refresh_at>stamp)
 then return jsonb_build_object('created',false,'reason','EVENT_NOT_CURRENT'); end if;
 f:=p_features||jsonb_build_object('leader20',jsonb_build_object('version','LEADER20_DYNAMIC_1','symbol',e.symbol,
   'epoch_id',e.epoch_id,'event_id',e.id,'generation',e.generation,'requested_at_ms',floor(extract(epoch from stamp)*1000),
   'expires_at_ms',floor(extract(epoch from stamp+interval '120 seconds')*1000),'snapshot_end_ms',e.snapshot_end_ms),
   'signal5Close',floor(extract(epoch from stamp)*1000),'signal5Open',floor(extract(epoch from stamp)*1000));
 insert into public.v11_long_regime_signals(revision,lane,symbol,side,signal_bar_at,entry_bar_at,features,status,updated_at)
 values('V11-LONG-REGIME-1.0.1','BULL',e.symbol,'LONG',stamp,stamp,f,'NEW',stamp) returning id into sid;
 update public.leader20_review_events set signal_id=sid,state='REVIEWING',expires_at=stamp+interval '120 seconds' where id=e.id;
 return jsonb_build_object('created',true,'signal_id',sid);
end $function$;

CREATE OR REPLACE FUNCTION public.leader20_entry_authority_before_batch(p_signal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare ctl public.leader20_control%rowtype; s public.v11_long_regime_signals%rowtype; e public.leader20_review_events%rowtype;
begin
 select * into ctl from public.leader20_control where singleton;
 select * into s from public.v11_long_regime_signals where id=p_signal_id;
 if not found then return jsonb_build_object('allowed',false,'reason','SIGNAL_MISSING'); end if;
 if s.features->'leader20'->>'version' is distinct from 'LEADER20_DYNAMIC_1' then
  return jsonb_build_object('allowed',ctl.active_strategy='LEGACY','reason','STRATEGY_OWNERSHIP'); end if;
 select * into e from public.leader20_review_events where signal_id=s.id;
 if not exists(select 1 from public.leader20_members m where m.epoch_id=ctl.epoch_id and m.symbol=s.symbol and m.rank<=ctl.watch_limit) or ctl.cold_archive_state<>'READY' or (ctl.archive_last_verified_at is null or ctl.archive_last_verified_at<now()-interval '15 minutes') or e.id is null or not ctl.observation_enabled or ctl.archive_state<>'READY' or ctl.archive_max_bytes<=0 or ctl.active_strategy<>'LEADER20_DYNAMIC_1' or e.epoch_id<>ctl.epoch_id or e.generation<>ctl.generation
   or (s.features->'leader20'->>'event_id') is distinct from e.id::text or (s.features->'leader20'->>'epoch_id') is distinct from e.epoch_id::text
   or (s.features->'leader20'->>'generation')::bigint is distinct from e.generation or s.symbol<>e.symbol
   or s.status not in ('NEW','CLAIMED','ORDERED','FILLED') or e.expires_at<=now() or e.state not in ('REVIEWING','ORDERED')
   or not exists(select 1 from public.leader20_epochs where id=e.epoch_id and next_refresh_at>now())
 then return jsonb_build_object('allowed',false,'reason','DEFER_UNIVERSE_STALE_OR_GENERATION'); end if;
 if exists(select 1 from public.v11_long_regime_positions where symbol=s.symbol and closed_at>=e.requested_at) then
  return jsonb_build_object('allowed',false,'reason','POST_SETTLEMENT_APPROVAL_REQUIRED'); end if;
 return jsonb_build_object('allowed',true,'generation',ctl.generation,'epoch_id',e.epoch_id);
end $function$;

