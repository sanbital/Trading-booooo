-- Research tracking only. No trade/order/position history is modified.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
alter table public.missed_opportunity_journal
  add column if not exists next_track_at timestamptz,
  add column if not exists tracking_error text,
  add column if not exists reconstructed_net_5m numeric,
  add column if not exists reconstructed_net_15m numeric,
  add column if not exists reconstructed_net_30m numeric;

-- Exact boundary trades for candidates between minute boundaries. A saturated page
-- is incomplete evidence, never a license to infer high/low from an enclosing candle.
create or replace function public.missed_opportunity_boundary(p_symbol text,p_start bigint,p_end bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare st integer;k jsonb;
begin
  select status,case when status=200 then content::jsonb end into st,k from http_get(
    'https://fapi.binance.com/fapi/v1/aggTrades?symbol='||p_symbol||'&startTime='||p_start||'&endTime='||p_end||'&limit=1000');
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
      from http_get('https://fapi.binance.com/fapi/v1/klines?symbol='||r.symbol||
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
create or replace function public.missed_opportunity_track(p_limit integer default 20)
returns integer language sql security definer set search_path=pg_catalog,public as $$
  select public.missed_opportunity_track_lane(p_limit,true);
$$;
revoke all on function public.missed_opportunity_track(integer) from public,anon,authenticated;
select cron.schedule('missed-opportunity-sync-track-5m','*/5 * * * *',
  'select public.missed_opportunity_track(30);');
select cron.schedule('missed-opportunity-catchup-5m','2-59/5 * * * *',
  'select public.missed_opportunity_track_lane(150,false);');

-- V17 accounting has a different position namespace from trading_positions. A native
-- stop is linked through its recorded actualOrderId/tradeIds, not a fabricated order.
-- Verify existing economics; never replace PnL, fees, quantities or exchange history.
create or replace function public.v17_closed_fill_accounting_proven(p_id uuid)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare p public.v11_long_regime_positions%rowtype;a record;
begin
  select * into p from public.v11_long_regime_positions where id=p_id;
  if not found or p.state<>'CLOSED' or p.side<>'LONG' or p.remaining_quantity<>0 or p.original_quantity<=0
    or p.metadata->>'executionMode' is distinct from 'LEADER_MOMENTUM_V17'
    or p.metadata->>'exitAccountingPending' is distinct from 'false'
    or p.metadata->>'v18EntryAccountingPending' is distinct from 'false' then return false;end if;
  select count(*) n,sum(quantity) filter(where side='BUY') bought,sum(quantity) filter(where side='SELL') sold,
    sum(quote_amount) filter(where side='BUY') entry_quote,sum(fee_quote_amount) filter(where side='BUY') entry_fee,
    sum(realized_pnl_quote-fee_quote_amount) net,
    bool_and(coalesce(
      f.exchange='binance_futures' and f.account_scope='futures' and f.market=p.symbol
      and f.position_id is null and f.bot_order_id is null and f.quantity>0 and f.price>0
      and f.side in ('BUY','SELL') and f.executed_at between p.entry_at and p.closed_at
      and f.fee_asset='USDT' and f.fee_amount=f.fee_quote_amount and f.fee_amount>=0
      and f.raw_response->>'symbol'=f.market and f.raw_response->>'id'=f.exchange_trade_id::text
      and f.raw_response->>'orderId'=f.exchange_order_id
      and (f.raw_response->>'qty')::numeric=f.quantity and (f.raw_response->>'price')::numeric=f.price
      and (f.raw_response->>'quoteQty')::numeric=f.quote_amount
      and abs(f.price*f.quantity-f.quote_amount)<0.000001
      and f.raw_response->>'commissionAsset'='USDT'
      and (f.raw_response->>'commission')::numeric=f.fee_quote_amount
      and (f.raw_response->>'realizedPnl')::numeric=f.realized_pnl_quote
      and (f.raw_response->>'isBuyer')::boolean=(f.side='BUY')
      and abs(extract(epoch from f.executed_at)*1000-(f.raw_response->>'time')::numeric)<1
      and (exists(select 1 from public.v11_long_regime_orders o
          where o.id=f.v17_order_id and o.position_id=p.id and o.signal_id=p.signal_id
            and o.symbol=f.market and o.exchange_order_id=f.exchange_order_id and o.state='FILLED'
            and o.request_payload#>>'{order,side}'=f.side
            and o.request_payload#>>'{order,position_effect}'=case when f.side='BUY' then 'OPEN' else 'CLOSE' end)
        or (f.side='SELL' and f.v17_order_id is null and exists(
          select 1 from jsonb_array_elements(coalesce(p.metadata#>'{exitProtection,orders}','[]')) o
          where o->>'actualOrderId'=f.exchange_order_id and o->>'terminal'='true'
            and o->>'accountingPending'='false' and o#>>'{spec,params,symbol}'=f.market
            and o#>>'{spec,params,side}'='SELL' and o#>>'{spec,params,reduceOnly}'='true'
            and o->'tradeIds' ? f.exchange_trade_id::text))),false)) verified
    into a from public.exchange_trade_fills f where f.v17_position_id=p.id;
  return coalesce(a.n>1 and a.verified and abs(a.bought-p.original_quantity)<0.00000001
    and abs(a.sold-p.original_quantity)<0.00000001 and abs(a.entry_fee-p.entry_fee_usdt)<0.000001
    and abs(a.entry_quote/a.bought-p.entry_price)<0.00000001
    and abs(a.net-p.realized_pnl_usdt)<0.000001,false);
exception when others then return false;
end $$;
revoke all on function public.v17_closed_fill_accounting_proven(uuid) from public,anon,authenticated;

create or replace function public.v17_reconcile_closed_fill_accounting(p_limit integer default 20)
returns integer language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='2s' as $$
declare p record;n integer:=0;changed integer;
begin
  if not pg_try_advisory_xact_lock(714024,33) then return 0;end if;
  for p in select x.id from public.v11_long_regime_positions x
    where x.state='CLOSED' and exists(select 1 from public.exchange_trade_fills f
      where f.v17_position_id=x.id and f.accounting_status='PENDING')
    order by x.closed_at desc,x.id limit greatest(1,least(p_limit,50)) for update skip locked
  loop
    perform 1 from public.exchange_trade_fills where v17_position_id=p.id for update;
    if public.v17_closed_fill_accounting_proven(p.id) then
      update public.exchange_trade_fills set accounting_status='ACCOUNTED',updated_at=clock_timestamp()
        where v17_position_id=p.id and accounting_status='PENDING';
      get diagnostics changed=row_count;n:=n+changed;
    end if;
  end loop;
  if n>0 then
    update public.v11_long_regime_runtime set last_accounting_settlement_at=clock_timestamp()
      where singleton;
  end if;
  return n;
end $$;
revoke all on function public.v17_reconcile_closed_fill_accounting(integer) from public,anon,authenticated;
grant execute on function public.v17_closed_fill_accounting_proven(uuid),
  public.v17_reconcile_closed_fill_accounting(integer) to service_role;

create or replace function public.v17_preserve_verified_fill_accounting()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  -- Repeated exchange sync must not regress a verified row. Any economic/ownership
  -- change is revalidated by the bounded reconciler, never silently inherited.
  if old.v17_position_id is not null and old.accounting_status='ACCOUNTED' and new.accounting_status='PENDING'
    and (to_jsonb(new)-array['accounting_status','updated_at'])=(to_jsonb(old)-array['accounting_status','updated_at'])
    and public.v17_closed_fill_accounting_proven(old.v17_position_id) then new.accounting_status:='ACCOUNTED';end if;
  return new;
end $$;
revoke all on function public.v17_preserve_verified_fill_accounting() from public,anon,authenticated;
create or replace trigger zzz_v17_preserve_verified_fill_accounting before update on public.exchange_trade_fills
  for each row execute function public.v17_preserve_verified_fill_accounting();
select cron.schedule('v17-closed-fill-accounting-5m','3-59/5 * * * *',
  'select public.v17_reconcile_closed_fill_accounting(20);');
commit;
