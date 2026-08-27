-- P10 entry reconciliation invariants.
--
-- An accepted Binance Futures entry may be visible in the position/trade APIs before a
-- subsequent order lookup is complete.  Positive execution evidence is monotonic: neither
-- a missing lookup nor delayed price detail may move its position to CANCELLED/ERROR.

create or replace function public.apply_p10_entry_order(
  p_order_id uuid,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_stop_price numeric,
  p_target_1 numeric,
  p_target_2 numeric,
  p_initial_risk numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.trading_orders%rowtype;
  v_position public.trading_positions%rowtype;
  v_now timestamptz := now();
  v_expected_side text;
  v_previous_state text;
  v_previous_close_reason text;
begin
  select * into v_order
  from public.trading_orders
  where id = p_order_id
  for update;
  if not found then raise exception 'trading order % not found', p_order_id; end if;

  select * into v_position
  from public.trading_positions
  where id = v_order.position_id
  for update;
  if not found then raise exception 'position for order % not found', p_order_id; end if;

  if v_position.strategy_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' or
     v_position.exit_policy <> 'P10_SLOW_4R' then
    raise exception 'position % is not a P10 position', v_position.id;
  end if;
  v_expected_side := case when v_position.position_side = 'SHORT' then 'SELL' else 'BUY' end;
  if v_order.purpose <> 'ENTRY' or v_order.side <> v_expected_side then
    raise exception 'order % has invalid P10 entry direction', p_order_id;
  end if;
  if v_position.state not in (
    'ENTRY_PENDING',
    'RECONCILING',
    'RECONCILIATION_FAILED',
    'CANCELLED',
    'ERROR'
  ) then
    if v_order.state = 'APPLIED' then
      return jsonb_build_object(
        'applied', false,
        'position', to_jsonb(v_position),
        'order', to_jsonb(v_order)
      );
    end if;
    raise exception 'position % state % is not eligible for P10 entry application',
      v_position.id, v_position.state;
  end if;
  if v_position.state <> 'ENTRY_PENDING'
     and coalesce(v_position.metadata->>'reconciliation_phase', '') <> 'ENTRY'
     and not (
       v_position.state in ('CANCELLED', 'ERROR')
       and coalesce(v_position.close_reason, '') like 'P10_ENTRY_%'
     ) then
    raise exception 'position % is not in entry reconciliation', v_position.id;
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 or
     coalesce(p_initial_risk, 0) <= 0 then
    raise exception 'P10 entry fill and initial risk must be positive';
  end if;

  v_previous_state := v_position.state;
  v_previous_close_reason := v_position.close_reason;

  update public.trading_positions set
    state = 'OPEN',
    initial_quantity = p_fill_quantity,
    remaining_quantity = p_fill_quantity,
    average_entry_price = p_fill_price,
    planned_entry_price = p_fill_price,
    stop_price = p_stop_price,
    target_1 = p_target_1,
    target_2 = p_target_2,
    peak_price = p_fill_price,
    trough_price = p_fill_price,
    trailing_stop = p_stop_price,
    opened_at = coalesce(opened_at, v_now),
    closed_at = null,
    close_reason = null,
    realized_cost_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fees_quote = greatest(0, coalesce(p_fill_fee_quote, 0)),
    reserved_quote = 0,
    reserved_quantity = 0,
    reservation_expires_at = null,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_applied_order_id', p_order_id,
      'last_applied_order_at', v_now,
      'p10_initial_risk', p_initial_risk,
      'p10_realized_gross_pnl_quote', 0,
      'p10_entry_fee_quote', greatest(0, coalesce(p_fill_fee_quote, 0)),
      'p10_entry_previous_terminal_state',
        case when v_previous_state in ('CANCELLED', 'ERROR') then v_previous_state else null end,
      'p10_entry_previous_close_reason', v_previous_close_reason,
      'reconciliation_phase', null,
      'p10_entry_accounting_detail_pending', false
    ),
    updated_at = v_now
  where id = v_position.id
  returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED',
    executed_volume = p_fill_quantity,
    average_fill_price = p_fill_price,
    executed_funds_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fee_quote = greatest(0, coalesce(p_fill_fee_quote, 0)),
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = p_order_id
  returning * into v_order;

  update public.p10_signal_claims set
    status = 'FILLED',
    position_id = v_position.id,
    reason = null,
    updated_at = v_now
  where position_id = v_position.id or
    id::text = coalesce(v_position.metadata->>'p10_claim_id', '');

  return jsonb_build_object(
    'applied', true,
    'position', to_jsonb(v_position),
    'order', to_jsonb(v_order)
  );
