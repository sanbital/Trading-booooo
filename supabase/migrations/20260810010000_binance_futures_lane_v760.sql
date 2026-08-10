begin;

-- ---------------------------------------------------------------------------
-- v7.6.0 — Binance USDⓈ-M futures lane.
--
-- Entry logic is unchanged and identical to spot: the futures lane trades the mirrored
-- Binance spot signal, long only. Only the SELL side is new, and it is stated on margin
-- (return on equity) rather than on price:
--
--     first 50%  ->  +15% ROE take profit  /  -12% ROE stop loss
--     residual   ->  +30% ROE take profit,
--                    unless the remainder has been running negative, in which case it
--                    is sold whole the moment its own net PnL turns positive.
--
-- At the default 3x these are +5% / -4% / +10% on price, so the spot lane's numbers are
-- untouched — this migration derives the price levels from leverage instead of hardcoding
-- them, which is what keeps the two lanes consistent if the leverage setting ever moves.
--
-- Nothing here changes any spot threshold, sizing rule, entry gate or emergency exit.
-- ---------------------------------------------------------------------------

-- 1. Venue identity ---------------------------------------------------------

-- The market-route constraints are a per-exchange pair (venue, symbol grammar), so they
-- are restated rather than pattern-edited.
alter table public.scanner_candidates
  drop constraint if exists scanner_candidates_market_route_ck;
alter table public.scanner_candidates
  add constraint scanner_candidates_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{1,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{1,24}USDT$') or
    (exchange = 'binance_futures' and market ~ '^[A-Z0-9]{1,24}USDT$')
  ) not valid;

alter table public.trading_positions
  drop constraint if exists trading_positions_market_route_ck;
alter table public.trading_positions
  add constraint trading_positions_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{1,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{1,24}USDT$') or
    (exchange = 'binance_futures' and market ~ '^[A-Z0-9]{1,24}USDT$')
  ) not valid;

alter table public.trading_orders
  drop constraint if exists trading_orders_market_route_ck;
alter table public.trading_orders
  add constraint trading_orders_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{1,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{1,24}USDT$') or
    (exchange = 'binance_futures' and market ~ '^[A-Z0-9]{1,24}USDT$')
  ) not valid;

-- The venue/quote-currency pairings. These are written as an OR of equalities rather than
-- an IN list, so they need the third arm spelled out.
alter table public.scanner_candidates
  drop constraint if exists scanner_candidates_quote_currency_check;
alter table public.scanner_candidates
  add constraint scanner_candidates_quote_currency_check
  check (
    (exchange = 'upbit' and quote_currency = 'KRW') or
    (exchange = 'binance' and quote_currency = 'USDT') or
    (exchange = 'binance_futures' and quote_currency = 'USDT')
  ) not valid;

alter table public.trading_positions
  drop constraint if exists trading_positions_check;
alter table public.trading_positions
  add constraint trading_positions_check
  check (
    (exchange = 'upbit' and quote_currency = 'KRW' and market like 'KRW-%') or
    (exchange = 'binance' and quote_currency = 'USDT' and market like '%USDT') or
    (exchange = 'binance_futures' and quote_currency = 'USDT' and market like '%USDT')
  ) not valid;

-- Every other `exchange in ('upbit','binance')` check, wherever it lives. Rewriting the
-- rendered definition rather than enumerating table names means a table added by a future
-- migration with the same idiom is covered too, and a table using some other idiom is
-- left alone instead of being silently mangled.
do $exchange_lists$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select c.conname,
           c.oid as constraint_oid,
           c.conrelid::regclass::text as table_name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'c'
      and n.nspname = 'public'
  loop
    v_def := pg_get_constraintdef(r.constraint_oid);
    if v_def not like '%exchange = ANY (ARRAY[%'
       or v_def not like '%''binance''::text%'
       or v_def like '%binance_futures%' then
      continue;
    end if;
    -- A constraint that is already NOT VALID renders with the suffix, and re-appending it
    -- would be a syntax error.
    v_def := regexp_replace(v_def, '\s+NOT VALID$', '');
    v_new := replace(
      v_def,
      '''binance''::text',
      '''binance''::text, ''binance_futures''::text'
    );
    execute format('alter table %s drop constraint %I', r.table_name, r.conname);
    execute format('alter table %s add constraint %I %s not valid', r.table_name, r.conname, v_new);
  end loop;
