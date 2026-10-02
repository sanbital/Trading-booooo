-- New authority is enabled only by the validated release transaction.
-- Retire provider-era discovery/journal hooks. Keep fencing, slot-cap, fill retry,
-- native terminal and accounting triggers. Historical rows/functions are preserved.
drop trigger if exists leader20_batch_order_wake on public.v11_long_regime_orders;
drop trigger if exists leader20_batch_position_wake on public.v11_long_regime_positions;
drop trigger if exists leader20_clock_execution_order on public.v11_long_regime_orders;
drop trigger if exists leader20_clock_order_journal on public.v11_long_regime_orders;
alter table public.leader20_control drop constraint leader20_control_active_strategy_check;
alter table public.leader20_control add constraint leader20_control_active_strategy_check
 check(active_strategy in ('LEGACY','LEADER20_DYNAMIC_1','PAUSED','DETERMINISTIC_DYNAMIC_STATE_1'));
create table public.deterministic_control (
 singleton boolean primary key default true check(singleton),
 version text not null default 'DETERMINISTIC_DYNAMIC_STATE_1',
 enabled boolean not null default false,
 generation bigint not null default 1 check(generation>0),
 source_commit text,
 updated_at timestamptz not null default clock_timestamp()
);
insert into public.deterministic_control(singleton) values(true);
create table public.deterministic_decision_audit (
 id bigint generated always as identity primary key,
 symbol text not null,position_id uuid,
 observed_at timestamptz not null default clock_timestamp(),
 kind text not null,state text not null,decision text not null,
 evidence jsonb not null default '{}',timing jsonb not null default '{}'
);
create index deterministic_audit_symbol_time on public.deterministic_decision_audit(symbol,observed_at desc);
alter table public.deterministic_control enable row level security;
alter table public.deterministic_decision_audit enable row level security;
revoke all on public.deterministic_control,public.deterministic_decision_audit from public,anon,authenticated;
grant all on public.deterministic_control,public.deterministic_decision_audit to service_role;
grant usage,select on sequence public.deterministic_decision_audit_id_seq to service_role;

create or replace function public.deterministic_universe() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('generation',d.generation,'enabled',d.enabled,'epoch_id',c.epoch_id,
  'next_refresh_at',e.next_refresh_at,'members',coalesce(e.snapshot->'members','[]'::jsonb))
 from public.deterministic_control d cross join public.leader20_control c
 left join public.leader20_epochs e on e.id=c.epoch_id where d.singleton and c.singleton
