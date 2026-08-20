begin;

update public.trading_settings
set lob_observation_window_ms = 50000,
    version = version + 1,
    updated_at = now()
where id = 1;

create or replace function public.enforce_lob_live_admission_v711()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_signal jsonb;
  v_features jsonb;
  v_observation_ms numeric;
  v_universe_mode text;
  v_gainer_rank numeric;
  v_spread numeric;
  v_bid_depth numeric;
  v_ask_depth numeric;
  v_max_spread numeric;
begin
  if coalesce(new.is_paper,true) or new.state <> 'ENTRY_PENDING' then
    return new;
  end if;

  v_signal := coalesce(new.metadata -> 'lob_signal', new.metadata -> 'scalp_signal', '{}'::jsonb);
  if upper(coalesce(v_signal ->> 'strategy','')) <> 'LOB_SCALP' then
    return new;
  end if;

  v_features := coalesce(v_signal -> 'features','{}'::jsonb);
  v_observation_ms := public.safe_numeric_v6112(v_features ->> 'observationMs');
  v_universe_mode := upper(coalesce(v_features ->> 'universeMode',''));
  v_gainer_rank := public.safe_numeric_v6112(v_features ->> 'gainerRank');
  v_spread := coalesce(
    public.safe_numeric_v6112(new.metadata ->> 'live_spread_bps'),
    public.safe_numeric_v6112(v_features ->> 'spreadBps')
  );
  v_bid_depth := public.safe_numeric_v6112(v_features ->> 'bidDepthQuote');
  v_ask_depth := public.safe_numeric_v6112(v_features ->> 'askDepthQuote');
  select lob_max_spread_bps into v_max_spread from public.trading_settings where id=1;
  v_max_spread := coalesce(v_max_spread,35);

  if v_observation_ms is null or v_observation_ms < 50000 then
    raise exception using errcode='23514', message=format('V720_LIVE_OBSERVATION_UNDER_50S market=%s observation_ms=%s',new.market,coalesce(v_observation_ms::text,'null'));
  end if;
  if v_universe_mode <> 'TOP10_24H_GAINERS_LOB_ONLY' or v_gainer_rank is null or v_gainer_rank < 1 or v_gainer_rank > 10 then
    raise exception using errcode='23514', message=format('V720_OUTSIDE_TOP10 market=%s mode=%s rank=%s',new.market,coalesce(v_universe_mode,'null'),coalesce(v_gainer_rank::text,'null'));
  end if;
  if v_spread is null or v_spread > v_max_spread then
    raise exception using errcode='23514', message=format('V720_SPREAD_TOO_WIDE market=%s spread_bps=%s max=%s',new.market,coalesce(v_spread::text,'null'),v_max_spread);
  end if;
  if coalesce(v_bid_depth,0) <= 0 or coalesce(v_ask_depth,0) <= 0 then
    raise exception using errcode='23514', message=format('V720_INSUFFICIENT_DEPTH market=%s bid_depth=%s ask_depth=%s',new.market,coalesce(v_bid_depth::text,'null'),coalesce(v_ask_depth::text,'null'));
  end if;

  return new;
end;
$function$;

create or replace function public.enforce_top10_lob_only_v700()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  features jsonb;
  v_mode text;
  v_rank integer;
  v_observation_ms numeric;
  v_spread numeric;
  v_bid_depth numeric;
  v_ask_depth numeric;
  reasons text[] := array[]::text[];
begin
  if new.is_paper is distinct from false or new.state <> 'ENTRY_PENDING' then
    return new;
  end if;

  signal := coalesce(new.metadata -> 'lob_signal', new.metadata -> 'scalp_signal', '{}'::jsonb);
  if upper(coalesce(signal ->> 'strategy', '')) <> 'LOB_SCALP' then
    return new;
  end if;

  select * into cfg from public.trading_settings where id = 1;
  if not found then
    raise exception using errcode='P0001', message='LOB_ADMISSION_REJECT: trading_settings id=1 unavailable';
  end if;

  features := coalesce(signal -> 'features', '{}'::jsonb);
  v_mode := upper(coalesce(features ->> 'universeMode', ''));
  v_rank := public.safe_integer_v6112(features ->> 'gainerRank');
  v_observation_ms := public.safe_numeric_v6112(features ->> 'observationMs');
  v_spread := coalesce(
    public.safe_numeric_v6112(new.metadata ->> 'live_spread_bps'),
    public.safe_numeric_v6112(features ->> 'spreadBps')
  );
  v_bid_depth := public.safe_numeric_v6112(features ->> 'bidDepthQuote');
  v_ask_depth := public.safe_numeric_v6112(features ->> 'askDepthQuote');

  if v_mode <> 'TOP10_24H_GAINERS_LOB_ONLY' then
    reasons := array_append(reasons, 'UNIVERSE_NOT_TOP10_24H_GAINERS');
  end if;
  if v_rank is null or v_rank < 1 or v_rank > 10 then
    reasons := array_append(reasons, 'OUTSIDE_24H_GAINER_TOP10');
  end if;
  if v_observation_ms is null or v_observation_ms < 50000 then
    reasons := array_append(reasons, 'INSUFFICIENT_50S_OBSERVATION');
  end if;
  if v_spread is null or v_spread > cfg.lob_max_spread_bps then
    reasons := array_append(reasons, 'SPREAD_TOO_WIDE');
  end if;
  if coalesce(v_bid_depth,0) <= 0 or coalesce(v_ask_depth,0) <= 0 then
    reasons := array_append(reasons, 'INSUFFICIENT_EXECUTABLE_DEPTH');
  end if;

  if cardinality(reasons) > 0 then
    raise exception using
      errcode='P0001',
      message=format('LOB_ADMISSION_REJECT[%s:%s]: %s',new.exchange,new.market,array_to_string(reasons,','));
  end if;

  new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
    'entry_admission',
    jsonb_build_object(
      'revision','7.2.0-TOP10-50S-BOOK-ONLY',
      'mode',v_mode,
      'gainer_rank',v_rank,
      'observation_ms',v_observation_ms,
      'spread_bps',round(v_spread,4),
      'bid_depth_quote',v_bid_depth,
      'ask_depth_quote',v_ask_depth,
      'checked_at',now()
    )
  );
  return new;
end;
$function$;

commit;