end;
$exchange_lists$;

-- Stored functions that validate an exchange argument against the same two-value list.
-- Only the list is rewritten; the rest of each body is re-pushed exactly as stored.
do $exchange_guards$
declare
  r record;
  v_def text;
  v_new text;
begin
  -- pg_get_functiondef() raises on aggregates and on some internal functions, so the
  -- candidate set is narrowed to ordinary SQL/PL functions BEFORE it is ever called.
  for r in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public'
      and p.prokind = 'f'
      and l.lanname in ('plpgsql', 'sql')
  loop
    v_def := pg_get_functiondef(r.oid);
    if v_def like '%binance_futures%'
       or (
         v_def not like '%in (''upbit'',''binance'')%' and
         v_def not like '%in (''upbit'', ''binance'')%'
       ) then
      continue;
    end if;
    v_new := replace(v_def, 'in (''upbit'',''binance'')', 'in (''upbit'',''binance'',''binance_futures'')');
    v_new := replace(v_new, 'in (''upbit'', ''binance'')', 'in (''upbit'', ''binance'', ''binance_futures'')');
    execute v_new;
  end loop;
end;
$exchange_guards$;

-- 2. Futures configuration --------------------------------------------------

alter table public.trading_settings
  add column if not exists binance_futures_enabled boolean not null default false,
  add column if not exists binance_futures_leverage integer not null default 3,
  add column if not exists binance_futures_allocation_mode text not null default 'ALL',
  add column if not exists binance_futures_allocation_usdt numeric not null default 0,
  add column if not exists binance_futures_reserve_usdt numeric not null default 0;

alter table public.trading_settings
  drop constraint if exists trading_settings_binance_futures_leverage_ck;
alter table public.trading_settings
  add constraint trading_settings_binance_futures_leverage_ck
  check (binance_futures_leverage between 1 and 20);

alter table public.trading_settings
  drop constraint if exists trading_settings_binance_futures_allocation_mode_ck;
alter table public.trading_settings
  add constraint trading_settings_binance_futures_allocation_mode_ck
  check (binance_futures_allocation_mode in ('ALL', 'FIXED'));

-- Leverage is recorded on the position, not looked up at exit time: the thresholds are
-- stated on margin, so a running position must be closed at the leverage it was opened
-- with even if the operator changes the setting underneath it.
alter table public.trading_positions
  add column if not exists leverage numeric not null default 1;

alter table public.trading_positions
  drop constraint if exists trading_positions_leverage_ck;
alter table public.trading_positions
  add constraint trading_positions_leverage_ck
  check (leverage >= 1 and leverage <= 20) not valid;

create index if not exists trading_positions_exchange_state_idx
  on public.trading_positions (exchange, state);

-- 3. Exit policy ------------------------------------------------------------

-- Price levels for one position, derived from its venue and leverage. Spot keeps the
-- literal 5 / -4 / 10 it has always had; futures divides the ROE gates by leverage.
create or replace function public.position_exit_levels_v760(
  p_exchange text,
  p_leverage numeric,
  p_entry numeric
)
returns table (
  stop_price numeric,
  target_1 numeric,
  target_2 numeric,
  first_tp_pct numeric,
  first_sl_pct numeric,
  residual_tp_pct numeric,
  leverage numeric,
  futures boolean
)
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_futures boolean := lower(coalesce(p_exchange, '')) = 'binance_futures';
  v_leverage numeric := case
    when v_futures then least(20, greatest(1, coalesce(nullif(p_leverage, 0), 3)))
    else 1
  end;
  v_first_tp numeric;
  v_first_sl numeric;
  v_residual_tp numeric;
begin
  if v_futures then
    v_first_tp := 15 / v_leverage;
    v_first_sl := -12 / v_leverage;
    v_residual_tp := 30 / v_leverage;
  else
    v_first_tp := 5;
    v_first_sl := -4;
    v_residual_tp := 10;
  end if;
  return query select
    p_entry * (1 + v_first_sl / 100),
    p_entry * (1 + v_first_tp / 100),
    p_entry * (1 + v_residual_tp / 100),
    v_first_tp,
    v_first_sl,
    v_residual_tp,
    v_leverage,
    v_futures;