end;
$function$;

-- Entry uncertainty is a global safety latch.  Preserve unrelated operator locks while
-- serialising concurrent scans and DB late-fill triggers on the settings row.
create or replace function public.latch_p10_entry_safety(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_before public.trading_settings%rowtype;
  v_after public.trading_settings%rowtype;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'P10_ENTRY_RECONCILIATION_REQUIRED');
  v_next_lock text;
  v_next_manual_reason text;
  v_recent_futures_close boolean := false;
begin
  select * into v_before
  from public.trading_settings
  where id = 1
  for update;
  if not found then raise exception 'trading settings row 1 not found'; end if;

  -- Binance may briefly report the just-closed directional exposure after the
  -- durable CLOSED row has committed. This scan is already fail-closed: the caller
  -- returns SKIPPED whenever unmatched exposure is observed. Defer only the global
  -- latch for this short close-propagation window; a persistent exposure is seen on
  -- the next fresh scan and then latches normally.
  if v_reason = 'P10_UNTRACKED_FUTURES_EXPOSURE'
     and coalesce(v_before.pause_new_entries, false) is false then
    select exists (
      select 1
      from public.trading_positions p
      where p.exchange = 'binance_futures'
        and coalesce(p.is_paper, false) is false
        and p.state = 'CLOSED'
        and upper(coalesce(p.position_side, '')) in ('LONG', 'SHORT')
        and p.closed_at is not null
        and p.closed_at >= clock_timestamp() - interval '5 seconds'
    ) into v_recent_futures_close;

    if v_recent_futures_close then
      return jsonb_build_object(
        'changed', false,
        'deferred', true,
        'defer_reason', 'RECENT_FUTURES_CLOSE_GRACE',
        'grace_seconds', 5,
        'settings', to_jsonb(v_before)
      );
    end if;
  end if;

  -- Defense in depth: reconciliation means an exchange submission may have an unknown
  -- result. A pre-order policy/validation failure has no durable entry order and cannot
  -- pause every venue. Persistent post-submit ambiguity still latches exactly as before.
  if v_reason = 'P10_ENTRY_RECONCILIATION_REQUIRED'
     and not exists (
       select 1
       from public.trading_orders o
       join public.trading_positions p on p.id = o.position_id
       where p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
         and coalesce(p.is_paper, false) is false
         and upper(coalesce(o.purpose, '')) = 'ENTRY'
         and (
           (
             p.state in (
               'ENTRY_PENDING', 'RECONCILING', 'RECONCILIATION_FAILED',
               'MANUAL_INTERVENTION_REQUIRED'
             )
             and o.state in (
               'REQUESTED', 'UNKNOWN', 'EXCHANGE_OPEN', 'EXCHANGE_PARTIAL',
               'EXCHANGE_DONE', 'EXCHANGE_PARTIAL_CANCELLED'
             )
           )
           or coalesce(o.executed_volume, 0) > 0
           or exists (
             select 1 from public.exchange_trade_fills f
             where f.bot_order_id = o.id and coalesce(f.quantity, 0) > 0
           )
           or exists (
             select 1 from public.trading_fills f
             where f.order_id = o.id and coalesce(f.volume, 0) > 0
           )
         )
     ) then
    return jsonb_build_object(
      'changed', false,
      'deferred', true,
      'defer_reason', 'NO_ENTRY_RECONCILIATION_EVIDENCE',
      'settings', to_jsonb(v_before)
    );
  end if;

  v_next_lock := case
    when v_before.pause_lock_reason is null or v_before.pause_lock_reason like 'P10_%'
      then v_reason
    else v_before.pause_lock_reason
  end;
  v_next_manual_reason := case
    when v_before.manual_event_reason is null or v_before.manual_event_reason like 'P10_%'
      or v_before.manual_event_reason like 'TEMP_SAFETY_%'
      then v_reason
    else v_before.manual_event_reason
  end;

  if v_before.pause_new_entries is true
     and v_before.pause_lock_reason is not distinct from v_next_lock
     and v_before.manual_event_reason is not distinct from v_next_manual_reason then
    return jsonb_build_object('changed', false, 'settings', to_jsonb(v_before));
  end if;

  update public.trading_settings
  set pause_new_entries = true,
      pause_lock_reason = v_next_lock,
      manual_event_reason = v_next_manual_reason,
      last_manual_event_at = now(),
      updated_at = now()
  where id = 1
  returning * into v_after;

  return jsonb_build_object(
    'changed',
      v_before.pause_new_entries is distinct from v_after.pause_new_entries or
      v_before.pause_lock_reason is distinct from v_after.pause_lock_reason or
      v_before.manual_event_reason is distinct from v_after.manual_event_reason,
    'settings', to_jsonb(v_after)
  );
