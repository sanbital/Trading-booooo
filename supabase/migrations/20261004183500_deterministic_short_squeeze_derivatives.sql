-- Optional derivatives telemetry for the deterministic engine.
-- It never replaces the validated 24-bucket book/flow capture and never becomes
-- an entry authority by itself.
create or replace function public.deterministic_derivative_context(
  p_symbols text[],
  p_as_of timestamptz
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  r jsonb:='{}'::jsonb;
  s text;
  item jsonb;
begin
  if p_symbols is null or cardinality(p_symbols) not between 1 and 48 or p_as_of is null
    or exists(select 1 from unnest(p_symbols) x where x is null or x !~ '^[[:alnum:]]{1,24}USDT$')
    or p_as_of>clock_timestamp()+interval '1 second'
    or p_as_of<clock_timestamp()-interval '10 seconds'
  then raise exception 'derivative context bounds'; end if;

  foreach s in array p_symbols loop
    begin
      with rows as (
        select at,payload
        from doa_capture.live_micro
        where kind='micro'
          and symbol=upper(btrim(s))
          and at<=p_as_of
          and at>p_as_of-interval '155 seconds'
        order by at desc
        limit 24
      ), stats as (
        select count(*) n,max(at) newest from rows
      ), series as (
        select jsonb_agg(
          jsonb_build_object(
            'bucket_ms',floor(extract(epoch from at)*1000),
            'funding_rate',nullif(payload->>'funding_rate','')::numeric,
            'mark_price',nullif(payload->>'mark_price','')::numeric,
            'index_price',nullif(payload->>'index_price','')::numeric,
            'basis_bps',nullif(payload->>'basis_bps','')::numeric,
            'mark_event_ms',case when nullif(payload->>'mark_event_at','') is not null
              then floor(extract(epoch from (payload->>'mark_event_at')::timestamptz)*1000) end,
            'open_interest',nullif(payload->>'open_interest','')::numeric,
            'open_interest_at_ms',case when nullif(payload->>'open_interest_at','') is not null
              then floor(extract(epoch from (payload->>'open_interest_at')::timestamptz)*1000) end
          ) order by at
        ) trajectory
        from rows
      )
      select case
        when (select n from stats)=0 then jsonb_build_object('status','UNAVAILABLE','reason','DERIVATIVES_WARMUP')
        when (select newest from stats)<p_as_of-interval '15 seconds'
          then jsonb_build_object('status','UNAVAILABLE','reason','DERIVATIVES_STALE')
        else jsonb_build_object('status','AVAILABLE','buckets',(select n from stats),'trajectory',coalesce((select trajectory from series),'[]'::jsonb))
      end into item;
    exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
      item:=jsonb_build_object('status','UNAVAILABLE','reason','DERIVATIVES_MALFORMED');
    end;
    r:=r||jsonb_build_object(s,item);
  end loop;
  return r;
end $$;

revoke all on function public.deterministic_derivative_context(text[],timestamptz) from public,anon,authenticated;
grant execute on function public.deterministic_derivative_context(text[],timestamptz) to service_role;