end;
$function$;

create or replace function public.enforce_residual_exit_position_policy_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
  v_levels record;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(new.initial_quantity, 0) <= 0 then
    return new;
  end if;

  v_step := greatest(0, coalesce(new.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, new.initial_quantity * 0.00000001);
  v_residual_stage := coalesce(new.remaining_quantity, new.initial_quantity) <=
    new.initial_quantity * 0.5 + v_tolerance;

  select * into v_levels
  from public.position_exit_levels_v760(new.exchange, new.leverage, v_entry);

  new.stop_price := v_levels.stop_price;
  new.target_1 := v_levels.target_1;
  new.target_2 := v_levels.target_2;
  new.t1_allocation_pct := 50;
  new.t1_completed := v_residual_stage;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.6.0-BINANCE-FUTURES',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'first_tranche_ratio', 0.5,
      'residual_ratio', 0.5,
      'leverage', v_levels.leverage,
      'basis', case when v_levels.futures then 'RETURN_ON_MARGIN' else 'RETURN_ON_PRICE' end,
      'first_take_profit_pct', v_levels.first_tp_pct,
      'first_stop_loss_pct', v_levels.first_sl_pct,
      'residual_take_profit_pct', v_levels.residual_tp_pct,
      'residual_stop_loss_pct', case when v_levels.futures then null else -4 end,
      'first_take_profit_roe_pct', case when v_levels.futures then 15 else null end,
      'first_stop_loss_roe_pct', case when v_levels.futures then -12 else null end,
      'residual_take_profit_roe_pct', case when v_levels.futures then 30 else null end,
      'winner_residual_mode', case when v_levels.futures then 'ROE30' else 'TP10_OR_SL4' end,
      'loss_residual_mode', case
        when v_levels.futures then 'RESIDUAL_NET_POSITIVE'
        else 'TOTAL_NET_POSITIVE'
      end,
      'recovery_trigger_reason', case
        when v_levels.futures then 'FUTURES_HALF_STOP_LOSS_ROE_12'
        else 'HALF_HOLD_STOP_LOSS_4'
      end,
      'recovery_exit_reason', case
        when v_levels.futures then 'FUTURES_RECOVERY_NET_POSITIVE_EXIT'
        else 'RECOVERY_NET_POSITIVE_EXIT'
      end,
      'recovery_percentage_thresholds_enabled', false,
      'residual_exit_enabled', true,
      'protected_stop_loss_enabled', true,
      'non_threshold_exit_enabled', false,
      'return_basis', case
        when v_levels.futures
        then 'EXECUTABLE_PRICE_NET_OF_EXIT_FEE_VS_ENTRY_PRICE_TIMES_LEVERAGE'
        else 'EXECUTABLE_TOTAL_NET_PNL_AFTER_FEES_AND_SLIPPAGE_SAFETY'
      end,
      'stage', case when v_residual_stage then 'RESIDUAL' else 'FIRST_TRANCHE' end,
      'enforced_at', now()
    )
  );
  return new;
end;
$function$;

