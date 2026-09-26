-- BTC market sensor: separate causal contract; trade V3 definition is intentionally untouched.
begin;
CREATE OR REPLACE FUNCTION public.doa_market_sensor_context_v1(p_symbol text, p_as_of timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with ctl as (
  select enabled,gpt_context_enabled,production_enabled,ends_at,heartbeat_at
  from doa_capture.control where id=1
),
raw as (
 select o.at,o.received_at,o.payload,row_number() over(order by o.at desc) rn
 from doa_capture.live_micro o
 where o.kind='micro' and o.symbol=upper(btrim(p_symbol))
 and o.at<=p_as_of and o.at>p_as_of-interval '155 seconds'
),
last25 as (select * from raw where rn<=25),
ordered as (
  select at,received_at,payload,rn,
    lag(at) over(order by at) as previous_at,
    lag((payload->>'interval_end')::timestamptz) over(order by at) as previous_end,
    lag((payload->>'mid')::numeric) over(order by at) as prev_mid
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
 select bool_and(coalesce(
  received_at>= (payload->>'interval_end')::timestamptz and received_at<=p_as_of and at<=p_as_of and
  (payload->>'interval_end')::timestamptz<=p_as_of and
  abs(extract(epoch from ((payload->>'interval_end')::timestamptz-at)))<1 and
  extract(epoch from ((payload->>'interval_end')::timestamptz-(payload->>'interval_start')::timestamptz))*1000=(payload->>'interval_ms')::integer and
  (payload->>'interval_ms')::integer between 4000 and 6500 and
  coalesce((payload->>'bucket_complete')::boolean,false) and
  coalesce((payload->>'book_complete')::boolean,false) and
  coalesce((payload->>'trade_sequence_complete')::boolean,false) and
  coalesce((payload->>'btc_candle_complete')::boolean,false) and
  (payload->>'btc_return_1m')::numeric is not null and
  (payload->>'btc_candle_end_ms')::bigint <= extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  extract(epoch from (payload->>'interval_end')::timestamptz)*1000-(payload->>'btc_candle_end_ms')::bigint between 0 and 65000 and
  (payload->>'btc_candle_end_ms')::bigint-extract(epoch from (payload->>'btc_candle_at')::timestamptz)*1000=60000 and
  (payload->>'btc_candle_exchange_ms')::bigint >= (payload->>'btc_candle_end_ms')::bigint-1 and
  (payload->>'btc_candle_exchange_ms')::bigint <= extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (payload->>'btc_candle_received_ms')::bigint <= extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (payload->>'btc_candle_received_ms')::bigint-(payload->>'btc_candle_exchange_ms')::bigint between -1000 and 10000 and
  (payload->>'best_bid')::numeric>0 and (payload->>'best_ask')::numeric>=(payload->>'best_bid')::numeric and
  (payload->>'observed_bid_depth_usdt')::numeric>=0 and (payload->>'observed_ask_depth_usdt')::numeric>=0 and
  (payload->>'depth_bid_coverage_bps')::numeric between 0 and 25 and (payload->>'depth_ask_coverage_bps')::numeric between 0 and 25 and
  (payload->>'depth_coverage_complete')::boolean is not null and
  (not (payload->>'depth_coverage_complete')::boolean or least((payload->>'depth_bid_coverage_bps')::numeric,(payload->>'depth_ask_coverage_bps')::numeric)=25) and
  (payload->>'buy_quote_5s')::numeric>=0 and (payload->>'sell_quote_5s')::numeric>=0 and
  (payload->>'depth_bid_boundary')::numeric>0 and (payload->>'depth_ask_boundary')::numeric>0 and
  coalesce((payload->>'flow_causal')::boolean,false) and
  (payload->>'trade_count')::integer>=0 and
  ((payload->>'trade_count')::integer=0 or (
    payload->>'trade_event_at' is not null and payload->>'trade_received_at' is not null and
    (payload->>'trade_event_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz>(payload->>'interval_start')::timestamptz and
    extract(epoch from ((payload->>'trade_received_at')::timestamptz-(payload->>'trade_event_at')::timestamptz))*1000 between -1000 and 10000
  )) and
  (payload->>'mid')::numeric>0 and
  payload ? 'exchange_at' and payload ? 'received_at' and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000) is not null and (extract(epoch from (payload->>'received_at')::timestamptz)*1000) is not null and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)-1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)-(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=10000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=extract(epoch from at)*1000-10000
 ,false)) as valid from ordered
),
points as (select jsonb_agg(jsonb_build_object(
'bucket_ms',floor(extract(epoch from at)*1000),
'start_ms',floor(extract(epoch from (payload->>'interval_start')::timestamptz)*1000),
'end_ms',floor(extract(epoch from (payload->>'interval_end')::timestamptz)*1000),
'received_at_ms',floor(extract(epoch from received_at)*1000),
'exchange_event_ms',floor(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000),
'book_received_at_ms',floor(extract(epoch from (payload->>'received_at')::timestamptz)*1000),
'flow_event_ms',floor(extract(epoch from (payload->>'trade_event_at')::timestamptz)*1000),
'flow_received_at_ms',floor(extract(epoch from (payload->>'trade_received_at')::timestamptz)*1000),
'start_mid',prev_mid,
'd_mid_bps',case when prev_mid>0 then ((payload->>'mid')::numeric/prev_mid-1)*10000 end,
'taker_buy_quote_5s',(payload->>'buy_quote_5s')::numeric,
'taker_sell_quote_5s',(payload->>'sell_quote_5s')::numeric,
'arrival_rate',(payload->>'trade_count')::numeric/nullif((payload->>'interval_ms')::numeric/1000,0),
'observed_imbalance',((payload->>'observed_bid_depth_usdt')::numeric-(payload->>'observed_ask_depth_usdt')::numeric)/nullif((payload->>'observed_bid_depth_usdt')::numeric+(payload->>'observed_ask_depth_usdt')::numeric,0),
'mid',(payload->>'mid')::numeric,
'best_bid',(payload->>'best_bid')::numeric,
'best_ask',(payload->>'best_ask')::numeric,
'spread_bps',(payload->>'spread_bps')::numeric,
'trade_count',(payload->>'trade_count')::numeric,
'btc_return_1m',(payload->>'btc_return_1m')::numeric,
'btc_candle_end_ms',(payload->>'btc_candle_end_ms')::numeric,
'btc_candle_exchange_ms',(payload->>'btc_candle_exchange_ms')::numeric,
'btc_candle_received_ms',(payload->>'btc_candle_received_ms')::numeric,
'observed_bid_depth_usdt',(payload->>'observed_bid_depth_usdt')::numeric,
'observed_ask_depth_usdt',(payload->>'observed_ask_depth_usdt')::numeric,
'depth_bid_coverage_bps',(payload->>'depth_bid_coverage_bps')::numeric,
'depth_ask_coverage_bps',(payload->>'depth_ask_coverage_bps')::numeric,
'depth_bid_boundary',(payload->>'depth_bid_boundary')::numeric,
'depth_ask_boundary',(payload->>'depth_ask_boundary')::numeric,
'bucket_complete',(payload->>'bucket_complete')::boolean,
'book_complete',(payload->>'book_complete')::boolean,
'trade_sequence_complete',(payload->>'trade_sequence_complete')::boolean,
'flow_causal',(payload->>'flow_causal')::boolean,
'btc_candle_complete',(payload->>'btc_candle_complete')::boolean,
'depth_coverage_complete',(payload->>'depth_coverage_complete')::boolean
) order by at) trajectory from ordered where rn<=24)
select case
 when not exists(select 1 from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','UNWATCHED')
 when not (select enabled and gpt_context_enabled and (production_enabled or now()<ends_at) from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
 when (select heartbeat_at from ctl)>clock_timestamp()+interval '1 second' or (select heartbeat_at from ctl)<clock_timestamp()-interval '25 seconds'
   then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when upper(btrim(p_symbol)) <> 'BTCUSDT' or p_symbol is null then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_SYMBOL')
 when p_as_of>clock_timestamp() or p_as_of is null then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when exists(select 1 from doa_capture.live_micro o where o.symbol=upper(btrim(p_symbol)) and o.at>p_as_of and o.at<=p_as_of+interval '10 seconds' and o.received_at<=p_as_of)
   then jsonb_build_object('status','UNAVAILABLE','reason','FUTURE_BUCKET')
 when (select count(*) from last25)<>25 or (select n from stats)<>24 then jsonb_build_object('status','UNAVAILABLE','reason','INCOMPLETE_TRAJECTORY')
 when (select valid from validity) is distinct from true then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_OR_NONCAUSAL_BUCKET')
 when not (select contiguous and intervals_contiguous from stats) then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 when (select window_end from stats)<p_as_of-interval '25 seconds' then jsonb_build_object('status','UNAVAILABLE','reason','STALE_BUCKET')
 when extract(epoch from ((select max_at from stats)-(select min_at from stats))) <>115
   then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 else jsonb_build_object(
   'version','MARKET_SENSOR_CONTEXT_V1','contract','MARKET_SENSOR_CONTEXT_V1','symbol','BTCUSDT','role','MARKET_SENSOR','as_of_ms',floor(extract(epoch from p_as_of)*1000),
   'status','AVAILABLE',
   'buckets',24,'coverage_policy','ALL_24_REQUIRED','depth_semantics','OBSERVED_WITHIN_SNAPSHOT_AND_25BP_INTERSECTION_NO_EXTRAPOLATION',
   'start_ms',floor(extract(epoch from (select window_start from stats))*1000),
   'end_ms',floor(extract(epoch from (select window_end from stats))*1000),
   'ingested_at_ms',floor(extract(epoch from (select newest_received from stats))*1000),
   'market_sensor_trajectory',(select trajectory from points)
 )
end
$function$;
CREATE OR REPLACE FUNCTION public.doa_capture_rpc(p_action text, p_body jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '250ms'
AS $function$
declare c doa_capture.control%rowtype; owner_id text; n integer; sz bigint; physical bigint; out_json jsonb;
begin
 if p_action='status' then
   select to_jsonb(x)-'lease_owner' into out_json from doa_capture.control x where id=1;
   return out_json;
 end if;
 select * into c from doa_capture.control where id=1 for update;
 if c.id is null or not c.enabled or now()<c.starts_at or (not c.production_enabled and now()>=c.ends_at) then return jsonb_build_object('enabled',false,'reason','DISABLED_OR_EXPIRED');end if;
 owner_id:=p_body->>'worker_id';
 if owner_id is null or owner_id !~ '^[a-zA-Z0-9-]{8,80}$' then raise exception 'worker identity required';end if;
 if c.lease_owner is not null and c.lease_owner<>owner_id and c.lease_until>now() then return jsonb_build_object('enabled',false,'reason','LEASE_BUSY');end if;
 sz:=octet_length(p_body::text);
 if sz>500000 then raise exception 'body cap';end if;
 select coalesce(sum(pg_catalog.pg_total_relation_size(cl.oid)),0) into physical from pg_catalog.pg_class cl join pg_catalog.pg_namespace ns on ns.oid=cl.relnamespace where ns.nspname='doa_capture' and cl.relkind='r';
 if physical>=1200000000 or (not c.production_enabled and (c.requests>=200000 or c.bytes_reserved+sz>500000000)) then
   update doa_capture.control set enabled=false,metrics=jsonb_build_object('stop_reason','CAP_REACHED') where id=1;
   return jsonb_build_object('enabled',false,'reason','CAP_REACHED');
 end if;
 update doa_capture.control set requests=least(requests+1,200000),live_requests=live_requests+1,lease_owner=owner_id,lease_until=now()+interval '90 seconds',heartbeat_at=now() where id=1;
 if p_action='watch' then
   select count(*) into n from doa_capture.candidates;
   insert into doa_capture.candidates(signal_id,symbol,candidate_at,status,split)
   select s.id,s.symbol,s.created_at,s.status,case when s.created_at<c.starts_at+interval '4 days' then 'DEV' when s.created_at<c.starts_at+interval '9 days' then 'VALIDATION' else 'TEST' end
   from public.v11_long_regime_signals s where s.created_at>=c.starts_at and s.created_at<c.ends_at
   and s.features->>'strategy'='LEADER_MOMENTUM_V17' and not exists(select 1 from doa_capture.candidates d where d.signal_id=s.id)
   order by s.created_at,s.id limit greatest(0,2000-n);
   update doa_capture.candidates d set status=s.status,position_id=p.id,fill_at=p.entry_at,entry_price=p.entry_price,executor_patch=p.metadata->>'executorPatch'
   from public.v11_long_regime_signals s left join public.v11_long_regime_positions p on p.signal_id=s.id
   where d.signal_id=s.id and (d.status is distinct from s.status or d.position_id is distinct from p.id);
   return jsonb_build_object('enabled',true,'production_enabled',c.production_enabled,'ends_at',case when c.production_enabled then now()+interval '14 days' else c.ends_at end,'protocol_sha256',c.protocol_sha256,
    'windows',coalesce((select jsonb_agg(x) from (
      select symbol,candidate_at as at from doa_capture.candidates where candidate_at>now()-interval '4 minutes'
      union select symbol,entry_at from public.v11_long_regime_positions where entry_at>=c.starts_at and entry_at>now()-interval '4 minutes'
      union select symbol,now() from public.v11_long_regime_positions where state='OPEN'
      union select symbol,now() from public.v11_long_regime_signals where status='NEW' and created_at>now()-interval '30 minutes' and features->>'strategy'='LEADER_MOMENTUM_V17'
    )x),'[]'::jsonb),
    'watch',coalesce((select jsonb_agg(x) from (
      select symbol,min(priority) priority,bool_or(candles) candles,array_agg(distinct role order by role) roles from (
        select symbol,0 priority,true candles,'OPEN_POSITION'::text role from public.v11_long_regime_positions where state='OPEN'
        union all select 'BTCUSDT',1,true,'MARKET_SENSOR'
        -- Prewarm current market leaders BEFORE a V17 signal/trigger exists.
        union all select t->>'symbol',2,true,'SCANNER_LEADER' from jsonb_array_elements(coalesce((select details->'top10' from public.v17_market_scan_runs where captured_at>now()-interval '15 minutes' order by captured_at desc limit 1),'[]'::jsonb)) t
        -- Keep already-created recent candidates warm.
        union all select symbol,3,true,'TRADE_CANDIDATE' from doa_capture.candidates where candidate_at>now()-interval '65 minutes'
        -- NEW signals can become triggered soon; keep full candle+micro coverage.
        union all select symbol,4,true,'TRADE_CANDIDATE' from public.v11_long_regime_signals where created_at>now()-interval '6 hours' and status='NEW' and features->>'strategy'='LEADER_MOMENTUM_V17'
        -- Broader recent V17 universe fills remaining capacity for trajectory prehistory.
        union all select symbol,5,false,'TRADE_CANDIDATE' from public.v11_long_regime_signals where created_at>now()-interval '12 hours' and features->>'strategy'='LEADER_MOMENTUM_V17'
      )w where symbol ~ '^[A-Z0-9]{1,24}USDT$'
      group by symbol order by min(priority),symbol limit 48
    )x),'[]'::jsonb));
 elsif p_action='ingest' then
   if jsonb_typeof(p_body->'rows')<>'array' or jsonb_array_length(p_body->'rows')>600 then raise exception 'row cap';end if;
   if exists(select 1 from doa_capture.batches where id=(p_body->>'batch_id')::uuid) then return jsonb_build_object('enabled',true,'duplicate',true);end if;
   if exists(select 1 from jsonb_array_elements(p_body->'rows') r where (r->>'at')::timestamptz<c.starts_at-interval '2 minutes' or (r->>'at')::timestamptz>now()+interval '5 seconds') then raise exception 'timestamp bounds';end if;
   if (select count(distinct r->>'symbol') from jsonb_array_elements(p_body->'rows') r)>48 then raise exception 'symbol cap';end if;
   -- Short production ring is independent of finite research admission windows.
   insert into doa_capture.live_micro(kind,symbol,at,payload)
    select 'micro',upper(btrim(r->>'symbol')),(r->>'at')::timestamptz,r->'payload'
    from jsonb_array_elements(p_body->'rows') r where r->>'kind'='micro' on conflict do nothing;
   delete from doa_capture.live_micro where at<now()-interval '10 minutes';
   delete from doa_capture.batches where created_at<now()-interval '2 days';
   insert into doa_capture.observations(kind,symbol,at,payload)
    select r->>'kind',upper(btrim(r->>'symbol')),(r->>'at')::timestamptz,r->'payload' from jsonb_array_elements(p_body->'rows') r
    where c.bytes_reserved+sz<=500000000 and c.requests<200000 and now()<c.ends_at and
      (r->>'kind'='candle' or exists(select 1 from doa_capture.candidates d where d.symbol=upper(btrim(r->>'symbol')) and
        (r->>'at')::timestamptz between d.candidate_at-interval '60 seconds' and d.candidate_at+interval '120 seconds')
        or exists(select 1 from public.v11_long_regime_positions p where p.symbol=upper(btrim(r->>'symbol')) and p.state='OPEN'))
    on conflict do nothing;
   get diagnostics n=row_count;
   insert into doa_capture.batches(id) values((p_body->>'batch_id')::uuid);
   update doa_capture.control set bytes_reserved=least(bytes_reserved+sz,500000000),live_bytes_ingested=live_bytes_ingested+sz,metrics=coalesce(p_body->'metrics','{}') where id=1;
   return jsonb_build_object('enabled',true,'inserted',n,'bytes_reserved',c.bytes_reserved+sz,'physical_bytes',physical);
 end if;
 raise exception 'invalid action';
end $function$;

-- Explicit caller role dispatch. A sensor never satisfies a trade request, even for BTC.
create or replace function public.doa_context_for_role_v1(p_symbol text,p_as_of timestamptz,p_role text,p_position_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare c jsonb;
begin
 if p_role='MARKET_SENSOR' and p_position_id is null then return public.doa_market_sensor_context_v1(p_symbol,p_as_of); end if;
 if p_role not in ('TRADE_CANDIDATE','SCANNER_LEADER','OPEN_POSITION') or p_role is null or
   (p_role='OPEN_POSITION' and p_position_id is null) then
  return jsonb_build_object('status','UNAVAILABLE','reason','INVALID_CONTEXT_ROLE');
 end if;
 c:=public.doa_gpt_capture_context_v3(p_symbol,p_as_of,p_position_id);
 if upper(btrim(p_symbol))='BTCUSDT' and c->>'reason'='INVALID_OR_NONCAUSAL_BUCKET' and exists(
  select 1 from (select payload from doa_capture.live_micro where symbol='BTCUSDT' and kind='micro' and at<=p_as_of and at>p_as_of-interval '155 seconds' order by at desc limit 25) x
  where coalesce((payload->>'coverage_25')::boolean,false)=false) then
  c:=c||jsonb_build_object('reason','TRADE_CONTEXT_UNAVAILABLE_DEPTH_COVERAGE');
 end if;
 return c||jsonb_build_object('contract','TRADE_CONTEXT_V3','role',p_role);
end $$;
revoke all on function public.doa_market_sensor_context_v1(text,timestamptz) from public,anon,authenticated;
grant execute on function public.doa_market_sensor_context_v1(text,timestamptz) to service_role;
revoke all on function public.doa_context_for_role_v1(text,timestamptz,text,uuid) from public,anon,authenticated;
grant execute on function public.doa_context_for_role_v1(text,timestamptz,text,uuid) to service_role;
commit;
