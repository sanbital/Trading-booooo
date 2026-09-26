-- Production capture ring; research observations and trading settings are preserved.
begin;
alter table doa_capture.control add column if not exists production_enabled boolean not null default false;
alter table doa_capture.control add column if not exists live_requests bigint not null default 0;
alter table doa_capture.control add column if not exists live_bytes_ingested bigint not null default 0;
alter table doa_capture.observations drop constraint if exists observations_symbol_check;
alter table doa_capture.observations add constraint observations_symbol_check check(symbol ~ '^[A-Z0-9]{1,24}USDT$');
create table doa_capture.live_micro (like doa_capture.observations including defaults including constraints);
alter table doa_capture.live_micro add primary key(kind,symbol,at);
create index live_micro_retention on doa_capture.live_micro(at);
create index if not exists capture_batches_retention on doa_capture.batches(created_at);
alter table doa_capture.live_micro enable row level security;
revoke all on doa_capture.live_micro from public,anon,authenticated;
grant select,insert,update,delete on doa_capture.live_micro to service_role;
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
      select symbol,min(priority) priority,bool_or(candles) candles from (
        select symbol,0 priority,true candles from public.v11_long_regime_positions where state='OPEN'
        union all select 'BTCUSDT',1,true
        -- Prewarm current market leaders BEFORE a V17 signal/trigger exists.
        union all select t->>'symbol',2,true from jsonb_array_elements(coalesce((select details->'top10' from public.v17_market_scan_runs where captured_at>now()-interval '15 minutes' order by captured_at desc limit 1),'[]'::jsonb)) t
        -- Keep already-created recent candidates warm.
        union all select symbol,3,true from doa_capture.candidates where candidate_at>now()-interval '65 minutes'
        -- NEW signals can become triggered soon; keep full candle+micro coverage.
        union all select symbol,4,true from public.v11_long_regime_signals where created_at>now()-interval '6 hours' and status='NEW' and features->>'strategy'='LEADER_MOMENTUM_V17'
        -- Broader recent V17 universe fills remaining capacity for trajectory prehistory.
        union all select symbol,5,false from public.v11_long_regime_signals where created_at>now()-interval '12 hours' and features->>'strategy'='LEADER_MOMENTUM_V17'
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
end $function$
;
CREATE OR REPLACE FUNCTION public.doa_gpt_capture_context(p_symbol text, p_as_of timestamp with time zone)
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
  select o.at,o.received_at,o.payload,
    row_number() over(order by o.at desc) as rn
  from (select * from doa_capture.live_micro
    union all select * from doa_capture.observations legacy where not exists
      (select 1 from doa_capture.live_micro live where live.symbol=legacy.symbol and live.at>p_as_of-interval '95 seconds')) o
  where o.kind='micro'
    and o.symbol=upper(btrim(p_symbol))
    and o.at <= p_as_of and o.received_at<=p_as_of
    and (o.payload->>'interval_end')::timestamptz<=p_as_of
    and o.at > p_as_of - interval '95 seconds'
    and coalesce((o.payload->>'bucket_complete')::boolean,false)=true
    and coalesce((o.payload->>'trade_sequence_complete')::boolean,false)=true
    and coalesce((o.payload->>'book_complete')::boolean,false)=true
    and coalesce((o.payload->>'coverage_25')::boolean,false)=true
),
last12 as (
  select * from raw where rn<=12
),
ordered as (
  select at,received_at,payload,
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
  from last12
),
stats as (
  select count(*) as n,min(at) as min_at,max(at) as max_at,
    min((payload->>'interval_start')::timestamptz) as window_start,
    max((payload->>'interval_end')::timestamptz) as window_end,
    max(received_at) as newest_received,
    bool_and(previous_at is null or at-previous_at=interval '5 seconds') as contiguous,
    bool_and(previous_end is null or abs(extract(epoch from ((payload->>'interval_start')::timestamptz-previous_end)))<=0.001) as intervals_contiguous
  from ordered
),
points as (
 select jsonb_agg(
   jsonb_build_object(
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
 from ordered
)
select case
 when not exists(select 1 from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','UNWATCHED')
 when not (select enabled and gpt_context_enabled and (production_enabled or now()<ends_at) from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
 when (select heartbeat_at from ctl)>clock_timestamp()+interval '1 second' or (select heartbeat_at from ctl)<clock_timestamp()-interval '25 seconds'
   then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when upper(btrim(p_symbol)) !~ '^[A-Z0-9]{1,24}USDT$' then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_SYMBOL')
 when (select n from stats)<>12 then jsonb_build_object('status','UNAVAILABLE','reason','INCOMPLETE_TRAJECTORY')
 when not (select contiguous and intervals_contiguous from stats) then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 when (select window_end from stats)<p_as_of-interval '25 seconds' then jsonb_build_object('status','UNAVAILABLE','reason','STALE_BUCKET')
 when extract(epoch from ((select max_at from stats)-(select min_at from stats))) not between 50 and 65
   then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 else jsonb_build_object(
   'version','CAPTURE-CONTEXT-2-TRAJECTORY',
   'status','AVAILABLE',
   'buckets',12,
   'start_ms',floor(extract(epoch from (select window_start from stats))*1000),
   'end_ms',floor(extract(epoch from (select window_end from stats))*1000),
   'ingested_at_ms',floor(extract(epoch from (select newest_received from stats))*1000),
   'trajectory',(select trajectory from points)
 )
end
$function$
;

revoke all on function public.doa_capture_rpc(text,jsonb) from public,anon,authenticated;
revoke all on function public.doa_gpt_capture_context(text,timestamptz) from public,anon,authenticated;
grant execute on function public.doa_capture_rpc(text,jsonb) to service_role;
grant execute on function public.doa_gpt_capture_context(text,timestamptz) to service_role;
-- Explicitly activate the requested continuous production capture. Operator enabled remains authoritative.
update doa_capture.control set production_enabled=true where id=1;
commit;
