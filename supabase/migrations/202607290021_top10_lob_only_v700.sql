-- Trading-booooo v7.0.0-TOP10-LOB-ONLY
-- Replace overlapping historical/EV admission gates with one current-book contract.
-- Account reconciliation, reservation, profit protection and the runtime daily-loss circuit
-- remain unchanged.

drop trigger if exists aa0_trading_positions_momentum_ioc_v6142
  on public.trading_positions;
drop trigger if exists ab0_trading_positions_lob_momentum_v6140
  on public.trading_positions;
drop trigger if exists ab_trading_positions_lob_direction_geometry_v6123
  on public.trading_positions;
drop trigger if exists ac_trading_positions_lob_realized_edge_v6130
  on public.trading_positions;
drop trigger if exists trading_positions_lob_live_guard_v6121
  on public.trading_positions;

create or replace function public.enforce_top10_lob_only_v700()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  features jsonb;
  v_mode text;
  v_rank integer;
  v_notional numeric;
  v_notional_trend numeric;
  v_trade_speed_trend numeric;
  v_tape_speed_trend numeric;
  v_pressure numeric;
  v_microprice numeric;
  v_spread numeric;
  v_target_net numeric;
  v_stop numeric;
  v_dynamic text;
  v_traps jsonb;
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
    raise exception using
      errcode = 'P0001',
      message = 'LOB_ADMISSION_REJECT: trading_settings id=1 unavailable';
  end if;

  features := coalesce(signal -> 'features', '{}'::jsonb);
  v_mode := upper(coalesce(features ->> 'universeMode', ''));
  v_rank := public.safe_integer_v6112(features ->> 'gainerRank');
  v_notional := public.safe_numeric_v6112(features ->> 'recentNotionalPerSecond');
  v_notional_trend := public.safe_numeric_v6112(features ->> 'notionalTrend');
  v_trade_speed_trend := public.safe_numeric_v6112(features ->> 'tradeSpeedTrend');
  v_tape_speed_trend := public.safe_numeric_v6112(features ->> 'tradeArrivalTrend');
  v_pressure := public.safe_numeric_v6112(features ->> 'tradePressureFast');
  v_microprice := public.safe_numeric_v6112(features ->> 'micropriceDeviationBps');
  v_spread := coalesce(
    public.safe_numeric_v6112(new.metadata ->> 'live_spread_bps'),
    public.safe_numeric_v6112(features ->> 'spreadBps')
  );
  v_target_net := public.safe_numeric_v6112(signal ->> 'target_return_net_bps');
  v_stop := public.safe_numeric_v6112(signal ->> 'stop_bps');
  v_dynamic := upper(coalesce(features ->> 'dynamicStatus', 'UNKNOWN'));
  v_traps := coalesce(signal -> 'traps', '[]'::jsonb);

  if v_mode <> 'TOP10_24H_GAINERS_LOB_ONLY' then
    reasons := array_append(reasons, 'UNIVERSE_NOT_TOP10_24H_GAINERS');
  end if;
  if v_rank is null or v_rank < 1 or v_rank > 10 then
    reasons := array_append(reasons, 'OUTSIDE_24H_GAINER_TOP10');
  end if;
  if coalesce(v_notional, 0) <= 0 then
    reasons := array_append(reasons, 'NO_RECENT_NOTIONAL_FLOW');
  end if;
  if coalesce(v_notional_trend, -999) < -0.20 then
    reasons := array_append(reasons, 'FLOW_NOTIONAL_DECLINING');
  end if;
  if coalesce(v_trade_speed_trend, -999) < -0.20 then
    reasons := array_append(reasons, 'FLOW_TRADE_SPEED_DECLINING');
  end if;
  if coalesce(v_tape_speed_trend, -999) < -0.20 then
    reasons := array_append(reasons, 'TAPE_SPEED_DECLINING');
  end if;
  if coalesce(v_pressure, -999) < -0.10 then
    reasons := array_append(reasons, 'SELL_PRESSURE_DOMINANT');
  end if;
  if coalesce(v_microprice, -999) < -1.0 then
    reasons := array_append(reasons, 'MICROPRICE_BEARISH');
  end if;
  if v_dynamic in ('SPOOF_LIKE_RISK', 'ASK_ABSORPTION_RISK', 'SUPPORT_BREAKDOWN_RISK') then
    reasons := array_append(reasons, 'ADVERSE_DYNAMIC_ORDERFLOW');
  end if;
  if jsonb_typeof(v_traps) = 'array' and (
    v_traps ? 'ASK_ICEBERG' or
    v_traps ? 'BID_SPOOF' or
    v_traps ? 'CHOP_NO_VIABLE_STOP'
  ) then
    reasons := array_append(reasons, 'LOB_TRAP');
  end if;
  if v_spread is null or v_spread > cfg.lob_max_spread_bps then
    reasons := array_append(reasons, 'SPREAD_TOO_WIDE');
  end if;
  if coalesce(v_target_net, 0) <= 0 then
    reasons := array_append(reasons, 'TARGET_NET_PROFIT_NOT_POSITIVE');
  end if;
  if v_stop is null or v_stop <= 0 or v_stop > 500 then
    reasons := array_append(reasons, 'STOP_OUTSIDE_ABSOLUTE_CAP');
  end if;

  if cardinality(reasons) > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'LOB_ADMISSION_REJECT[%s:%s]: %s',
        new.exchange,
        new.market,
        array_to_string(reasons, ',')
      );
  end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'entry_admission',
    jsonb_build_object(
      'revision', '7.0.0-TOP10-LOB-ONLY',
      'mode', v_mode,
      'gainer_rank', v_rank,
      'notional_trend', round(v_notional_trend, 4),
      'trade_speed_trend', round(v_trade_speed_trend, 4),
      'tape_speed_trend', round(v_tape_speed_trend, 4),
      'trade_pressure', round(v_pressure, 4),
      'microprice_bps', round(v_microprice, 4),
      'spread_bps', round(v_spread, 4),
      'checked_at', now()
    )
  );
  return new;
end;
$$;

drop trigger if exists aa_trading_positions_top10_lob_only_v700
  on public.trading_positions;
create trigger aa_trading_positions_top10_lob_only_v700
before insert on public.trading_positions
for each row execute function public.enforce_top10_lob_only_v700();

comment on function public.enforce_top10_lob_only_v700() is
  'LIVE LOB entry admission: per-exchange rolling 24h gainer Top 10, non-declining turnover/tape, current order-book safety, fee-net positive target and 5% absolute stop cap.';