end;
$function$;

-- Serialize operator resume with the same settings-first lock used by late-fill staging.
-- Exchange exposure is proven immediately before this RPC; DB evidence is rechecked while
-- holding the settings lock so a concurrent late fill always wins or immediately re-latches.
create or replace function public.resume_p10_safely(
  p_expected_version bigint,
  p_expected_lock_reason text,
  p_expected_manual_reason text,
  p_external_futures_clear boolean,
  p_unresolved_manual_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_settings public.trading_settings%rowtype;
begin
  select * into v_settings
  from public.trading_settings
  where id = 1
  for update;
  if not found then raise exception 'trading settings row 1 not found'; end if;

  if v_settings.version is distinct from p_expected_version
     or v_settings.pause_lock_reason is distinct from p_expected_lock_reason
     or v_settings.manual_event_reason is distinct from p_expected_manual_reason then
    return jsonb_build_object('resumed', false, 'reason', 'SETTINGS_CHANGED');
  end if;
  if p_external_futures_clear is not true then
    return jsonb_build_object('resumed', false, 'reason', 'FUTURES_EXPOSURE_NOT_CLEAR');
  end if;
  if coalesce(p_unresolved_manual_count, 0) > 0 then
    return jsonb_build_object('resumed', false, 'reason', 'MANUAL_RECONCILIATION_UNRESOLVED');
  end if;
  if coalesce(v_settings.emergency_liquidation, false) then
    return jsonb_build_object('resumed', false, 'reason', 'EMERGENCY_LIQUIDATION_ACTIVE');
  end if;
  if exists (
    select 1
    from public.trading_positions p
    where p.state in (
      'ENTRY_PENDING', 'RECONCILING', 'RECONCILIATION_FAILED',
      'MANUAL_INTERVENTION_REQUIRED'
    )
  ) then
    return jsonb_build_object('resumed', false, 'reason', 'ENTRY_RECONCILIATION_UNRESOLVED');
  end if;
  if exists (
    select 1
    from public.trading_positions p
    where p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
      and p.is_paper = false
      and p.state in ('CANCELLED', 'ERROR')
      and (
        exists (
          select 1 from public.trading_orders o
          where o.position_id = p.id
            and upper(coalesce(o.purpose, '')) = 'ENTRY'
            and coalesce(o.executed_volume, 0) > 0
        )
        or exists (
          select 1
          from public.exchange_trade_fills f
          join public.trading_orders o on o.id = f.bot_order_id
          where o.position_id = p.id
            and upper(coalesce(o.purpose, '')) = 'ENTRY'
            and coalesce(f.quantity, 0) > 0
        )
        or exists (
          select 1
          from public.trading_fills f
          join public.trading_orders o on o.id = f.order_id
          where o.position_id = p.id
            and upper(coalesce(o.purpose, '')) = 'ENTRY'
            and coalesce(f.volume, 0) > 0
        )
      )
  ) then
    return jsonb_build_object('resumed', false, 'reason', 'TERMINAL_ENTRY_EXECUTION_EXISTS');
  end if;

  update public.trading_settings
  set pause_new_entries = false,
      pause_lock_reason = null,
      withdrawal_mode = false,
      manual_intervention_required = false,
      manual_event_reason = null,
      emergency_liquidation = false,
      last_resume_at = now(),
      version = coalesce(version, 0) + 1,
      updated_at = now()
  where id = 1
  returning * into v_settings;

  return jsonb_build_object(
    'resumed', true,
    'reason', null,
    'settings', to_jsonb(v_settings)
  );
end;
$function$;

create or replace function public.guard_p10_terminal_state_with_entry_execution()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if new.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
     and new.is_paper = false
     and new.state in ('CANCELLED', 'ERROR')
     and (
       exists (
         select 1
         from public.trading_orders o
         where o.position_id = new.id
           and upper(coalesce(o.purpose, '')) = 'ENTRY'
           and coalesce(o.executed_volume, 0) > 0
       )
       or exists (
         select 1
         from public.exchange_trade_fills f
         join public.trading_orders o on o.id = f.bot_order_id
         where o.position_id = new.id
           and upper(coalesce(o.purpose, '')) = 'ENTRY'
           and coalesce(f.quantity, 0) > 0
       )
       or exists (
         select 1
         from public.trading_fills f
         join public.trading_orders o on o.id = f.order_id
         where o.position_id = new.id
           and upper(coalesce(o.purpose, '')) = 'ENTRY'
           and coalesce(f.volume, 0) > 0
       )
     ) then
    raise exception using
      errcode = '23514',
      message = format(
        'P10 position %s cannot enter %s after positive entry execution',
        new.id,
        new.state
      );
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_p10_terminal_state_with_entry_execution
  on public.trading_positions;
create trigger trg_guard_p10_terminal_state_with_entry_execution
before insert or update of state on public.trading_positions
for each row execute function public.guard_p10_terminal_state_with_entry_execution();

create or replace function public.stage_p10_executed_entry_reconciliation()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_revision constant text := 'P10_ENTRY_EXECUTION_MONOTONIC_V2';
  v_position_id uuid;
  v_previous_state text;
  v_previous_reason text;
  v_sibling_id uuid;
begin
  if tg_table_name = 'trading_orders' then
    if upper(coalesce(new.purpose, '')) <> 'ENTRY' or coalesce(new.executed_volume, 0) <= 0 then
      return new;
    end if;
    v_position_id := new.position_id;
  elsif tg_table_name = 'exchange_trade_fills' then
    if new.bot_order_id is null or coalesce(new.quantity, 0) <= 0 then
      return new;
    end if;
    select o.position_id into v_position_id
    from public.trading_orders o
    where o.id = new.bot_order_id
      and upper(coalesce(o.purpose, '')) = 'ENTRY';
    if v_position_id is null then return new; end if;
  elsif tg_table_name = 'trading_fills' then
    if new.order_id is null or coalesce(new.volume, 0) <= 0 then return new; end if;
    select o.position_id into v_position_id
    from public.trading_orders o
    where o.id = new.order_id
      and upper(coalesce(o.purpose, '')) = 'ENTRY';
    if v_position_id is null then return new; end if;
  else
    return new;
  end if;

  -- Cheap unlocked precheck avoids taking the global settings lock for normal OPEN fills.
  if not exists (
    select 1 from public.trading_positions p
    where p.id = v_position_id
      and p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
      and p.is_paper = false
      and p.state in ('CANCELLED', 'ERROR')
  ) then
    return new;
  end if;

  -- Lock order is settings -> position, matching the live-entry guard. This prevents a
  -- late fill and a new same-market entry from deadlocking each other.
  perform public.latch_p10_entry_safety('P10_ENTRY_RECONCILIATION_REQUIRED');

  select p.state, p.close_reason
  into v_previous_state, v_previous_reason
  from public.trading_positions p
  where p.id = v_position_id
    and p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
    and p.is_paper = false
    and p.state in ('CANCELLED', 'ERROR')
  for update;
  if not found then return new; end if;

  select p.id into v_sibling_id
  from public.trading_positions p
  where p.id <> v_position_id
    and p.exchange = (select exchange from public.trading_positions where id = v_position_id)
    and p.market = (select market from public.trading_positions where id = v_position_id)
    and p.state in (
      'ENTRY_PENDING', 'OPEN', 'EXITING', 'RECONCILING',
      'RECONCILIATION_FAILED', 'MANUAL_INTERVENTION_REQUIRED'
    )
  order by p.created_at desc
  limit 1;

  if v_sibling_id is not null then
    update public.trading_positions
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'reconciliation_phase', 'ENTRY',
          'p10_entry_reconciliation_started_at', now(),
          'p10_entry_reconciliation_source', tg_table_name,
          'p10_entry_reconciliation_revision', v_revision,
          'p10_entry_reconciliation_blocked_by_position_id', v_sibling_id,
          'p10_entry_previous_terminal_state', v_previous_state,
          'p10_entry_previous_close_reason', v_previous_reason
        ),
        updated_at = now()
    where id = v_position_id;
    return new;
  end if;

  begin
    update public.trading_positions
    set state = 'RECONCILING',
        closed_at = null,
        close_reason = null,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'reconciliation_phase', 'ENTRY',
          'p10_entry_reconciliation_started_at', now(),
          'p10_entry_reconciliation_source', tg_table_name,
          'p10_entry_reconciliation_revision', v_revision,
          'p10_entry_previous_terminal_state', v_previous_state,
          'p10_entry_previous_close_reason', v_previous_reason
        ),
        updated_at = now()
    where id = v_position_id;
  exception
    when unique_violation then
      update public.trading_positions
      set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'reconciliation_phase', 'ENTRY',
            'p10_entry_reconciliation_started_at', now(),
            'p10_entry_reconciliation_source', tg_table_name,
            'p10_entry_reconciliation_revision', v_revision,
            'p10_entry_reconciliation_blocked_by_unique_index', true,
            'p10_entry_previous_terminal_state', v_previous_state,
            'p10_entry_previous_close_reason', v_previous_reason
          ),
          updated_at = now()
      where id = v_position_id;
  end;

  return new;