$$;
create or replace function public.deterministic_publish_universe(p_snapshot jsonb,p_source_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare eid uuid; t timestamptz:=clock_timestamp();
begin
 perform pg_advisory_xact_lock(20261002,1);
 if jsonb_array_length(p_snapshot->'members')<>20 or length(p_source_hash)<>64
  or (p_snapshot->>'observed_at')::timestamptz>t or (p_snapshot->>'observed_at')::timestamptz<t-interval '10 seconds'
  or (select count(distinct x->>'symbol') from jsonb_array_elements(p_snapshot->'members') x)<>20
 then raise exception 'universe evidence invalid';end if;
 insert into public.leader20_epochs(scheduled_at,observed_at,effective_at,next_refresh_at,snapshot,source_hash)
 values((p_snapshot->>'requested_at')::timestamptz,(p_snapshot->>'observed_at')::timestamptz,t,
  (p_snapshot->>'next_refresh_at')::timestamptz,p_snapshot,p_source_hash) returning id into eid;
 insert into public.leader20_members(epoch_id,symbol,rank,price_change_percent,quote_volume)
 select eid,x->>'symbol',(x->>'rank')::integer,(x->>'price_change_percent')::numeric,(x->>'quote_volume')::numeric
 from jsonb_array_elements(p_snapshot->'members') x;
 update public.leader20_control set epoch_id=eid,updated_at=t where singleton;
 return public.deterministic_universe();
end $$;
create or replace function public.deterministic_entry_authority(p_signal_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.v11_long_regime_signals%rowtype;d public.deterministic_control%rowtype;
begin
 select * into d from public.deterministic_control where singleton;
 select * into s from public.v11_long_regime_signals where id=p_signal_id;
 if not found or not d.enabled or s.features#>>'{deterministic,version}' is distinct from d.version
  or (s.features#>>'{deterministic,generation}')::bigint is distinct from d.generation
  or s.features#>>'{deterministic,decision,decision}' is distinct from 'BUY'
  or s.status not in ('NEW','CLAIMED','ORDERED','FILLED')
  or not exists(select 1 from public.leader20_control c join public.leader20_members m on m.epoch_id=c.epoch_id
    join public.leader20_epochs e on e.id=m.epoch_id where c.singleton and m.symbol=s.symbol and m.rank<=20 and e.next_refresh_at>clock_timestamp())
 then return jsonb_build_object('allowed',false,'reason','DETERMINISTIC_OWNERSHIP_OR_UNIVERSE_INVALID');end if;
 return jsonb_build_object('allowed',true,'generation',d.generation);
end $$;
create or replace function public.deterministic_candidate(p_symbol text,p_bucket_ms bigint,p_features jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare sid uuid;d public.deterministic_control%rowtype;t timestamptz:=clock_timestamp();
begin
 select * into d from public.deterministic_control where singleton;
 if not d.enabled or p_features#>>'{deterministic,version}' is distinct from d.version or p_features#>>'{deterministic,decision,decision}' is distinct from 'BUY'
  or p_features#>>'{deterministic,decision,setup}' is distinct from 'PASS'
  or p_features#>>'{deterministic,decision,confirmation}' is distinct from 'PASS'
  or coalesce(p_features#>>'{deterministic,decision,trigger}','WAIT') not in ('BREAKOUT','PULLBACK_RECOVERY','LOCAL_HIGH_RECLAIM','MOMENTUM_REACCELERATION')
  or (p_features#>>'{deterministic,generation}')::bigint is distinct from d.generation
  or p_bucket_ms>extract(epoch from t)*1000 or extract(epoch from t)*1000-p_bucket_ms>=10000 then return jsonb_build_object('created',false,'reason','STATE_INVALID');end if;
 perform pg_advisory_xact_lock(hashtextextended('deterministic-symbol:'||p_symbol,0));
 if exists(select 1 from public.v11_long_regime_positions where symbol=p_symbol and (state='OPEN' or remaining_quantity>0))
  or exists(select 1 from public.v11_long_regime_orders where symbol=p_symbol and state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED','PARTIALLY_FILLED','UNKNOWN') and response_payload->>'v18ExposureFinal' is distinct from 'true')
  or exists(select 1 from public.v11_long_regime_signals where symbol=p_symbol and status in ('NEW','CLAIMED','ORDERED') and features#>>'{deterministic,version}'=d.version and created_at>t-interval '2 minutes')
 then return jsonb_build_object('created',false,'reason','SYMBOL_ALREADY_PENDING');end if;
 insert into public.v11_long_regime_signals(revision,lane,symbol,side,signal_bar_at,entry_bar_at,features,status,updated_at)
 values('V11-LONG-REGIME-1.0.1','BULL',p_symbol,'LONG',to_timestamp(p_bucket_ms::numeric/1000),to_timestamp(p_bucket_ms::numeric/1000),p_features,'NEW',t)
 on conflict (revision,lane,symbol,signal_bar_at) do nothing returning id into sid;
 if sid is not null then perform public.deterministic_wake_executor();end if;
 return jsonb_build_object('created',sid is not null,'id',sid);
end $$;
create or replace function public.deterministic_wake_executor() returns void
language plpgsql security definer set search_path='' as $$
declare token text;
begin
 select t.token into token from public.edge_internal_tokens t where name='v10-lane-executor';
 if token is null then raise exception 'executor authentication unavailable';end if;
 perform net.http_post(url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-executor',
  headers:=jsonb_build_object('Content-Type','application/json','x-v10-executor-token',token),body:='{"mode":"execute"}'::jsonb,timeout_milliseconds:=90000);
end $$;

-- Capture control, lease and causal row admission remain independent of audit/cold storage.
create or replace function public.doa_capture_rpc(p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql set search_path='' set lock_timeout='250ms' as $$
declare c doa_capture.control%rowtype;worker text:=p_body->>'worker_id';r jsonb;n int;sz bigint:=octet_length(p_body::text);archive_failed boolean:=false;safe_rows jsonb:='[]';row_value jsonb;row_at timestamptz;rejected int:=0;
begin
 if p_action='status' then select to_jsonb(x)-'lease_owner' into r from doa_capture.control x where id=1;return r;end if;
 select * into c from doa_capture.control where id=1 for update;
 if c.id is null or not c.enabled or now()<c.starts_at or (not c.production_enabled and now()>=c.ends_at) then return jsonb_build_object('enabled',false,'reason','DISABLED_OR_EXPIRED');end if;
 if worker is null or worker !~ '^[a-zA-Z0-9-]{8,80}$' then raise exception 'worker identity required';end if;
 if c.lease_owner is not null and c.lease_owner<>worker and c.lease_until>now() then return jsonb_build_object('enabled',false,'reason','LEASE_BUSY');end if;
 if sz>500000 then raise exception 'body cap';end if;
 update doa_capture.control set lease_owner=worker,lease_until=now()+interval '90 seconds',heartbeat_at=now(),live_requests=live_requests+1 where id=1;
 if p_action='watch' then
  select jsonb_build_object('enabled',true,'production_enabled',c.production_enabled,'ends_at',case when c.production_enabled then now()+interval '14 days' else c.ends_at end,
   'protocol_sha256',c.protocol_sha256,'windows','[]'::jsonb,'watch',coalesce(jsonb_agg(x order by priority,symbol),'[]'::jsonb)) into r from (
   select symbol,min(priority) priority,true candles,jsonb_agg(distinct role) roles from (
    select m.symbol,2 priority,'SCANNER_LEADER' role from public.leader20_control l join public.leader20_members m on m.epoch_id=l.epoch_id where l.singleton and m.rank<=20
    union all select p.symbol,0,'OPEN_POSITION' from public.v11_long_regime_positions p where p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'
    union all select 'BTCUSDT',1,'MARKET_SENSOR'
   ) s group by symbol
  ) x;
  return r;
 elsif p_action='ingest' then
  if jsonb_typeof(p_body->'rows') is distinct from 'array' or jsonb_array_length(p_body->'rows')>600 then raise exception 'row cap';end if;
  if exists(select 1 from doa_capture.batches where id=(p_body->>'batch_id')::uuid) then return jsonb_build_object('enabled',true,'duplicate',true);end if;
  if (select count(distinct x->>'symbol') from jsonb_array_elements(p_body->'rows') x)>48 then raise exception 'symbol cap';end if;
  for row_value in select value from jsonb_array_elements(p_body->'rows') loop
   begin
    row_at:=(row_value->>'at')::timestamptz;
    if row_at is null or row_at<c.starts_at-interval '2 minutes' or row_at>now()+interval '5 seconds'
     or coalesce(upper(btrim(row_value->>'symbol')),'') !~ '^[A-Z0-9]{2,30}USDT$'
     or row_value->>'kind' is distinct from 'micro' or jsonb_typeof(row_value->'payload') is distinct from 'object'
     then rejected:=rejected+1;continue;end if;
    safe_rows:=safe_rows||jsonb_build_array(row_value);
   exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then rejected:=rejected+1;
   end;
  end loop;
  insert into doa_capture.live_micro(kind,symbol,at,payload)
   select 'micro',upper(btrim(x->>'symbol')),(x->>'at')::timestamptz,x->'payload' from jsonb_array_elements(safe_rows) x where x->>'kind'='micro' on conflict do nothing;
  get diagnostics n=row_count;
  delete from doa_capture.live_micro where at<now()-interval '10 minutes';
  delete from doa_capture.batches where created_at<now()-interval '2 days';
  insert into doa_capture.batches(id) values((p_body->>'batch_id')::uuid);
  -- One batch archive write, compact bucket payloads only; failure does not roll back hot truth.
  begin
   if pg_total_relation_size('public.leader20_micro_archive')<(select archive_max_bytes from public.leader20_control where singleton) then
    insert into public.leader20_micro_archive(symbol,at,received_at,payload)
     select symbol,at,received_at,payload from doa_capture.live_micro m where exists(select 1 from jsonb_array_elements(safe_rows) x where x->>'kind'='micro' and x->>'symbol'=m.symbol and (x->>'at')::timestamptz=m.at) on conflict do nothing;
   else archive_failed:=true;end if;
  exception when others then archive_failed:=true;end;
  update doa_capture.control set live_bytes_ingested=live_bytes_ingested+sz,metrics=coalesce(p_body->'metrics','{}')||jsonb_build_object('deterministic_archive_degraded',archive_failed,'deterministic_rejected_rows',rejected) where id=1;
  return jsonb_build_object('enabled',true,'inserted',n,'rejected_rows',rejected,'archive_degraded',archive_failed);
 end if;
 raise exception 'invalid capture action';
end $$;

CREATE OR REPLACE FUNCTION public.deterministic_capture_raw(p_symbol text, p_as_of timestamp with time zone, p_position_id uuid, p_cutoff timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with ctl as (
  select enabled,production_enabled,ends_at,heartbeat_at
  from doa_capture.control where id=1
),
raw as (
 select o.at,o.received_at,o.payload,row_number() over(order by o.at desc) rn
 from doa_capture.live_micro o
 where o.kind='micro' and o.symbol=upper(btrim(p_symbol))
 and o.at<=p_cutoff and o.at>p_cutoff-interval '155 seconds'
),
last25 as (select * from raw where rn<=25),
ordered as (
  select at,received_at,payload,rn,
    lag(at) over(order by at) as previous_at,
    lag((payload->>'interval_end')::timestamptz) over(order by at) as previous_end,
    lag((payload->>'mid')::numeric) over(order by at) as prev_mid,
    lag((payload->>'spread_bps')::numeric) over(order by at) as prev_spread,
    lag((payload->>'ask_25_usdt')::numeric) over(order by at) as prev_ask25,
    lag((payload->>'bid_25_usdt')::numeric) over(order by at) as prev_bid25,
    lag(case when coalesce((payload->>'buy_quote_5s')::numeric,0)+coalesce((payload->>'sell_quote_5s')::numeric,0)>0
      then (payload->>'buy_quote_5s')::numeric /
        ((payload->>'buy_quote_5s')::numeric+(payload->>'sell_quote_5s')::numeric) end) over(order by at) as prev_buy_share,
    lag(coalesce((payload->>'buy_quote_5s')::numeric,0)-coalesce((payload->>'sell_quote_5s')::numeric,0)) over(order by at) as prev_net_flow,
    lag(case when (payload->>'mid')::numeric>0 and (payload->>'buy_vwap_450')::numeric>0
      then ((payload->>'buy_vwap_450')::numeric/(payload->>'mid')::numeric-1)*10000 end) over(order by at) as prev_buy_impact,
    lag(case when (payload->>'mid')::numeric>0 and (payload->>'sell_vwap_450')::numeric>0
      then (1-(payload->>'sell_vwap_450')::numeric/(payload->>'mid')::numeric)*10000 end) over(order by at) as prev_sell_impact
  from last25
),
stats as (
  select count(*) as n,min(at) as min_at,max(at) as max_at,
    min((payload->>'interval_start')::timestamptz) as window_start,
    max((payload->>'interval_end')::timestamptz) as window_end,
    max(received_at) as newest_received,
    bool_and(previous_at is null or at-previous_at=interval '5 seconds') as contiguous,
    bool_and(previous_end is null or abs(extract(epoch from ((payload->>'interval_start')::timestamptz-previous_end)))<=0.001) as intervals_contiguous
  from ordered where rn<=24
),
validity as (
 select bool_and(
  received_at<=p_as_of and at<=p_as_of and
  (payload->>'interval_end')::timestamptz<=p_as_of and
  abs(extract(epoch from ((payload->>'interval_end')::timestamptz-at)))<1 and
  extract(epoch from ((payload->>'interval_end')::timestamptz-(payload->>'interval_start')::timestamptz))*1000=(payload->>'interval_ms')::integer and
  (payload->>'interval_ms')::integer between 4000 and 6500 and
  coalesce((payload->>'bucket_complete')::boolean,false) and
  coalesce((payload->>'book_complete')::boolean,false) and
  coalesce((payload->>'trade_sequence_complete')::boolean,false) and
  coalesce((payload->>'coverage_25')::boolean,false) and
  coalesce((payload->>'flow_causal')::boolean,false) and
  (payload->>'trade_count')::integer>=0 and
  ((payload->>'trade_count')::integer=0 or (
    payload->>'trade_event_at' is not null and payload->>'trade_received_at' is not null and
    (payload->>'trade_event_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz>(payload->>'interval_start')::timestamptz
  )) and
  (payload->>'mid')::numeric>0 and
  payload ? 'exchange_at' and payload ? 'received_at' and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000) is not null and (extract(epoch from (payload->>'received_at')::timestamptz)*1000) is not null and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)-1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)-(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=10000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=extract(epoch from at)*1000-10000
 ) as valid from ordered
),
points as (
 select jsonb_agg(
   jsonb_build_object(
     'flow_event_ms',floor(extract(epoch from (payload->>'trade_event_at')::timestamptz)*1000),
     'flow_received_at_ms',floor(extract(epoch from (payload->>'trade_received_at')::timestamptz)*1000),
     'bucket_ms',floor(extract(epoch from at)*1000),
     'start_ms',floor(extract(epoch from (payload->>'interval_start')::timestamptz)*1000),
     'received_at_ms',floor(extract(epoch from received_at)*1000),
     'exchange_event_ms',(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000),
     'book_received_at_ms',(extract(epoch from (payload->>'received_at')::timestamptz)*1000),
     'mid',(payload->>'mid')::numeric,
     'start_mid',case when previous_at=at-interval '5 seconds' then prev_mid end,
     'aggressive_buy',(payload->>'buy_quote_5s')::numeric,
     'aggressive_sell',(payload->>'sell_quote_5s')::numeric,
     'end_ms',floor(extract(epoch from (payload->>'interval_end')::timestamptz)*1000),
     'd_mid_bps',case when prev_mid>0 then (((payload->>'mid')::numeric/prev_mid)-1)*10000 end,
     'd_spread_bps',case when prev_spread is not null then (payload->>'spread_bps')::numeric-prev_spread end,
     'd_ask_depth_25_pct',case when prev_ask25>0 then ((payload->>'ask_25_usdt')::numeric/prev_ask25)-1 end,
     'd_bid_depth_25_pct',case when prev_bid25>0 then ((payload->>'bid_25_usdt')::numeric/prev_bid25)-1 end,
     'buy_share_5s',case when coalesce((payload->>'buy_quote_5s')::numeric,0)+coalesce((payload->>'sell_quote_5s')::numeric,0)>0
       then (payload->>'buy_quote_5s')::numeric /
         ((payload->>'buy_quote_5s')::numeric+(payload->>'sell_quote_5s')::numeric) end,
     'd_buy_share',case when prev_buy_share is not null then
       ((payload->>'buy_quote_5s')::numeric /
        nullif((payload->>'buy_quote_5s')::numeric+(payload->>'sell_quote_5s')::numeric,0))-prev_buy_share end,
     'net_taker_quote_5s',coalesce((payload->>'buy_quote_5s')::numeric,0)-coalesce((payload->>'sell_quote_5s')::numeric,0),
     'd_net_taker_quote',case when prev_net_flow is not null then
       (coalesce((payload->>'buy_quote_5s')::numeric,0)-coalesce((payload->>'sell_quote_5s')::numeric,0))-prev_net_flow end,
     'trade_count',nullif(payload->>'trade_count','')::numeric,
     'arrival_rate',nullif(payload->>'trade_count','')::numeric / nullif((payload->>'interval_ms')::numeric/1000,0),
     'aggressive_notional',coalesce((payload->>'buy_quote_5s')::numeric,0)+coalesce((payload->>'sell_quote_5s')::numeric,0),
     'bid_book_net_5s',case when payload ? 'displayed_bid_added_5s' and payload ? 'displayed_bid_removed_5s'
       then (payload->>'displayed_bid_added_5s')::numeric-(payload->>'displayed_bid_removed_5s')::numeric end,
     'spread_bps',(payload->>'spread_bps')::numeric,
     'bid_depth_25_usdt',(payload->>'bid_25_usdt')::numeric,
     'ask_depth_25_usdt',(payload->>'ask_25_usdt')::numeric,
     'imbalance',((payload->>'bid_25_usdt')::numeric-(payload->>'ask_25_usdt')::numeric)/
       nullif((payload->>'bid_25_usdt')::numeric+(payload->>'ask_25_usdt')::numeric,0),
     'btc_return_1m',(payload->>'btc_return_1m')::numeric,
     'ask_book_net_5s',coalesce((payload->>'displayed_ask_added_5s')::numeric,0)-coalesce((payload->>'displayed_ask_removed_5s')::numeric,0),
     'buy_impact_450_bps',case when (payload->>'mid')::numeric>0 and (payload->>'buy_vwap_450')::numeric>0
       then ((payload->>'buy_vwap_450')::numeric/(payload->>'mid')::numeric-1)*10000 end,
     'd_buy_impact_bps',case when prev_buy_impact is not null then
       (((payload->>'buy_vwap_450')::numeric/(payload->>'mid')::numeric-1)*10000)-prev_buy_impact end,
     'sell_impact_450_bps',case when (payload->>'mid')::numeric>0 and (payload->>'sell_vwap_450')::numeric>0
       then (1-(payload->>'sell_vwap_450')::numeric/(payload->>'mid')::numeric)*10000 end,
     'd_sell_impact_bps',case when prev_sell_impact is not null then
       ((1-(payload->>'sell_vwap_450')::numeric/(payload->>'mid')::numeric)*10000)-prev_sell_impact end
   ) order by at
 ) as trajectory
 from ordered where rn<=24
)
select case
 when not exists(select 1 from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','UNWATCHED')
 when not (select enabled and (production_enabled or now()<ends_at) from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
 when (select heartbeat_at from ctl)>clock_timestamp()+interval '1 second' or (select heartbeat_at from ctl)<clock_timestamp()-interval '25 seconds'
   then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when upper(btrim(p_symbol)) !~ '^[[:alnum:]]{1,24}USDT$' then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_SYMBOL')
 when p_position_id is not null and not exists(select 1 from public.v11_long_regime_positions p where p.id=p_position_id and p.symbol=upper(btrim(p_symbol)) and p.state='OPEN')
   then jsonb_build_object('status','UNAVAILABLE','reason','POSITION_NOT_OPEN_OR_MISMATCH')
 when exists(select 1 from doa_capture.live_micro o where o.symbol=upper(btrim(p_symbol)) and o.at>p_as_of and o.at<=p_as_of+interval '10 seconds' and o.received_at<=p_as_of)
   then jsonb_build_object('status','UNAVAILABLE','reason','FUTURE_BUCKET')
 when (select n from stats)<>24 then jsonb_build_object('status','UNAVAILABLE','reason','INCOMPLETE_TRAJECTORY')
 when (select valid from validity) is distinct from true then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_OR_NONCAUSAL_BUCKET')
 when not (select contiguous and intervals_contiguous from stats) then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 when (select window_end from stats)<p_cutoff-interval '25 seconds' then jsonb_build_object('status','UNAVAILABLE','reason','STALE_BUCKET')
 when extract(epoch from ((select max_at from stats)-(select min_at from stats))) <>115
   then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 else jsonb_build_object(
   'version','CAPTURE-CONTEXT-3-TRAJECTORY-120S',
   'status','AVAILABLE',
   'buckets',24,'coverage_policy','ALL_24_REQUIRED','position_id',p_position_id,
   'start_ms',floor(extract(epoch from (select window_start from stats))*1000),
   'end_ms',floor(extract(epoch from (select window_end from stats))*1000),
   'ingested_at_ms',floor(extract(epoch from (select newest_received from stats))*1000),
   'trajectory',(select trajectory from points)
 )
end
$function$;

;
revoke all on function public.deterministic_capture_raw(text,timestamptz,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.deterministic_capture_raw(text,timestamptz,uuid,timestamptz) to service_role;

create or replace function public.deterministic_market_context(p_symbols text[],p_as_of timestamptz,p_position_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb:='{}';s text;item jsonb;
begin
 if p_symbols is null or cardinality(p_symbols) not between 1 and 48 or p_as_of is null
  or exists(select 1 from unnest(p_symbols) x where x is null or x !~ '^[[:alnum:]]{1,24}USDT$')
  or p_as_of>clock_timestamp()+interval '1 second' or p_as_of<clock_timestamp()-interval '10 seconds' then raise exception 'context bounds';end if;
 foreach s in array p_symbols loop
  begin item:=public.deterministic_capture_raw(s,p_as_of,p_position_id,p_as_of);
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
   item:=jsonb_build_object('status','UNAVAILABLE','reason','MALFORMED_SYMBOL_CAPTURE');
  end;
  r:=r||jsonb_build_object(s,item);
 end loop;
 return coalesce(r,'{}');
end $$;

revoke all on function public.deterministic_universe(),public.deterministic_publish_universe(jsonb,text),public.deterministic_entry_authority(uuid),public.deterministic_candidate(text,bigint,jsonb),public.deterministic_wake_executor(),public.deterministic_market_context(text[],timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.deterministic_universe(),public.deterministic_publish_universe(jsonb,text),public.deterministic_entry_authority(uuid),public.deterministic_candidate(text,bigint,jsonb),public.deterministic_wake_executor(),public.deterministic_market_context(text[],timestamptz,uuid) to service_role;
CREATE OR REPLACE FUNCTION public.deterministic_reserve_entry_slot(p_symbol text, p_slot_ms bigint, p_signal_id uuid, p_expires_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare sym text:=upper(btrim(coalesce(p_symbol,'')));cap jsonb;r public.leader20_entry_reservations%rowtype;
 deadline timestamptz:=coalesce(p_expires_at,clock_timestamp()+interval '120 seconds');
begin
 if sym !~ '^[[:alnum:]]{1,24}USDT$' then return jsonb_build_object('reserved',false,'reason','INVALID_SYMBOL');end if;
 perform pg_advisory_xact_lock(20260928,52);
 perform public.leader20_entry_reservation_sweep();
 if deadline<=clock_timestamp() then return jsonb_build_object('reserved',false,'reason','RESERVATION_WINDOW_EXPIRED');end if;
 cap:=public.leader20_batch_capacity();
 if coalesce(cap->>'certain','false')<>'true' then
  return jsonb_build_object('reserved',false,'reason',coalesce(cap->>'reason','CAPACITY_UNCERTAIN'),'capacity',cap);end if;
 -- one symbol = one open position
 if cap->'held' ? sym then return jsonb_build_object('reserved',false,'reason','SYMBOL_ALREADY_HELD','capacity',cap);end if;
 if coalesce((cap->>'available_for_new_entry')::integer,0)<1 then
  return jsonb_build_object('reserved',false,'reason','NO_ENTRY_CAPACITY','capacity',cap);end if;
 insert into public.leader20_entry_reservations(symbol,slot_ms,signal_id,expires_at)
 values(sym,p_slot_ms,p_signal_id,deadline) returning * into r;
 return jsonb_build_object('reserved',true,'id',r.id,'symbol',sym,'expires_at',r.expires_at,
  'available_for_new_entry_before',(cap->>'available_for_new_entry')::integer,
  'available_for_new_entry_after',greatest(0,(cap->>'available_for_new_entry')::integer-1),'capacity',cap);
end $function$;

revoke all on function public.deterministic_reserve_entry_slot(text,bigint,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.deterministic_reserve_entry_slot(text,bigint,uuid,timestamptz) to service_role;

-- Replace the provider-bound submit proof without adding a second order outbox.
-- The durable existing order identity, current state and account generation fence
-- are mandatory. Losing the acknowledgement is a PRE_SEND refusal.
create or replace function public.deterministic_begin_submit(p_order_id uuid,p_owner uuid,p_state jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.v11_long_regime_orders%rowtype;l public.v17_execution_lease%rowtype;
 a jsonb;t timestamptz:=clock_timestamp();stamp jsonb;
begin
 if public.v17_verify_execution_lease(p_owner) is distinct from true then return jsonb_build_object('updated',false,'reason','WRITER_FENCED');end if;
 select * into l from public.v17_execution_lease where singleton and owner=p_owner;
 if (public.v17_account_recovery_state()->>'ready') is distinct from 'true' then return jsonb_build_object('updated',false,'reason','RECONCILIATION_FIRST_ENTRY_FROZEN');end if;
 select * into o from public.v11_long_regime_orders where id=p_order_id for update;
 if o.id is null or o.intent<>'OPEN_LONG' or o.state<>'PLANNED' or o.exchange_order_id is not null
  or o.request_payload#>>'{deterministic,version}' is distinct from 'DETERMINISTIC_DYNAMIC_STATE_1'
  then return jsonb_build_object('updated',false,'reason','ORDER_IDENTITY_NOT_PLANNED');end if;
 a:=public.deterministic_entry_authority(o.signal_id);
 if a->>'allowed' is distinct from 'true' or p_state->>'version' is distinct from 'DETERMINISTIC_DYNAMIC_STATE_1'
  or p_state->>'decision' is distinct from 'BUY' or p_state->>'setup' is distinct from 'PASS'
  or p_state->>'confirmation' is distinct from 'PASS'
  or coalesce(p_state->>'trigger','WAIT') not in ('BREAKOUT','PULLBACK_RECOVERY','LOCAL_HIGH_RECLAIM','MOMENTUM_REACCELERATION')
  or coalesce(p_state->>'at','') !~ '^[0-9]+$' or coalesce(p_state->>'capture_end_ms','') !~ '^[0-9]+$'
  then return jsonb_build_object('updated',false,'reason','CURRENT_STATE_NOT_EXECUTABLE');end if;
 if to_timestamp((p_state->>'at')::numeric/1000)>t or t-to_timestamp((p_state->>'at')::numeric/1000)>=interval '3 seconds'
  or to_timestamp((p_state->>'capture_end_ms')::numeric/1000)>t
  or t-to_timestamp((p_state->>'capture_end_ms')::numeric/1000)>=interval '10 seconds'
  then return jsonb_build_object('updated',false,'reason','CURRENT_STATE_STALE');end if;
 if not exists(select 1 from public.leader20_entry_reservations r where r.signal_id=o.signal_id and r.symbol=o.symbol
  and r.state in ('RESERVED','ORDER_PENDING') and r.expires_at>t) then return jsonb_build_object('updated',false,'reason','CAPACITY_RESERVATION_MISSING');end if;
 if o.request_payload->>'entry_ioc_attempt'='2' and not exists(
  select 1 from public.v11_long_regime_orders first_order where first_order.id::text=o.request_payload->>'retry_of_order_id'
   and first_order.signal_id=o.signal_id and first_order.state in ('EXPIRED','CANCELED','REJECTED','PARTIALLY_FILLED_CANCELED')
   and first_order.response_payload#>>'{v22EntryFinality,finalStatus}' in ('EXPIRED','CANCELED','CANCELLED','REJECTED','PARTIALLY_FILLED_CANCELED')
  ) then return jsonb_build_object('updated',false,'reason','PRIOR_ORDER_RECONCILIATION_REQUIRED');end if;
 stamp:=jsonb_build_object('version','DETERMINISTIC_DYNAMIC_STATE_1','owner',l.owner,'fence',l.fence,
  'postmaster_at',pg_postmaster_start_time(),'submitted_at',t,'state_at_ms',p_state->'at',
  'capture_end_ms',p_state->'capture_end_ms','generation',a->'generation');
 update public.v11_long_regime_orders set response_payload=response_payload||jsonb_build_object('deterministic_submission',stamp),updated_at=t where id=o.id;
 return jsonb_build_object('updated',true,'order_id',o.id,'proof',stamp);
end $$;

create or replace function public.v17_gateway_authorize(p_key text,p_account text,p_owner uuid,p_fence bigint,p_command jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.v11_long_regime_orders%rowtype;stamp jsonb;
begin
 if p_account is distinct from 'binance_futures:futures' or p_key is null or length(p_key)<16
  or p_command->>'exchange' is distinct from 'binance_futures' then return false;end if;
 if not exists(select 1 from public.v17_execution_lease where singleton and owner=p_owner and fence=p_fence
  and postmaster_started_at=pg_postmaster_start_time() and expires_at>clock_timestamp()+interval '30 seconds') then return false;end if;
 if p_command->>'action'='create_order' and upper(p_command#>>'{order,side}')='BUY' then
  select * into o from public.v11_long_regime_orders where client_order_id=p_command#>>'{order,identifier}' and intent='OPEN_LONG' and state='PLANNED';
  if o.id is null or o.symbol is distinct from p_command#>>'{order,market}'
   or o.requested_quantity is distinct from (p_command#>>'{order,quantity}')::numeric
   or o.request_payload->'order' is distinct from p_command->'order'
   or o.request_payload->'leverage' is distinct from p_command->'leverage' then return false;end if;
  stamp:=o.response_payload->'deterministic_submission';
  return stamp->>'version'='DETERMINISTIC_DYNAMIC_STATE_1' and stamp->>'owner'=p_owner::text
   and (stamp->>'fence')::bigint=p_fence and (stamp->>'postmaster_at')::timestamptz=pg_postmaster_start_time()
   and (stamp->>'submitted_at')::timestamptz>clock_timestamp()-interval '3 seconds'
   and to_timestamp((stamp->>'capture_end_ms')::numeric/1000)>clock_timestamp()-interval '10 seconds'
   and public.deterministic_entry_authority(o.signal_id)->>'allowed'='true';
 end if;
 if p_command->>'action'='create_order' then return upper(p_command#>>'{order,side}')='SELL'
  and upper(p_command#>>'{order,position_effect}')='CLOSE';end if;
 return p_command->>'action' in ('cancel_order','v17_create_stop','v17_cancel_stop');
end $$;
revoke all on function public.deterministic_begin_submit(uuid,uuid,jsonb),public.v17_gateway_authorize(text,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.deterministic_begin_submit(uuid,uuid,jsonb),public.v17_gateway_authorize(text,text,uuid,bigint,jsonb) to service_role;
