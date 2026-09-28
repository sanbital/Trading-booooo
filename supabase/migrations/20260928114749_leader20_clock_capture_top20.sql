-- Clock entry capture; opt-in only after compatible collector and Edge bundles are deployed.
begin;
set local lock_timeout='2s';
alter table public.leader20_control add column clock_capture_enabled boolean not null default false;

CREATE OR REPLACE FUNCTION public.leader20_clock_raw(p_symbol text, p_as_of timestamptz, p_position_id uuid, p_cutoff timestamptz)
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
 when not (select enabled and gpt_context_enabled and (production_enabled or now()<ends_at) from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
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
$function$
;



-- The same immutable rows are read at every stage; receipt clocks remain real.
alter function public.doa_context_for_role_v1(text,timestamptz,text,uuid) rename to doa_context_before_clock;
create function public.doa_context_for_role_v1(p_symbol text,p_as_of timestamptz,p_role text,p_position_id uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype;c jsonb;slot_ms bigint;at_ms bigint;
begin
 select * into ctl from public.leader20_control where singleton;
 if not ctl.clock_capture_enabled or p_position_id is not null or p_role not in ('TRADE_CANDIDATE','SCANNER_LEADER') or p_role is null then
  return public.doa_context_before_clock(p_symbol,p_as_of,p_role,p_position_id);end if;
 slot_ms:=floor(extract(epoch from p_as_of)/600)*600000;at_ms:=floor(extract(epoch from p_as_of)*1000);
 if at_ms>=slot_ms+120000 or p_as_of>clock_timestamp()+interval '1 second' or clock_timestamp()>=to_timestamp((slot_ms+120000)::numeric/1000)
  or not exists(select 1 from public.leader20_epochs e join public.leader20_members m on m.epoch_id=e.id
   where e.id=ctl.epoch_id and m.symbol=p_symbol and (e.snapshot->>'capture_slot_ms')::bigint=slot_ms)
 then return jsonb_build_object('status','UNAVAILABLE','reason','CLOCK_OUTSIDE_ENTRY_WINDOW');end if;
 c:=public.leader20_clock_raw(p_symbol,p_as_of,null,to_timestamp(slot_ms::numeric/1000));
 if c->>'status' is distinct from 'AVAILABLE' then return c||jsonb_build_object('reason','CLOCK_'||coalesce(c->>'reason','CAPTURE_UNAVAILABLE'));end if;
 if (c->>'start_ms')::bigint<slot_ms-120000 or (c->>'start_ms')::bigint>=slot_ms-119000
  or (c->>'end_ms')::bigint<slot_ms or (c->>'end_ms')::bigint>=slot_ms+1000 then
  return jsonb_build_object('status','UNAVAILABLE','reason','CLOCK_INCOMPLETE_BOUNDARY');end if;
 return c||jsonb_build_object('contract','TRADE_CONTEXT_V3','role',p_role,'entry_window',jsonb_build_object(
  'version','TOP20_CLOCK_CAPTURE_1','slot_ms',slot_ms,'expires_at_ms',slot_ms+120000,
  'epoch_id',ctl.epoch_id,'generation',ctl.generation,'capture_hash',md5((c->'trajectory')::text)));
end $$;

alter function public.doa_capture_rpc(text,jsonb) rename to doa_capture_rpc_before_clock;
create function public.doa_capture_rpc(p_action text,p_body jsonb default '{}') returns jsonb language plpgsql set search_path='' as $$
declare r jsonb;c public.leader20_control%rowtype;slot_ms bigint;at_ms bigint:=floor(extract(epoch from clock_timestamp())*1000);
begin
 r:=public.doa_capture_rpc_before_clock(p_action,p_body);
 select * into c from public.leader20_control where singleton;
 if p_action<>'watch' or not c.clock_capture_enabled or r->>'enabled' is distinct from 'true' then return r;end if;
 select (snapshot->>'capture_slot_ms')::bigint into slot_ms from public.leader20_epochs where id=c.epoch_id;
 return r||jsonb_build_object('entry_window',jsonb_build_object('version','TOP20_CLOCK_CAPTURE_1','slot_ms',slot_ms),
  'watch',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(r->'watch') x
   where x->'roles' ?| array['OPEN_POSITION','MARKET_SENSOR'] or at_ms>=slot_ms-180000 and at_ms<slot_ms+1000));
end $$;

create or replace function public.leader20_publish_epoch(p_snapshot jsonb,p_previous uuid default null) returns jsonb
language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype; eid uuid; item jsonb; observed timestamptz; scheduled timestamptz; next_at timestamptz;
begin
 select * into ctl from public.leader20_control where singleton for update;
 if not ctl.observation_enabled then raise exception 'LEADER20_OBSERVATION_DISABLED'; end if;
 if ctl.epoch_id is distinct from p_previous then return jsonb_build_object('published',false,'reason','EPOCH_RACE'); end if;
 observed:=to_timestamp((p_snapshot->>'observed_at_ms')::numeric/1000);
 scheduled:=to_timestamp((p_snapshot->>'scheduled_at_ms')::numeric/1000);
 next_at:=to_timestamp((p_snapshot->>'next_refresh_at_ms')::numeric/1000);
 if not (p_snapshot ?& array['strategy','selection_version','members','covered_count','expected_count','observed_at_ms','scheduled_at_ms','next_refresh_at_ms','source_hash']) then raise exception 'LEADER20_INVALID_EPOCH'; end if;
 if p_snapshot->>'strategy'<>'LEADER20_DYNAMIC_1' or
    p_snapshot->>'selection_version'<>(case when ctl.clock_capture_enabled then 'TOP20_CLOCK_CAPTURE_1' else 'BINANCE_USDM_COIN_ROLLING24H_TOP20_6H_KST_1' end) or
    jsonb_array_length(p_snapshot->'members')<>20 or
    (p_snapshot->>'covered_count')::integer<>(p_snapshot->>'expected_count')::integer or
    (p_snapshot->>'expected_count')::integer<20 or observed>clock_timestamp()+interval '1 second' or
    observed<clock_timestamp()-interval '30 seconds' or next_at<=clock_timestamp() or
    (not ctl.clock_capture_enabled and next_at<>(date_trunc('day',observed at time zone 'Asia/Seoul')+
      (floor(extract(hour from observed at time zone 'Asia/Seoul')/6)+1)*interval '6 hours') at time zone 'Asia/Seoul')
 then raise exception 'LEADER20_INVALID_EPOCH'; end if;
 if ctl.clock_capture_enabled and (not (p_snapshot ? 'capture_slot_ms') or
  (p_snapshot->>'capture_slot_ms')::bigint%600000<>0 or scheduled<>to_timestamp(((p_snapshot->>'capture_slot_ms')::bigint-180000)::numeric/1000)
  or observed<scheduled or observed>=scheduled+interval '1 minute' or next_at<>scheduled+interval '10 minutes')
 then raise exception 'LEADER20_CLOCK_EPOCH_INVALID';end if;
 if p_previous is not null and exists(select 1 from public.leader20_epochs where id=p_previous and next_refresh_at>scheduled and (not ctl.clock_capture_enabled or snapshot->>'selection_version'='TOP20_CLOCK_CAPTURE_1'))
 then raise exception 'LEADER20_EPOCH_NOT_DUE'; end if;
 insert into public.leader20_epochs(scheduled_at,observed_at,next_refresh_at,snapshot,source_hash)
 values(scheduled,observed,next_at,p_snapshot,p_snapshot->>'source_hash') returning id into eid;
 for item in select * from jsonb_array_elements(p_snapshot->'members') loop
  insert into public.leader20_members values(eid,item->>'symbol',(item->>'rank')::integer,
    (item->>'price_change_percent')::numeric,(item->>'quote_volume')::numeric);
 end loop;
 insert into public.leader20_campaigns(symbol,epoch_id)
 select symbol,eid from public.leader20_members where epoch_id=eid
 on conflict(symbol) do update set epoch_id=excluded.epoch_id,state=case when public.leader20_campaigns.state='RETIRED' then 'WARMING_UP' else public.leader20_campaigns.state end,updated_at=now();
 update public.leader20_campaigns w set state=case when exists(select 1 from public.v11_long_regime_positions p
   where p.symbol=w.symbol and (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true')) then 'MANAGE_ONLY' else 'RETIRED' end,
   reason='UNIVERSE_EXPIRED',updated_at=now()
 where not exists(select 1 from public.leader20_members m where m.epoch_id=eid and m.symbol=w.symbol);
 update public.leader20_review_events set state='RETIRED' where epoch_id<>eid and state in ('REQUESTED','REVIEWING');
 update public.leader20_control set epoch_id=eid,updated_at=now() where singleton;
 return jsonb_build_object('published',true,'epoch_id',eid);
end $$;

alter function public.leader20_batch_claim(jsonb,text,boolean) rename to leader20_batch_claim_before_clock;
create or replace function public.leader20_batch_claim(p_packet jsonb,p_evidence_key text,p_strong_change boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.leader20_batch_control%rowtype;l public.leader20_control%rowtype;cap jsonb;b public.leader20_batches%rowtype;
 reason text;at_time timestamptz:=clock_timestamp(); slot_at timestamptz:=to_timestamp(floor(extract(epoch from clock_timestamp())/600)*600);
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into c from public.leader20_batch_control where singleton for update;
 if not c.enabled then return jsonb_build_object('created',false,'reason','BATCH_DISABLED'); end if;
 select * into l from public.leader20_control where singleton;
 if not l.clock_capture_enabled then return public.leader20_batch_claim_before_clock(p_packet,p_evidence_key,p_strong_change);end if;
 if at_time<slot_at+interval '1 second' or at_time>=slot_at+interval '30 seconds' then return jsonb_build_object('created',false,'reason','CLOCK_BATCH_NOT_DUE');end if;
 cap:=public.leader20_batch_capacity();
 if cap->>'reason' like 'ACCOUNT_SNAPSHOT_%' then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 update public.leader20_batch_control set last_slots=(cap->>'available')::integer where singleton;
 if (cap->>'available')::integer=0 then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 if l.epoch_id::text is distinct from p_packet->>'epoch_id' or l.generation is distinct from (p_packet->>'generation')::bigint
 or not l.observation_enabled or l.active_strategy<>'LEADER20_DYNAMIC_1' then raise exception 'BATCH_GENERATION'; end if;
 if p_packet->>'version' is distinct from 'TOP20_DEEPSEEK_BATCH_1' then raise exception 'BATCH_LIVE_PROTOCOL_REQUIRED'; end if;
 if jsonb_array_length(p_packet->'symbols')<>20 or
 (select count(distinct x->>'id') from jsonb_array_elements(p_packet->'symbols')x)<>20 or
 exists(select 1 from jsonb_array_elements(p_packet->'symbols')x where not exists(
  select 1 from public.leader20_members where epoch_id=l.epoch_id and rank<=20 and symbol=x->>'id')) then raise exception 'BATCH_MEMBERSHIP'; end if;
 if (p_packet->>'as_of_ms')::numeric<extract(epoch from at_time)*1000-10000 or
  (p_packet->>'as_of_ms')::numeric>extract(epoch from at_time)*1000 then raise exception 'BATCH_STALE'; end if;
 if p_packet#>>'{entry_window,version}' is distinct from 'TOP20_CLOCK_CAPTURE_1' or
  (p_packet#>>'{entry_window,slot_ms}')::bigint is distinct from floor(extract(epoch from slot_at)*1000)::bigint or
  not exists(select 1 from public.leader20_epochs where id=l.epoch_id and (snapshot->>'capture_slot_ms')::bigint=(p_packet#>>'{entry_window,slot_ms}')::bigint)
 then raise exception 'CLOCK_BATCH_WINDOW';end if;
 if not exists(select 1 from jsonb_array_elements(p_packet->'symbols') x where x->>'state'='READY') then
  return jsonb_build_object('created',false,'reason','CLOCK_CAPTURE_NOT_READY');end if;
 if exists(select 1 from jsonb_array_elements(p_packet->'symbols') x where x->>'state'='READY' and (
  x->'entry_window' is distinct from public.doa_context_for_role_v1(x->>'id',at_time,'TRADE_CANDIDATE',null)->'entry_window'))
 then raise exception 'CLOCK_BATCH_CAPTURE_BINDING';end if;
 reason:=case when c.last_periodic_slot is null or c.last_periodic_slot<slot_at then 'TEN_MINUTE' end;
 if reason is null then return jsonb_build_object('created',false,'reason','NOT_DUE'); end if;
 if exists(select 1 from public.leader20_batches where state in ('RESERVED','DISPATCHED') and expires_at>at_time) then
  return jsonb_build_object('created',false,'reason','BATCH_IN_FLIGHT'); end if;
 update public.leader20_batches set state='UNKNOWN' where state in ('RESERVED','DISPATCHED') and expires_at<=at_time;
 insert into public.leader20_batches(epoch_id,generation,data_version,state,reason,packet,periodic_slot)
 values(l.epoch_id,l.generation,p_packet->>'batch_hash','RESERVED',reason,p_packet,slot_at)
 on conflict(data_version) do nothing returning * into b;
 if b.id is null then return jsonb_build_object('created',false,'reason','DUPLICATE_CAPTURE'); end if;
 update public.leader20_batch_control set last_requested_at=at_time,last_evidence_key=p_evidence_key,generation=generation+1,wake_reason=reason,
  last_periodic_slot=slot_at,
  next_periodic_at=slot_at+interval '10 minutes' where singleton;
 return jsonb_build_object('created',true,'row',to_jsonb(b),'capacity',cap);
end $$;


create or replace function public.leader20_schedule() returns jsonb language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype;w record;c jsonb;at_time timestamptz:=clock_timestamp();held boolean;
begin
 if not (select enabled from public.leader20_batch_control where singleton) then return public.leader20_schedule_before_batch(); end if;
 if not pg_try_advisory_xact_lock(20260927,30) then return jsonb_build_object('reason','SCHEDULER_BUSY'); end if;
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled then return jsonb_build_object('reason','OBSERVATION_DISABLED'); end if;
 if ctl.last_scheduler_at>at_time-interval '55 seconds' then return jsonb_build_object('reason','OBSERVATION_THROTTLED'); end if;
 update public.leader20_control set last_scheduler_at=at_time where singleton;
 -- An execution lease is not a campaign lease. Keep terminal signal rows for audit.
 update public.leader20_review_events e set state=case when s.status in ('ORDERED','FILLED','CLOSED') then 'ORDERED' else 'DEFERRED' end,
  result=coalesce(e.result,'{}')||jsonb_build_object('signal_status',s.status,'candidate_expired',e.expires_at<=at_time,'reason',s.reject_reason)
 from public.v11_long_regime_signals s where s.id=e.signal_id and e.state='REVIEWING'
  and (s.status in ('REJECTED','ORDERED','FILLED','CLOSED') or e.expires_at<=at_time)
  and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=s.id and o.intent='OPEN_LONG'
   and o.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and o.response_payload->>'v18ExposureFinal' is distinct from 'true');
 update public.leader20_review_events set state='DEFERRED',result=coalesce(result,'{}')||'{"reason":"CAPTURE_REFRESH_WINDOW_EXHAUSTED"}'::jsonb
 where state='REQUESTED' and requested_at<at_time-interval '120 seconds';
 for w in select * from public.leader20_campaigns order by symbol for update skip locked loop
  held:=exists(select 1 from public.v11_long_regime_positions p where p.symbol=w.symbol and
   (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'));
  if not exists(select 1 from public.leader20_members m where m.epoch_id=ctl.epoch_id and m.symbol=w.symbol and m.rank<=ctl.watch_limit) then
   update public.leader20_campaigns set state=case when held then 'MANAGE_ONLY' else 'OUTSIDE_WATCH' end,
    reason=case when ctl.clock_capture_enabled then 'TOP20_EXIT' else 'TOP10_EXIT' end,review_due_at=null,updated_at=at_time where symbol=w.symbol;continue;
  end if;
  if ctl.clock_capture_enabled and mod(floor(extract(epoch from at_time))::bigint,600)>=120 then
   update public.leader20_campaigns set state=case when held then 'OPEN' else 'WATCHING' end,
    execution_state=case when held then 'FILLED' else 'WAITING_FOR_WINDOW' end,
    review_due_at=to_timestamp((floor(extract(epoch from at_time)/600)+1)*600),updated_at=at_time where symbol=w.symbol;
   continue;
  end if;
  c:=public.doa_context_for_role_v1(w.symbol,at_time,'TRADE_CANDIDATE',null);
  update public.leader20_campaigns set state=case when held then 'OPEN' else 'WATCHING' end,
   bucket_count=coalesce((c->>'buckets')::integer,0),last_bucket_at=case when c->>'status'='AVAILABLE' then to_timestamp((c->>'end_ms')::numeric/1000) else last_bucket_at end,
   execution_state=case when held then 'FILLED'
    when exists(select 1 from public.leader20_review_events e where e.symbol=w.symbol and e.state='REVIEWING') then execution_state
    when c->>'status' is distinct from 'AVAILABLE' then 'REFRESHING' else 'IDLE' end,
   review_due_at=(select coalesce(next_periodic_at,to_timestamp(floor(extract(epoch from at_time)/600)*600)) from public.leader20_batch_control where singleton),
   updated_at=at_time where symbol=w.symbol;
 end loop;
 return jsonb_build_object('requests',0,'reason','BATCH_SCHEDULER_OWNS_ENTRY','observed_at',at_time);
end $$;


alter function public.leader20_materialize_event(uuid,jsonb) rename to leader20_materialize_before_clock;
create function public.leader20_materialize_event(p_event_id uuid,p_features jsonb) returns jsonb language plpgsql set search_path='' as $$
declare e public.leader20_review_events%rowtype;b public.leader20_batches%rowtype;c jsonb;w jsonb;s jsonb;r jsonb;sid uuid;deadline timestamptz;
begin
 if not(select clock_capture_enabled from public.leader20_control where singleton) then return public.leader20_materialize_before_clock(p_event_id,p_features);end if;
 select * into e from public.leader20_review_events where id=p_event_id for update;
 select * into b from public.leader20_batches where id::text=e.result->>'batch_id';
 select x into s from jsonb_array_elements(b.packet->'symbols')x where x->>'id'=e.symbol;
 c:=public.doa_context_for_role_v1(e.symbol,clock_timestamp(),'TRADE_CANDIDATE',null);w:=c->'entry_window';
 if e.state is distinct from 'REQUESTED' or b.state is distinct from 'DONE' or s->>'state' is distinct from 'READY'
  or c->>'status' is distinct from 'AVAILABLE' or w is null or w is distinct from s->'entry_window'
  or w is distinct from p_features#>'{execution_snapshot,entry_window}'
  or p_features#>>'{execution_snapshot,complete}' is distinct from 'true'
  or p_features#>>'{execution_snapshot,causal}' is distinct from 'true'
  or p_features#>>'{execution_snapshot,bucket_count}' is distinct from '24'
  or p_features#>>'{execution_snapshot,end_ms}' is distinct from c->>'end_ms'
  or (p_features->>'referenceClose')::numeric<=0 then return jsonb_build_object('created',false,'reason','CLOCK_CAPTURE_BINDING');end if;
 if (public.leader20_batch_capacity()->>'available')::integer<1 then return jsonb_build_object('created',false,'reason','NO_ENTRY_CAPACITY');end if;
 r:=public.leader20_materialize_event_before_batch(p_event_id,p_features);
 if r->>'created'='true' then
  sid:=(r->>'signal_id')::uuid;deadline:=to_timestamp((w->>'expires_at_ms')::numeric/1000);
  update public.v11_long_regime_signals set features=jsonb_set(features,'{leader20}',features->'leader20'||jsonb_build_object(
   'batch_id',b.id,'batch_advice',e.result->'batch_advice','entry_window',w,'expires_at_ms',w->'expires_at_ms',
   'execution_snapshot_hash',p_features#>'{execution_snapshot,trajectory_hash}')) where id=sid;
  update public.leader20_review_events set expires_at=deadline where id=e.id;
  update public.leader20_campaigns set state='WATCHING',execution_state='ENTRY_CANDIDATE',last_candidate_id=sid,updated_at=clock_timestamp() where symbol=e.symbol;
 end if;return r;
end $$;

alter function public.leader20_entry_authority(uuid) rename to leader20_entry_authority_before_clock;
create function public.leader20_entry_authority(p_signal_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare r jsonb;s public.v11_long_regime_signals%rowtype;c jsonb;
begin
 r:=public.leader20_entry_authority_before_clock(p_signal_id);
 if r->>'allowed' is distinct from 'true' or not(select clock_capture_enabled from public.leader20_control where singleton) then return r;end if;
 select * into s from public.v11_long_regime_signals where id=p_signal_id;
 c:=public.doa_context_for_role_v1(s.symbol,clock_timestamp(),'TRADE_CANDIDATE',null);
 if c->>'status' is distinct from 'AVAILABLE' or c->'entry_window' is distinct from s.features#>'{leader20,entry_window}' then
  return jsonb_build_object('allowed',false,'reason','CLOCK_ENTRY_WINDOW_EXPIRED_OR_CHANGED');end if;
 return r;
end $$;
revoke all on function public.leader20_clock_raw(text,timestamptz,uuid,timestamptz),
 public.doa_context_for_role_v1(text,timestamptz,text,uuid),public.doa_capture_rpc(text,jsonb),
 public.leader20_batch_claim(jsonb,text,boolean),public.leader20_materialize_event(uuid,jsonb),public.leader20_entry_authority(uuid)
 from public,anon,authenticated;
grant execute on function public.leader20_clock_raw(text,timestamptz,uuid,timestamptz),
 public.doa_context_for_role_v1(text,timestamptz,text,uuid),public.doa_capture_rpc(text,jsonb),
 public.leader20_batch_claim(jsonb,text,boolean),public.leader20_materialize_event(uuid,jsonb),public.leader20_entry_authority(uuid)
 to service_role;
notify pgrst,'reload schema';
commit;