end;
$function$;

drop trigger if exists trg_stage_p10_executed_order_reconciliation
  on public.trading_orders;
drop trigger if exists aaa_stage_p10_executed_order_reconciliation
  on public.trading_orders;
create trigger aaa_stage_p10_executed_order_reconciliation
before insert or update of executed_volume, state on public.trading_orders
for each row execute function public.stage_p10_executed_entry_reconciliation();

drop trigger if exists trg_stage_p10_entry_fill_reconciliation
  on public.exchange_trade_fills;
drop trigger if exists aaa_stage_p10_entry_fill_reconciliation
  on public.exchange_trade_fills;
create trigger aaa_stage_p10_entry_fill_reconciliation
before insert or update of bot_order_id, position_id, quantity on public.exchange_trade_fills
for each row execute function public.stage_p10_executed_entry_reconciliation();

drop trigger if exists trg_stage_p10_trading_fill_reconciliation
  on public.trading_fills;
drop trigger if exists aaa_stage_p10_trading_fill_reconciliation
  on public.trading_fills;
create trigger aaa_stage_p10_trading_fill_reconciliation
before insert or update of order_id, volume on public.trading_fills
for each row execute function public.stage_p10_executed_entry_reconciliation();

-- Replay already-persisted positive evidence through the same trigger contract. This is
-- idempotent and turns a pre-existing terminal mismatch into RECONCILING before the
-- migration can report success.
update public.trading_orders o
set executed_volume = o.executed_volume
where upper(coalesce(o.purpose, '')) = 'ENTRY'
  and coalesce(o.executed_volume, 0) > 0
  and exists (
    select 1 from public.trading_positions p
    where p.id = o.position_id
      and p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
      and p.is_paper = false
      and p.state in ('CANCELLED', 'ERROR')
  );

