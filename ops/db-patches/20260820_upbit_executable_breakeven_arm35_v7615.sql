-- v7.6.15 — Upbit-specific pre-T1 profit protection.
--
-- Evidence basis (2026-08-20 rolling 24h replay):
--   * all 283 KRW markets replayed from the public Upbit candle API;
--   * 25 de-duplicated scanner BUY episodes replayed at 1-second resolution;
--   * 30-day production fees are 5bp per side (294 BUY / 289 SELL observations);
--   * arm-trigger sweep showed a stable 35–50bp performance plateau; 35bp is the
--     earliest point on that plateau and retains more protection opportunities;
--   * the protected floor itself is NOT a fixed bps offset. It is the exact
--     unrecovered-cost breakeven price rounded UP to Upbit's current KRW tick ladder.
--
-- Binance/Binance Futures v7.6.14 is intentionally untouched. The existing common
-- trigger is narrowed to non-Upbit rows and a dedicated Upbit trigger owns this policy.
-- Existing PRE_T1_PROFIT_PROTECTION_EXIT sell authority and the v7.6.8 positive-net
-- sanitizer remain unchanged.

create or replace function public.upbit_krw_tick_size_v7615(p_price numeric)
returns numeric
language sql
immutable
strict
set search_path to 'public'
as $function$
  select case
    when p_price >= 1000000 then 1000::numeric
    when p_price >= 500000 then 500::numeric
    when p_price >= 100000 then 100::numeric
    when p_price >= 50000 then 50::numeric
    when p_price >= 10000 then 10::numeric
    when p_price >= 5000 then 5::numeric
    when p_price >= 1000 then 1::numeric
    when p_price >= 100 then 1::numeric
    when p_price >= 10 then 0.1::numeric
    when p_price >= 1 then 0.01::numeric
    when p_price >= 0.1 then 0.001::numeric
    when p_price >= 0.01 then 0.0001::numeric
    when p_price >= 0.001 then 0.00001::numeric
    when p_price >= 0.0001 then 0.000001::numeric
    when p_price >= 0.00001 then 0.0000001::numeric
    else 0.00000001::numeric
  end;
$function$;

create or replace function public.upbit_ceil_valid_price_v7615(p_price numeric)
returns numeric
language plpgsql
immutable
strict
set search_path to 'public'
as $function$
declare
  v_price numeric := greatest(p_price, 0);
  v_tick numeric;
  v_next numeric;
  i integer;
begin
  if v_price <= 0 then return 0; end if;
  -- Re-evaluate the tick after rounding in case a band boundary is crossed.
  for i in 1..4 loop
    v_tick := public.upbit_krw_tick_size_v7615(v_price);
    v_next := ceil(v_price / v_tick) * v_tick;
    if v_next = v_price and mod(v_next, public.upbit_krw_tick_size_v7615(v_next)) = 0 then
      return v_next;
    end if;
    v_price := v_next;
  end loop;
  return v_price;
end;
$function$;

create or replace function public.upbit_floor_valid_price_v7615(p_price numeric)
returns numeric
language sql
immutable
strict
set search_path to 'public'
as $function$
  select case when p_price <= 0 then 0::numeric else
    floor(p_price / public.upbit_krw_tick_size_v7615(p_price)) *
      public.upbit_krw_tick_size_v7615(p_price)
  end;
$function$;

create or replace function public.protect_upbit_open_profit_v7615()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  v_entry numeric;
  v_peak numeric;
  v_mfe_bps numeric;
  v_original_stop numeric;
  v_existing_trail numeric;
  v_candidate_stop numeric;
  v_stage text := 'NONE';
  v_is_momentum boolean := false;
  v_held_seconds numeric := 0;

  v_buy_principal numeric := 0;
  v_exact_buy_fee numeric := 0;
  v_effective_buy_fee numeric := 0;
  v_observed_buy_fee_rate numeric := 0;
  v_exit_fee_rate numeric := 0;
  v_unrecovered_cost numeric := 0;
  v_remaining_quantity numeric := 0;
  v_raw_breakeven_price numeric := 0;
  v_breakeven_price numeric := 0;
  v_current_exec numeric := 0;
  v_current_net_quote numeric := 0;
  v_floor_net_quote numeric := 0;
  v_floor_net_bps numeric := 0;
  v_dynamic_armed boolean := false;

  v_cost_buffer_bps numeric := 0;
  v_lock_net_bps numeric := 0;
  v_profit_lock_trigger_bps numeric := 0;
  v_trail_trigger_bps numeric := 0;
  v_trail_distance_bps numeric := 0;
  v_stage_candidate numeric := 0;
  v_peak_tick numeric := 0;
  v_locked_net_bps_estimate numeric := 0;
  v_arm_trigger_bps numeric := 35;
