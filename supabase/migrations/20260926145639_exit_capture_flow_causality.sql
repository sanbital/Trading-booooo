-- Enforce received/event causality for aggressive trade flow as well as the book.
begin;
CREATE OR REPLACE FUNCTION public.doa_gpt_capture_context_v3(p_symbol text, p_as_of timestamp with time zone, p_position_id uuid DEFAULT null)
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
 when not (select enabled and gpt_context_enabled and (production_enabled or now()<ends_at) from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
 when (select heartbeat_at from ctl)>clock_timestamp()+interval '1 second' or (select heartbeat_at from ctl)<clock_timestamp()-interval '25 seconds'
   then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when upper(btrim(p_symbol)) !~ '^[A-Z0-9]{1,24}USDT$' then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_SYMBOL')
 when p_position_id is not null and not exists(select 1 from public.v11_long_regime_positions p where p.id=p_position_id and p.symbol=upper(btrim(p_symbol)) and p.state='OPEN')
   then jsonb_build_object('status','UNAVAILABLE','reason','POSITION_NOT_OPEN_OR_MISMATCH')
 when exists(select 1 from doa_capture.live_micro o where o.symbol=upper(btrim(p_symbol)) and o.at>p_as_of and o.at<=p_as_of+interval '10 seconds' and o.received_at<=p_as_of)
   then jsonb_build_object('status','UNAVAILABLE','reason','FUTURE_BUCKET')
 when (select n from stats)<>24 then jsonb_build_object('status','UNAVAILABLE','reason','INCOMPLETE_TRAJECTORY')
 when (select valid from validity) is distinct from true then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_OR_NONCAUSAL_BUCKET')
 when not (select contiguous and intervals_contiguous from stats) then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 when (select window_end from stats)<p_as_of-interval '25 seconds' then jsonb_build_object('status','UNAVAILABLE','reason','STALE_BUCKET')
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
$function$
;


revoke all on function public.doa_gpt_capture_context_v3(text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.doa_gpt_capture_context_v3(text,timestamptz,uuid) to service_role;
comment on function public.doa_gpt_capture_context_v3(text,timestamptz,uuid) is
'Service-only 24x5s ordered trajectory from the existing continuous ring. All 24 complete causal buckets required; no synthetic backfill. Optional 25th boundary only supplies first delta. V2 remains unchanged.';

commit;