update public.exchange_trade_fills f
set quantity = f.quantity
from public.trading_orders o, public.trading_positions p
where o.id = f.bot_order_id
  and p.id = o.position_id
  and upper(coalesce(o.purpose, '')) = 'ENTRY'
  and coalesce(f.quantity, 0) > 0
  and p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
  and p.is_paper = false
  and p.state in ('CANCELLED', 'ERROR');

update public.trading_fills f
set volume = f.volume
from public.trading_orders o, public.trading_positions p
where o.id = f.order_id
  and p.id = o.position_id
  and upper(coalesce(o.purpose, '')) = 'ENTRY'
  and coalesce(f.volume, 0) > 0
  and p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
  and p.is_paper = false
  and p.state in ('CANCELLED', 'ERROR');

do $invariant$
begin
  if exists (
    select 1
    from public.trading_positions p
    where p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
      and p.is_paper = false
      and p.state in ('CANCELLED', 'ERROR')
      and (
        exists (
          select 1 from public.trading_orders o
          where o.position_id = p.id
            and upper(coalesce(o.purpose, '')) = 'ENTRY'
            and coalesce(o.executed_volume, 0) > 0
        )
        or exists (
          select 1
          from public.exchange_trade_fills f
          join public.trading_orders o on o.id = f.bot_order_id
          where o.position_id = p.id
            and upper(coalesce(o.purpose, '')) = 'ENTRY'
            and coalesce(f.quantity, 0) > 0
        )
        or exists (
          select 1
          from public.trading_fills f
          join public.trading_orders o on o.id = f.order_id
          where o.position_id = p.id
            and upper(coalesce(o.purpose, '')) = 'ENTRY'
            and coalesce(f.volume, 0) > 0
        )
      )
  ) then
    raise exception 'P10 terminal position still has positive entry execution after staging';
  end if;