begin
  if lower(coalesce(new.exchange, '')) <> 'upbit'
     or new.is_paper is distinct from false
     or new.state <> 'OPEN' then
    return new;
  end if;

  signal := coalesce(new.metadata->'lob_signal', new.metadata->'scalp_signal', '{}'::jsonb);
  if upper(coalesce(signal->>'strategy', '')) <> 'LOB_SCALP' then return new; end if;

  select * into cfg from public.trading_settings where id = 1;
  if not found or not cfg.lob_profit_protect_enabled then return new; end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(old.average_entry_price, 0), 0);
  v_peak := greatest(coalesce(new.peak_price, 0), coalesce(old.peak_price, 0), v_entry);
  if v_entry <= 0 or v_peak <= v_entry then return new; end if;

  if new.opened_at is not null then
    v_held_seconds := greatest(0, extract(epoch from (now() - new.opened_at)));
  end if;
  if v_held_seconds < cfg.lob_profit_protect_min_hold_seconds then return new; end if;

  v_is_momentum := upper(coalesce(signal->>'pattern', '')) = 'MOMENTUM_CONTINUATION';
  v_mfe_bps := (v_peak / v_entry - 1) * 10000;
  v_remaining_quantity := greatest(coalesce(new.remaining_quantity, 0), 0);
  if v_remaining_quantity <= 0 then return new; end if;

  select
    coalesce(sum(coalesce(o.executed_funds_quote, 0)), 0),
    coalesce(sum(coalesce(o.paid_fee_quote, 0)), 0)
  into v_buy_principal, v_exact_buy_fee
  from public.trading_orders o
  where o.position_id = new.id
    and upper(coalesce(o.side, '')) = 'BUY'
    and o.state in ('APPLIED', 'EXCHANGE_DONE', 'EXCHANGE_PARTIAL_CANCELLED')
    and coalesce(o.executed_volume, 0) > 0;

  if v_buy_principal <= 0 then
    v_buy_principal := greatest(
      coalesce(new.realized_cost_quote, 0),
      coalesce(new.initial_quantity, 0) * v_entry
    );
  end if;
  if v_buy_principal <= 0 then return new; end if;

  -- Upbit production observations are exactly 5bp per side. The observed BUY fee is
  -- authoritative when present; 5bp is a fail-safe floor, not an optimization constant.
  v_observed_buy_fee_rate := case
    when v_exact_buy_fee > 0 then v_exact_buy_fee / v_buy_principal
    else 0
  end;
  v_exit_fee_rate := least(0.01, greatest(0.0005, v_observed_buy_fee_rate));
  v_effective_buy_fee := greatest(v_exact_buy_fee, v_buy_principal * 0.0005);
  v_unrecovered_cost := greatest(
    0,
    v_buy_principal + v_effective_buy_fee - coalesce(new.realized_proceeds_quote, 0)
  );
  if v_unrecovered_cost <= 0 or v_exit_fee_rate >= 1 then return new; end if;

  v_raw_breakeven_price := v_unrecovered_cost /
    (v_remaining_quantity * (1 - v_exit_fee_rate));
  v_breakeven_price := public.upbit_ceil_valid_price_v7615(v_raw_breakeven_price);
  v_current_exec := greatest(public.safe_numeric_v6112(new.metadata#>>'{live_mark,executable_price}'), 0);
  v_current_net_quote := case when v_current_exec > 0 then
    v_current_exec * v_remaining_quantity * (1 - v_exit_fee_rate) - v_unrecovered_cost
    else 0 end;
  v_floor_net_quote := v_breakeven_price * v_remaining_quantity *
    (1 - v_exit_fee_rate) - v_unrecovered_cost;
  v_floor_net_bps := case when v_unrecovered_cost > 0 then
    v_floor_net_quote / v_unrecovered_cost * 10000 else 0 end;

  v_original_stop := coalesce(
    public.safe_numeric_v6112(old.metadata#>>'{profit_protection,original_stop_price}'),
    old.stop_price,
    new.stop_price
  );
  v_existing_trail := greatest(
    coalesce(old.trailing_stop, 0),
    coalesce(new.trailing_stop, 0),
    coalesce(v_original_stop, 0),
    coalesce(old.stop_price, 0),
    coalesce(new.stop_price, 0)
  );
  v_candidate_stop := v_existing_trail;

  -- Upbit-only first protection stage: wait for the empirically selected 35bp arm,
  -- then protect the exact economic floor rather than a fixed +12bp gross stop.
  if coalesce(new.t1_completed, false) = false
     and v_mfe_bps >= v_arm_trigger_bps
     and v_current_exec > v_breakeven_price
     and v_current_net_quote > 0
     and v_floor_net_quote > 0 then
    v_dynamic_armed := true;
    v_stage := 'UPBIT_EXECUTABLE_BREAKEVEN';
    v_candidate_stop := greatest(v_candidate_stop, v_breakeven_price);
  end if;

  -- Preserve the existing higher-profit lock/trailing stages. Their trigger geometry
  -- remains unchanged; only the first cost-recovery stage is venue-specific now.
  v_cost_buffer_bps := greatest(
    cfg.lob_profit_protect_cost_buffer_bps_upbit,
    v_observed_buy_fee_rate * 10000 * 2 + 2
  );
  v_lock_net_bps := case
    when v_is_momentum then cfg.lob_momentum_profit_lock_net_bps
    else cfg.lob_profit_lock_net_bps
  end;
  v_profit_lock_trigger_bps := greatest(
    cfg.lob_profit_lock_trigger_bps,
    v_cost_buffer_bps + v_lock_net_bps + 2
  );
  v_trail_trigger_bps := greatest(
    cfg.lob_profit_trail_trigger_bps,
    v_cost_buffer_bps + case
      when v_is_momentum then cfg.lob_momentum_trail_net_trigger_bps
      else 20
    end
  );
  v_trail_distance_bps := case
    when v_is_momentum then cfg.lob_momentum_profit_trail_distance_bps
    else cfg.lob_profit_trail_distance_bps
  end;

  if v_mfe_bps >= v_profit_lock_trigger_bps then
    v_stage_candidate := public.upbit_floor_valid_price_v7615(
      v_entry * (1 + (v_cost_buffer_bps + v_lock_net_bps) / 10000)
    );
    if v_stage_candidate > v_candidate_stop then
      v_candidate_stop := v_stage_candidate;
      v_stage := 'NET_PROFIT_LOCK';
    end if;
  end if;

  if v_mfe_bps >= v_trail_trigger_bps then
    v_stage_candidate := public.upbit_floor_valid_price_v7615(
      v_peak * (1 - v_trail_distance_bps / 10000)
    );
    v_peak_tick := public.upbit_krw_tick_size_v7615(v_peak);
    v_stage_candidate := least(v_stage_candidate, v_peak - v_peak_tick);
    if v_stage_candidate > v_candidate_stop then
      v_candidate_stop := v_stage_candidate;
      v_stage := case when v_is_momentum then 'MOMENTUM_PEAK_TRAIL' else 'PEAK_TRAIL' end;
    end if;
  end if;

  v_candidate_stop := greatest(v_candidate_stop, v_existing_trail);
  if v_candidate_stop <= coalesce(new.trailing_stop, 0) then return new; end if;

  -- Every newly raised Upbit stop must be positive after the same exact fee model.
  v_locked_net_bps_estimate := case when v_unrecovered_cost > 0 then
    (v_candidate_stop * v_remaining_quantity * (1 - v_exit_fee_rate) - v_unrecovered_cost)
      / v_unrecovered_cost * 10000
    else 0 end;
  if v_locked_net_bps_estimate <= 0 or v_current_exec <= v_candidate_stop then
    return new;
  end if;

  new.trailing_stop := v_candidate_stop;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'profit_protection',
    jsonb_build_object(
      'revision', '7.6.15-UPBIT-EXECUTABLE-BREAKEVEN-ARM35',
      'venue_policy', 'UPBIT_KRW',
      'stage', v_stage,
      'momentum_lane', v_is_momentum,
      'arm_trigger_bps', v_arm_trigger_bps,
      'original_stop_price', v_original_stop,
      'protected_stop_price', v_candidate_stop,
      'protection_column', 'trailing_stop',
      'peak_price', v_peak,
      'mfe_bps', round(v_mfe_bps, 4),
      'raw_breakeven_price', v_raw_breakeven_price,
      'upbit_tick_size_at_floor', public.upbit_krw_tick_size_v7615(v_breakeven_price),
      'dynamic_breakeven_price', v_breakeven_price,
      'dynamic_breakeven_armed', v_dynamic_armed,
      'current_executable_price', v_current_exec,
      'current_executable_net_profit_quote', v_current_net_quote,
      'exact_buy_principal_quote', v_buy_principal,
      'exact_buy_fee_quote', v_exact_buy_fee,
      'effective_buy_fee_quote', v_effective_buy_fee,
      'observed_buy_fee_bps', round(v_observed_buy_fee_rate * 10000, 4),
      'exit_fee_bps', round(v_exit_fee_rate * 10000, 4),
      'exact_unrecovered_cost_quote', v_unrecovered_cost,
      'breakeven_floor_net_quote', v_floor_net_quote,
      'breakeven_floor_net_bps', round(v_floor_net_bps, 4),
      'profit_lock_trigger_bps', round(v_profit_lock_trigger_bps, 4),
      'trail_trigger_bps', round(v_trail_trigger_bps, 4),
      'trail_distance_bps', round(v_trail_distance_bps, 4),
      'locked_gross_bps', round((v_candidate_stop / v_entry - 1) * 10000, 4),
      'locked_net_bps_estimate', round(v_locked_net_bps_estimate, 4),
      'updated_at', now()
    )
  );
  return new;
end;
$function$;

-- Keep the Binance/Binance Futures v7.6.14 function intact and narrow only its trigger.
drop trigger if exists aa_trading_positions_profit_protection_v6130 on public.trading_positions;
create trigger aa_trading_positions_profit_protection_v6130
before update of peak_price, paid_fees_quote, realized_cost_quote
on public.trading_positions
for each row
when (lower(coalesce(new.exchange, '')) <> 'upbit')
execute function public.protect_lob_open_profit_v6130();

drop trigger if exists aa0_trading_positions_upbit_profit_protection_v7615 on public.trading_positions;
create trigger aa0_trading_positions_upbit_profit_protection_v7615
before update of peak_price, paid_fees_quote, realized_cost_quote
on public.trading_positions
for each row
when (lower(coalesce(new.exchange, '')) = 'upbit')
execute function public.protect_upbit_open_profit_v7615();

comment on function public.protect_upbit_open_profit_v7615() is
  'v7.6.15 Upbit KRW: 35bp arm + exact fee breakeven rounded upward to the venue KRW tick, with existing higher profit locks preserved.';

-- Deployment invariants: fail atomically on source/trigger drift.
do $$
declare
  v_upbit_def text;
  v_binance_def text;
  v_sanitizer text;
  v_common_trigger text;
  v_upbit_trigger text;
  v_sanitize_trigger_name text;
begin
  select pg_get_functiondef('public.protect_upbit_open_profit_v7615()'::regprocedure) into v_upbit_def;
  select pg_get_functiondef('public.protect_lob_open_profit_v6130()'::regprocedure) into v_binance_def;
  select pg_get_functiondef('public.sanitize_pre_t1_profit_protection_v768()'::regprocedure) into v_sanitizer;

  if position('7.6.15-UPBIT-EXECUTABLE-BREAKEVEN-ARM35' in v_upbit_def) = 0
     or position('v_arm_trigger_bps numeric := 35' in v_upbit_def) = 0
     or position('upbit_ceil_valid_price_v7615' in v_upbit_def) = 0
     or position('v_current_exec > v_breakeven_price' in v_upbit_def) = 0
     or position('v_floor_net_quote > 0' in v_upbit_def) = 0 then
    raise exception 'UPBIT_V7615_FUNCTION_INVARIANT_FAILED';
  end if;

  -- Binance v7.6.14 must survive bytecode replacement untouched.
  if position('7.6.14-EXECUTABLE-BREAKEVEN' in v_binance_def) = 0
     or position('v_current_exact_net > 0' in v_binance_def) = 0 then
    raise exception 'BINANCE_V7614_REGRESSION';
  end if;
  if position('RETROACTIVE_PROFIT_PROTECTION_BLOCKED' in v_sanitizer) = 0 then
    raise exception 'PRE_T1_SANITIZER_REGRESSION';
  end if;

  select pg_get_triggerdef(oid) into v_common_trigger from pg_trigger
  where tgrelid='public.trading_positions'::regclass and tgname='aa_trading_positions_profit_protection_v6130';
  select pg_get_triggerdef(oid) into v_upbit_trigger from pg_trigger
  where tgrelid='public.trading_positions'::regclass and tgname='aa0_trading_positions_upbit_profit_protection_v7615';
  select tgname into v_sanitize_trigger_name from pg_trigger
  where tgrelid='public.trading_positions'::regclass and not tgisinternal
    and pg_get_triggerdef(oid) like '%sanitize_pre_t1_profit_protection_v768%' limit 1;

  if v_common_trigger is null or position('upbit' in lower(v_common_trigger)) = 0
     or position('<>' in v_common_trigger) = 0 then
    raise exception 'COMMON_TRIGGER_NOT_ISOLATED_FROM_UPBIT';
  end if;
  if v_upbit_trigger is null or position('upbit' in lower(v_upbit_trigger)) = 0 then
    raise exception 'UPBIT_TRIGGER_MISSING';
  end if;
  if v_sanitize_trigger_name is null or 'aa0_trading_positions_upbit_profit_protection_v7615' >= v_sanitize_trigger_name then
    raise exception 'UPBIT_SANITIZER_TRIGGER_ORDER_INVALID';
  end if;
end
$$;
