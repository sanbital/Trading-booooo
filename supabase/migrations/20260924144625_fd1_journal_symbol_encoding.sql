-- Binance symbols include UTF-8 names. Encode query bytes, never interpolate raw Unicode.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create or replace function public.missed_opportunity_url_symbol(p_symbol text)
returns text language sql immutable strict security invoker set search_path=pg_catalog as $$
  select regexp_replace(encode(convert_to(p_symbol,'UTF8'),'hex'),'([0-9a-f]{2})','%\1','g');
$$;
revoke all on function public.missed_opportunity_url_symbol(text) from public,anon,authenticated;
create or replace function public.missed_opportunity_boundary(p_symbol text,p_start bigint,p_end bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare st integer;k jsonb;
begin
  select status,case when status=200 then content::jsonb end into st,k from http_get(
    'https://fapi.binance.com/fapi/v1/aggTrades?symbol='||public.missed_opportunity_url_symbol(p_symbol)||'&startTime='||p_start||'&endTime='||p_end||'&limit=1000');
  if st is distinct from 200 or jsonb_typeof(k) is distinct from 'array' or jsonb_array_length(k)>=1000
    then raise exception 'BOUNDARY_INCOMPLETE_HTTP_%',st;end if;
  if exists(select 1 from jsonb_array_elements(k) x where (x->>'T')::bigint not between p_start and p_end
    or not coalesce((x->>'p')::numeric>0,false)) then raise exception 'BOUNDARY_INVALID';end if;
  return jsonb_build_object('high',(select max((x->>'p')::numeric) from jsonb_array_elements(k) x),
    'low',(select min((x->>'p')::numeric) from jsonb_array_elements(k) x),
    'close',(select (x->>'p')::numeric from jsonb_array_elements(k) x order by (x->>'T')::bigint desc,(x->>'a')::bigint desc limit 1));
end $$;
revoke all on function public.missed_opportunity_boundary(text,bigint,bigint) from public,anon,authenticated;

create or replace function public.missed_opportunity_track_lane(p_limit integer,p_recent boolean)
returns integer language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare r record;k jsonb;st integer;t0 bigint;h integer;result jsonb;offset_ms bigint;head jsonb;tail jsonb;edges integer:=0;
  hi numeric;lo numeric;cl numeric;net numeric;n integer:=0;attempted integer:=0;
  started timestamptz:=clock_timestamp();asof timestamptz:=clock_timestamp();ready integer;
begin
  -- Separate cron lanes share a lock: no concurrent HTTP fan-out or duplicate work.
  if not pg_try_advisory_xact_lock(714024,60) then return 0;end if;
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','2500');
  perform public.missed_opportunity_sync(3000);
  for r in
    select * from public.missed_opportunity_journal j
    where outcome_tracked_at is null and reference_price>0
      and candidate_at<=asof-interval '5 minutes'
      and (next_track_at is null or next_track_at<=asof)
      and (not p_recent or candidate_at>=asof-interval '3 hours')
      and (p_recent or candidate_at<asof-interval '3 hours')
    order by case when p_recent then (candidate_at<=asof-interval '60 minutes')::int end desc,
      case when p_recent then candidate_at end desc,candidate_at asc,signal_id
    limit greatest(1,least(p_limit,case when p_recent then 30 else 150 end))
    for update skip locked
  loop
    exit when clock_timestamp()-started>interval '18 seconds';
    attempted:=attempted+1;
    t0:=(extract(epoch from date_trunc('minute',r.candidate_at))*1000)::bigint;
    offset_ms:=(extract(epoch from r.candidate_at)*1000)::bigint-t0;
    if offset_ms>0 then
      if edges>=2 then continue;end if; -- at most 10 aggTrades requests per lane/cycle
      edges:=edges+1;
    end if;
    ready:=least(60,floor(extract(epoch from asof-r.candidate_at)/60)::integer);
    begin
      select status,case when status=200 then content::jsonb end into st,k
      from http_get('https://fapi.binance.com/fapi/v1/klines?symbol='||public.missed_opportunity_url_symbol(r.symbol)||
        '&interval=1m&startTime='||t0||'&limit=60');
      if st is distinct from 200 or jsonb_typeof(k) is distinct from 'array' then raise exception 'HTTP_%',st;end if;
      if offset_ms>0 then head:=public.missed_opportunity_boundary(r.symbol,t0+offset_ms,t0+59999);end if;
      result:='{}'::jsonb;
      foreach h in array array[5,15,30,60] loop
        if ready<h then continue;end if;
        -- Timestamps, contiguous sequence and completed candles are mandatory. Never
        -- interpret ordinal rows from a gapped/shifted API response as the horizon.
        if (select count(*) from jsonb_array_elements(k) with ordinality x(v,i)
          where i<=h and (v->>0)::bigint=t0+(i-1)*60000 and (v->>6)::bigint=t0+i*60000-1
            and (v->>6)::bigint<extract(epoch from asof)*1000
            and (v->>3)::numeric>0 and (v->>2)::numeric>=(v->>3)::numeric
            and (v->>4)::numeric between (v->>3)::numeric and (v->>2)::numeric)<>h
          then raise exception 'INCOMPLETE_HORIZON_%',h;end if;
        select max((v->>2)::numeric),min((v->>3)::numeric),
          max((v->>4)::numeric) filter(where i=h) into hi,lo,cl
          from jsonb_array_elements(k) with ordinality x(v,i) where i<=h;
        if offset_ms>0 then
          if clock_timestamp()-started>interval '18 seconds' then raise exception 'TRACK_TIME_BUDGET';end if;
          tail:=public.missed_opportunity_boundary(r.symbol,t0+h*60000,t0+h*60000+offset_ms-1);
          select greatest(max((v->>2)::numeric),(head->>'high')::numeric,(tail->>'high')::numeric),
            least(min((v->>3)::numeric),(head->>'low')::numeric,(tail->>'low')::numeric),
            coalesce((tail->>'close')::numeric,max((v->>4)::numeric) filter(where i=h)) into hi,lo,cl
            from jsonb_array_elements(k) with ordinality x(v,i) where i>1 and i<=h;
        end if;
        net:=coalesce(nullif(r.target_notional_usdt,0),450)*
          (case when lo<=r.reference_price*(1-coalesce(nullif(r.stop_pct,0),.025))
            then -coalesce(nullif(r.stop_pct,0),.025) else cl/r.reference_price-1 end)-
          coalesce(nullif(r.target_notional_usdt,0),450)*.001;
        result:=result||jsonb_build_object('high_'||h||'m',hi,'low_'||h||'m',lo,'close_'||h||'m',cl,
          'mfe_'||h,hi/r.reference_price-1,'mae_'||h,lo/r.reference_price-1,
          case when h=60 then 'reconstructed_net_usdt' else 'reconstructed_net_'||h||'m' end,net);
      end loop;
      update public.missed_opportunity_journal j set
        high_5m=(result->>'high_5m')::numeric,low_5m=(result->>'low_5m')::numeric,close_5m=(result->>'close_5m')::numeric,
        high_15m=(result->>'high_15m')::numeric,low_15m=(result->>'low_15m')::numeric,close_15m=(result->>'close_15m')::numeric,
        high_30m=(result->>'high_30m')::numeric,low_30m=(result->>'low_30m')::numeric,close_30m=(result->>'close_30m')::numeric,
        high_60m=(result->>'high_60m')::numeric,low_60m=(result->>'low_60m')::numeric,close_60m=(result->>'close_60m')::numeric,
        mfe_5=(result->>'mfe_5')::numeric,mae_5=(result->>'mae_5')::numeric,
        mfe_15=(result->>'mfe_15')::numeric,mae_15=(result->>'mae_15')::numeric,
        mfe_30=(result->>'mfe_30')::numeric,mae_30=(result->>'mae_30')::numeric,
        mfe_60=(result->>'mfe_60')::numeric,mae_60=(result->>'mae_60')::numeric,
        reconstructed_net_5m=(result->>'reconstructed_net_5m')::numeric,
        reconstructed_net_15m=(result->>'reconstructed_net_15m')::numeric,
        reconstructed_net_30m=(result->>'reconstructed_net_30m')::numeric,
        reconstructed_net_usdt=(result->>'reconstructed_net_usdt')::numeric,
        outcome_tracked_at=case when ready>=60 then asof else null end,
        next_track_at=case when ready>=60 then null else r.candidate_at+
          make_interval(mins=>case when ready<15 then 15 when ready<30 then 30 else 60 end) end,
        tracking_error=null,track_attempts=track_attempts+1,updated_at=asof
      where j.signal_id=r.signal_id and j.outcome_tracked_at is null;
      n:=n+1;
    exception when others then
      update public.missed_opportunity_journal set track_attempts=track_attempts+1,
        next_track_at=asof+interval '30 minutes',tracking_error=left(sqlerrm,150),updated_at=asof where signal_id=r.signal_id;
      if st in (418,429) or sqlerrm like '%HTTP_429%' or sqlerrm like '%HTTP_418%' then exit;end if;
    end;
  end loop;
  return n;
end $$;
revoke all on function public.missed_opportunity_track_lane(integer,boolean) from public,anon,authenticated;

-- Deterministic queue repair for this source error only. No outcome, trade or fee changes.
-- The ordinary bounded worker still fetches and verifies every horizon.
update public.missed_opportunity_journal set next_track_at=clock_timestamp()
where outcome_tracked_at is null and tracking_error='HTTP_400' and octet_length(symbol)>length(symbol);
commit;