end;
$invariant$;

-- The legacy entry-ledger trigger only recognized BUY entries.  P10 SHORT entry orders
-- are SELL, so use purpose=ENTRY as the invariant and keep both directions synchronized.
create or replace function public.sync_futures_entry_ledger_v763()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_position_id uuid;
  v_exchange text;
  v_purpose text;
  v_entry_cost numeric;
  v_entry_fee numeric;
  v_existing_total_fee numeric;
  v_previous_entry_fee numeric;
begin
  select o.position_id, lower(coalesce(o.exchange, '')), upper(coalesce(o.purpose, ''))
  into v_position_id, v_exchange, v_purpose
  from public.trading_orders o
  where o.id = new.order_id;

  if v_position_id is null or v_exchange <> 'binance_futures' or v_purpose <> 'ENTRY' then
    return new;
  end if;

  select
    coalesce(sum(coalesce(f.funds_quote, f.price * f.volume, 0)), 0),
    coalesce(sum(coalesce(f.fee_quote_estimate, 0)), 0)
  into v_entry_cost, v_entry_fee
  from public.trading_fills f
  join public.trading_orders o on o.id = f.order_id
  where o.position_id = v_position_id
    and lower(coalesce(o.exchange, '')) = 'binance_futures'
    and upper(coalesce(o.purpose, '')) = 'ENTRY';

  if v_entry_cost > 0 then
    select
      greatest(0, coalesce(p.paid_fees_quote, 0)),
      case
        when coalesce(p.metadata->>'p10_entry_fee_quote', '') ~
          '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
          then greatest(0, (p.metadata->>'p10_entry_fee_quote')::numeric)
        else least(greatest(0, coalesce(p.paid_fees_quote, 0)), v_entry_fee)
      end
    into v_existing_total_fee, v_previous_entry_fee
    from public.trading_positions p
    where p.id = v_position_id
      and lower(coalesce(p.exchange, '')) = 'binance_futures'
      and p.state in (
        'ENTRY_PENDING', 'OPEN', 'EXITING', 'RECONCILING',
        'RECONCILIATION_FAILED', 'CANCELLED', 'ERROR'
      )
    for update;
    if not found then return new; end if;

    update public.trading_positions p
    set realized_cost_quote = v_entry_cost,
        paid_fees_quote = greatest(0, v_existing_total_fee - v_previous_entry_fee) + v_entry_fee,
        metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
          'p10_entry_fee_quote', v_entry_fee,
          'p10_entry_ledger_synced_at', now()
        ),
        updated_at = now()
    where p.id = v_position_id
      and lower(coalesce(p.exchange, '')) = 'binance_futures'
      and p.state in (
        'ENTRY_PENDING', 'OPEN', 'EXITING', 'RECONCILING',
        'RECONCILIATION_FAILED', 'CANCELLED', 'ERROR'
      );
  end if;

  return new;
