-- Preserve the approved cadence, account90s safety, budgets and original batch expiry.
set local lock_timeout='2s';
set local statement_timeout='15s';
CREATE OR REPLACE FUNCTION public.leader20_batch_finish(p_id uuid, p_owner uuid, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $function$
declare b public.leader20_batches%rowtype;l public.leader20_control%rowtype;r jsonb;s jsonb;c jsonb; n integer:=0;
 checked timestamptz;first_at timestamptz;retry_until timestamptz;why text;observation jsonb;gate jsonb;audit jsonb;
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into b from public.leader20_batches where id=p_id and owner=p_owner for update;
 if not found then raise exception 'BATCH_FINISH_OWNER'; end if;
 if b.state in ('DONE','SUPERSEDED') then return jsonb_build_object('events',0,'duplicate',true,'pending',false,'state',b.state); end if;
 if b.state<>'DISPATCHED' then raise exception 'BATCH_FINISH_CAS'; end if;
 -- The first pending completion owns the immutable provider result. Never pay again.
 p_result:=p_result-'finish_gate';
 if b.result ? 'finish_gate' then
  if (b.result-'finish_gate') is distinct from p_result then raise exception 'BATCH_FINISH_RESULT_MISMATCH'; end if;
  p_result:=b.result-'finish_gate';
 end if;
 select * into l from public.leader20_control where singleton;
 c:=public.leader20_batch_capacity();checked:=clock_timestamp();
 select jsonb_build_object('id',id,'captured_at',captured_at,'positions_complete',positions_complete)
  into observation from public.trading_account_snapshots where exchange='binance_futures' order by captured_at desc limit 1;
 first_at:=nullif(b.result#>>'{finish_gate,first_blocked,checked_at}','')::timestamptz;
 retry_until:=least(b.expires_at,coalesce(first_at,checked)+interval '30 seconds');
 why:=case
  when b.expires_at<=checked then 'BATCH_EXPIRED'
  when b.epoch_id is distinct from l.epoch_id or b.generation is distinct from l.generation then 'BATCH_VERSION_CHANGED'
  when not coalesce((select enabled from public.leader20_batch_control where singleton),false) then 'BATCH_DISABLED'
  when exists(select 1 from public.leader20_batches where requested_at>b.requested_at) then 'NEWER_BATCH_EXISTS'
  when first_at is not null and checked>=retry_until then 'ACCOUNT_SNAPSHOT_WAIT_EXHAUSTED'
  when coalesce((c->>'available')::integer,0)<1 then coalesce(c->>'reason','CAPACITY_UNAVAILABLE')
  else null end;
 audit:=jsonb_build_object('checked_at',checked,'reason',why,'capacity',c,'account_snapshot',observation);
 gate:=jsonb_build_object('checks',coalesce((b.result#>>'{finish_gate,checks}')::integer,0)+1,'last',audit,
  'first_blocked',coalesce(nullif(b.result#>'{finish_gate,first_blocked}','null'::jsonb),case when why is not null then audit end));
 if why='ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE' and checked<retry_until then
  -- Commit and release locks before the Edge caller waits. No events or AI call here.
  update public.leader20_batches set result=p_result||jsonb_build_object('finish_gate',gate) where id=p_id;
  return jsonb_build_object('events',0,'pending',true,'reason',why,'retry_after_ms',1000,
   'retry_until',retry_until,'expires_at',b.expires_at);
 end if;
 if why is not null then
  update public.leader20_batches set state='SUPERSEDED',result=p_result||jsonb_build_object(
   'blocked_reason',why,'finish_gate',gate) where id=p_id;
  return jsonb_build_object('events',0,'pending',false,'reason',why);
 end if;
 -- A newer batch is evidence, not revocation of a fresh GPT candidate.
 perform public.leader20_schedule();
 for r in select * from jsonb_array_elements(p_result->'results') loop
  update public.leader20_campaigns set
   state=case when c->'held' ? (r->>'id') then 'OPEN' else 'WATCHING' end,
   reason=case when r->>'valid'='true' then 'DEEPSEEK_'||(r->>'decision') else coalesce(r->>'reason','DATA_UNAVAILABLE') end,
   last_batch_id=b.id,last_decision=r->>'decision',last_requested_at=b.requested_at,
   review_due_at=(select next_periodic_at from public.leader20_batch_control where singleton),updated_at=clock_timestamp()
  where symbol=r->>'id' and epoch_id=b.epoch_id;
  -- DeepSeek is evidence, including WAIT/SKIP/unavailable opinions, never a strategy veto.
  select x into s from jsonb_array_elements(b.packet->'symbols') x where x->>'id'=r->>'id';
  if s is null or s->>'state'<>'READY' or s->>'data_version' is distinct from r->>'version' or s->>'last_ms' is distinct from r->>'last_ms'
   or (select count(*) from jsonb_array_elements(p_result->'results')x where x->>'id'=r->>'id')<>1
   or c->'held' ? (r->>'id') then continue; end if;
  insert into public.leader20_review_events(epoch_id,symbol,generation,requested_at,snapshot_end_ms,snapshot_hash,reason,priority,result)
  values(b.epoch_id,r->>'id',b.generation,clock_timestamp(),(r->>'last_ms')::bigint,r->>'version','TOP10_GPT_REVIEW',1,
   jsonb_build_object('batch_id',b.id,'batch_advice',r)) on conflict do nothing;
  if found then n:=n+1; end if;
 end loop;
 update public.leader20_batches set state='DONE',result=p_result||jsonb_build_object('finish_gate',gate) where id=p_id;
 return jsonb_build_object('events',n,'pending',false,'reason',p_result->>'error');
end $function$;

revoke all on function public.leader20_batch_finish(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.leader20_batch_finish(uuid,uuid,jsonb) to service_role;