create or replace function public.guard_residual_sell_order_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_price numeric;
  v_quote_at timestamptz;
  v_gross_return_pct numeric;
  v_net_return_pct numeric;
  v_gross_roe_pct numeric;
  v_net_roe_pct numeric;
  v_fee_rate numeric;
  v_protected_qty numeric;
  v_sellable_qty numeric;
  v_requested_qty numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
  v_recovery_mode boolean;
  v_approved_reason text;
  v_projected_net_pnl_quote numeric;
  v_min_exit_notional numeric;
  v_futures boolean;
  v_leverage numeric;
  v_required_recovery_reason text;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select * into p
  from public.trading_positions
  where id = new.position_id
  for update;

  if not found then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_POSITION_NOT_FOUND';
  end if;
  if p.state not in ('OPEN','EXITING') then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_POSITION_NOT_SELLABLE state=%s market=%s', p.state, p.market
    );
  end if;

  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(p.initial_quantity, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_INVALID_POSITION_BASIS';
  end if;

  v_price := coalesce(
    nullif(new.requested_price, 0),
    nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,executable_vwap}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,sell_price}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,executable_price}', '')::numeric
  );
  v_quote_at := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz,
    nullif(p.metadata#>>'{live_mark,measured_at}', '')::timestamptz
  );

  if coalesce(v_price, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_MISSING_EXECUTABLE_PRICE';
  end if;
  if new.requested_price is null and (v_quote_at is null or now() - v_quote_at > interval '30 seconds') then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_STALE_EXECUTABLE_PRICE';
  end if;

  v_futures := lower(coalesce(p.exchange, '')) = 'binance_futures';
  v_leverage := case
    when v_futures then least(20, greatest(1, coalesce(nullif(p.leverage, 0), 3)))
    else 1
  end;
  -- USDⓈ-M taker is half the spot rate; Upbit is unchanged.
  v_fee_rate := case
    when lower(p.exchange) = 'upbit' then 0.0005
    when v_futures then 0.0005
    else 0.001
  end;
  v_gross_return_pct := (v_price / v_entry - 1) * 100;
  v_net_return_pct := (v_price * (1 - v_fee_rate) / v_entry - 1) * 100;
  v_gross_roe_pct := v_gross_return_pct * v_leverage;
  v_net_roe_pct := v_net_return_pct * v_leverage;
  v_step := greatest(0, coalesce(p.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, p.initial_quantity * 0.00000001);
  v_protected_qty := greatest(0, p.initial_quantity * 0.5);
  v_residual_stage := p.remaining_quantity <= v_protected_qty + v_tolerance;
  v_recovery_mode := lower(coalesce(p.metadata#>>'{recovery_exit,enabled}', 'false')) = 'true';
  v_required_recovery_reason := case
    when v_futures then 'FUTURES_RECOVERY_NET_POSITIVE_EXIT'
    else 'RECOVERY_NET_POSITIVE_EXIT'
  end;
  v_approved_reason := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
    nullif(p.metadata->>'pending_exit_reason', ''),
    ''
  );
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));

  if v_residual_stage then
    if v_recovery_mode then
      if v_approved_reason <> v_required_recovery_reason then
        raise exception using errcode='23514', message=format(
          'RECOVERY_EXIT_REASON_REQUIRED market=%s approved_reason=%s',
          p.market, v_approved_reason
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    elsif v_futures then
      -- A clean futures residual has one exit only: +30% on margin. It has no percentage
      -- stop, because a residual that goes negative latches into recovery instead.
      if v_net_roe_pct < 29.999 then
        raise exception using errcode='23514', message=format(
          'FUTURES_RESIDUAL_ROE_NOT_REACHED market=%s net_roe_pct=%s leverage=%s',
          p.market, round(v_net_roe_pct, 6), v_leverage
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    else
      if v_net_return_pct < 9.999 and v_net_return_pct > -3.999 then
        raise exception using errcode='23514', message=format(
          'RESIDUAL_THRESHOLD_NOT_REACHED market=%s net_return_pct=%s',
          p.market, round(v_net_return_pct, 6)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    end if;
  elsif v_futures then
    if v_gross_roe_pct < 14.999 and v_gross_roe_pct > -11.999 then
      raise exception using errcode='23514', message=format(
        'FUTURES_FIRST_TRANCHE_ROE_NOT_REACHED market=%s gross_roe_pct=%s leverage=%s',
        p.market, round(v_gross_roe_pct, 6), v_leverage
      );
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
  else
    if v_gross_return_pct < 4.999 and v_gross_return_pct > -3.999 then
      raise exception using errcode='23514', message=format(
        'FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_return_pct=%s',
        p.market, round(v_gross_return_pct, 6)
      );
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
  end if;

  if v_step > 0 then
    v_sellable_qty := floor((v_sellable_qty + v_step * 0.000000001) / v_step) * v_step;
  end if;
  new.requested_volume := least(v_requested_qty, v_sellable_qty);

  if coalesce(new.requested_volume, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_NO_AUTHORIZED_QUANTITY market=%s residual_stage=%s remaining_qty=%s',
      p.market, v_residual_stage, p.remaining_quantity
    );
  end if;

  if v_residual_stage and v_recovery_mode then
    if v_futures then
      -- "남은 절반이 양의 수익으로 전환": the remaining half's own net PnL, measured
      -- against the entry cost of the quantity being sold. The first tranche's realised
      -- result is deliberately not netted in — on the futures lane the operator's rule is
      -- about the remainder, not about the position as a whole.
      v_projected_net_pnl_quote :=
        new.requested_volume * v_price * (1 - v_fee_rate)
        - new.requested_volume * v_entry * (1 + v_fee_rate);
      if v_projected_net_pnl_quote <= 0 then
        raise exception using errcode='23514', message=format(
          'FUTURES_RECOVERY_RESIDUAL_NET_NOT_POSITIVE market=%s projected_net_pnl_quote=%s',
          p.market, round(v_projected_net_pnl_quote, 8)
        );
      end if;
    else
      v_projected_net_pnl_quote :=
        coalesce(p.realized_proceeds_quote, 0)
        + new.requested_volume * v_price * (1 - v_fee_rate)
        - coalesce(p.realized_cost_quote, 0)
        - coalesce(p.paid_fees_quote, 0);
      if v_projected_net_pnl_quote <= 0 then
        raise exception using errcode='23514', message=format(
          'RECOVERY_TOTAL_NET_NOT_POSITIVE market=%s projected_net_pnl_quote=%s',
          p.market, round(v_projected_net_pnl_quote, 8)
        );
      end if;
    end if;
  end if;

  v_min_exit_notional := case when lower(p.exchange) = 'upbit' then 5000 else 5 end;
  if new.requested_volume * v_price < v_min_exit_notional then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_EXIT_BELOW_EXCHANGE_MINIMUM market=%s notional=%s minimum=%s',
      p.market, round(new.requested_volume * v_price, 8), v_min_exit_notional
    );
  end if;

  new.requested_notional_quote := new.requested_volume * v_price;
  return new;
end;
$function$;

comment on function public.enforce_residual_exit_position_policy_v751() is
  'v7.6.0: spot keeps TP5/SL4 then TP10; binance_futures uses ROE +15/-12 then +30 at the position leverage';
comment on function public.guard_residual_sell_order_v751() is
  'v7.6.0 guard: futures tranches are checked on margin (ROE); recovery residual requires its own net PnL > 0';

-- The order-time re-quote restates approvals with the legacy positive-net label. Carry
-- the pending reason through for both lanes instead of only the spot one.
create or replace function public.normalize_recovery_exit_reason_v753()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_metadata jsonb;
  v_recovery_mode boolean;
  v_approved_reason text;
  v_pending_reason text;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select coalesce(metadata, '{}'::jsonb)
    into v_metadata
  from public.trading_positions
  where id = new.position_id;

  if not found then
    return new;
  end if;

  v_recovery_mode := lower(coalesce(v_metadata#>>'{recovery_exit,enabled}', 'false')) = 'true';
  v_approved_reason := coalesce(v_metadata#>>'{exit_policy_quote,approved_reason}', '');
  v_pending_reason := coalesce(v_metadata->>'pending_exit_reason', '');

  if v_recovery_mode
     and v_approved_reason = 'POSITIVE_NET_AFTER_180S'
     and v_pending_reason in ('RECOVERY_NET_POSITIVE_EXIT', 'FUTURES_RECOVERY_NET_POSITIVE_EXIT') then
    update public.trading_positions
    set metadata = jsonb_set(
          coalesce(metadata, '{}'::jsonb),
          '{exit_policy_quote,approved_reason}',
          to_jsonb(v_pending_reason),
          true
        ),
        updated_at = now()
    where id = new.position_id;
  end if;

  return new;
end;
$function$;

create or replace function public.sync_active_exit_revision_v753()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_revision text;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_revision := nullif(coalesce(new.metadata, '{}'::jsonb)->>'exit_policy_revision', '');
  if v_revision = '7.6.0-BINANCE-FUTURES' then
    new.metadata := jsonb_set(
      coalesce(new.metadata, '{}'::jsonb),
      '{active_exit_revision}',
      to_jsonb(v_revision),
      true
    );
  end if;
  return new;
end;
$function$;

-- 4. Version identity -------------------------------------------------------
-- trading_settings updates are rewritten from this invariant, so it moves first.

update public.trading_ops_invariants
set canonical_engine_revision = '7.6.0-BINANCE-FUTURES',
    updated_at = now()
where id = 1;

update public.trading_settings
set lob_live_admission_revision = '7.6.0-BINANCE-FUTURES',
    lob_model_revision = '7.6.0-BINANCE-FUTURES',
    version = version + 1,
    updated_at = now()
where id = 1;

-- Re-stamp active positions so they carry the current policy metadata immediately.
update public.trading_positions
set updated_at = now()
where state in ('OPEN','EXITING')
  and coalesce(initial_quantity, 0) > 0;

do $verify$
declare
  v_canonical text;
  v_admission text;
  v_model text;
  v_guard text := pg_get_functiondef('public.guard_residual_sell_order_v751()'::regprocedure);
  v_policy text := pg_get_functiondef('public.enforce_residual_exit_position_policy_v751()'::regprocedure);
  v_levels record;
begin
  select canonical_engine_revision into v_canonical
  from public.trading_ops_invariants where id = 1;
  select lob_live_admission_revision, lob_model_revision into v_admission, v_model
  from public.trading_settings where id = 1;

  if v_canonical is distinct from '7.6.0-BINANCE-FUTURES' then
    raise exception 'canonical engine revision did not move to v7.6.0 (got %)', v_canonical;
  end if;
  if v_admission is distinct from '7.6.0-BINANCE-FUTURES'
     or v_model is distinct from '7.6.0-BINANCE-FUTURES' then
    raise exception
      'trading_settings revisions did not follow the invariant (admission=%, model=%)',
      v_admission, v_model;
  end if;

  -- The spot lane must come out of this migration bit for bit unchanged.
  select * into v_levels from public.position_exit_levels_v760('binance', 1, 100);
  if v_levels.first_tp_pct <> 5 or v_levels.first_sl_pct <> -4 or v_levels.residual_tp_pct <> 10 then
    raise exception 'spot exit levels changed: tp=%, sl=%, residual=%',
      v_levels.first_tp_pct, v_levels.first_sl_pct, v_levels.residual_tp_pct;
  end if;

  -- 3x futures maps the operator's margin gates onto -4 / +5 / +10 on price.
  select * into v_levels from public.position_exit_levels_v760('binance_futures', 3, 100);
  if round(v_levels.stop_price, 6) <> 96
     or round(v_levels.target_1, 6) <> 105
     or round(v_levels.target_2, 6) <> 110 then
    raise exception 'futures 3x exit levels are wrong: stop=%, t1=%, t2=%',
      v_levels.stop_price, v_levels.target_1, v_levels.target_2;
  end if;

  if position('FUTURES_RESIDUAL_ROE_NOT_REACHED' in v_guard) = 0
     or position('FUTURES_FIRST_TRANCHE_ROE_NOT_REACHED' in v_guard) = 0
     or position('FUTURES_RECOVERY_RESIDUAL_NET_NOT_POSITIVE' in v_guard) = 0 then
    raise exception 'FUTURES_SELL_GUARD_INCOMPLETE';
  end if;
  if position('RECOVERY_TOTAL_NET_NOT_POSITIVE' in v_guard) = 0 then
    raise exception 'SPOT_RECOVERY_GUARD_LOST';
  end if;
  if position('RETURN_ON_MARGIN' in v_policy) = 0 then
    raise exception 'FUTURES_POSITION_POLICY_METADATA_MISSING';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'trading_positions' and column_name = 'leverage'
  ) then
    raise exception 'trading_positions.leverage was not created';
  end if;

  -- Nothing may still be routing on a two-venue world. A check that names 'binance' but
  -- has never heard of the futures lane would reject futures rows at insert time, which
  -- is a failure the engine cannot recover from.
  if exists (
    select 1
    from pg_constraint
    where contype = 'c'
      and connamespace = 'public'::regnamespace
      and pg_get_constraintdef(oid) like '%''binance''%'
      and pg_get_constraintdef(oid) not like '%binance_futures%'
  ) then
    raise exception 'exchange check constraints still exclude binance_futures: %', (
      select string_agg(conrelid::regclass::text || '.' || conname, ', ')
      from pg_constraint
      where contype = 'c'
        and connamespace = 'public'::regnamespace
        and pg_get_constraintdef(oid) like '%''binance''%'
        and pg_get_constraintdef(oid) not like '%binance_futures%'
    );
  end if;
end;
$verify$;

commit;