end;
$function$;

with entry_ledger as (
  select
    o.position_id,
    coalesce(sum(coalesce(f.funds_quote, f.price * f.volume, 0)), 0) as entry_cost,
    coalesce(sum(coalesce(f.fee_quote_estimate, 0)), 0) as entry_fee
  from public.trading_fills f
  join public.trading_orders o on o.id = f.order_id
  join public.trading_positions p on p.id = o.position_id
  where lower(coalesce(o.exchange, '')) = 'binance_futures'
    and upper(coalesce(o.purpose, '')) = 'ENTRY'
    and p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
    and p.state in (
      'ENTRY_PENDING', 'OPEN', 'EXITING', 'RECONCILING',
      'RECONCILIATION_FAILED', 'CANCELLED', 'ERROR'
    )
  group by o.position_id
)
update public.trading_positions p
set realized_cost_quote = e.entry_cost,
    paid_fees_quote = greatest(
      0,
      coalesce(p.paid_fees_quote, 0) - case
        when coalesce(p.metadata->>'p10_entry_fee_quote', '') ~
          '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
          then greatest(0, (p.metadata->>'p10_entry_fee_quote')::numeric)
        else least(greatest(0, coalesce(p.paid_fees_quote, 0)), e.entry_fee)
      end
    ) + e.entry_fee,
    metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
      'p10_entry_fee_quote', e.entry_fee,
      'p10_entry_ledger_synced_at', now()
    ),
    updated_at = now()
from entry_ledger e
where p.id = e.position_id and e.entry_cost > 0;

comment on function public.guard_p10_terminal_state_with_entry_execution() is
  'Rejects P10 CANCELLED/ERROR transitions when an ENTRY order or linked exchange fill has positive execution.';
comment on function public.stage_p10_executed_entry_reconciliation() is
  'Moves a mistakenly terminal P10 entry to RECONCILING and pauses new entries when positive execution arrives later.';

revoke all on function public.guard_p10_terminal_state_with_entry_execution() from public;
revoke all on function public.guard_p10_terminal_state_with_entry_execution() from anon, authenticated;
revoke all on function public.stage_p10_executed_entry_reconciliation() from public;
revoke all on function public.stage_p10_executed_entry_reconciliation() from anon, authenticated;
revoke all on function public.apply_p10_entry_order(
  uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) from public;
revoke all on function public.apply_p10_entry_order(
  uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) from anon, authenticated;
grant execute on function public.apply_p10_entry_order(
  uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) to service_role;
revoke all on function public.latch_p10_entry_safety(text) from public;
revoke all on function public.latch_p10_entry_safety(text) from anon, authenticated;
grant execute on function public.latch_p10_entry_safety(text) to service_role;
revoke all on function public.resume_p10_safely(bigint, text, text, boolean, integer)
  from public;
revoke all on function public.resume_p10_safely(bigint, text, text, boolean, integer)
  from anon, authenticated;
grant execute on function public.resume_p10_safely(bigint, text, text, boolean, integer)
  to service_role;
