-- Emergency liquidation is intentionally a two-step control-plane action. A raw
-- settings UPDATE used to bypass the API confirmation and could turn the next monitor
-- heartbeat into real market-close orders. Require a transaction-local capability set
-- only by the confirmed RPC, so accidental SQL/PATCH writes fail closed.

create or replace function public.guard_emergency_liquidation_transition()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if coalesce(old.emergency_liquidation, false) is false
     and coalesce(new.emergency_liquidation, false) is true
     and coalesce(
       current_setting('trading.emergency_liquidation_confirmation', true),
       ''
     ) <> 'LIQUIDATE_NOW' then
    raise exception 'emergency liquidation requires request_emergency_liquidation confirmation'
      using errcode = '55000';
  elsif coalesce(old.emergency_liquidation, false) is true
     and coalesce(new.emergency_liquidation, false) is false
     and coalesce(
       current_setting('trading.emergency_liquidation_clearance', true),
       ''
     ) <> 'POSITIONS_CLEARED' then
    raise exception 'emergency liquidation can be cleared only after durable position reconciliation'
      using errcode = '55000';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_guard_emergency_liquidation_transition
  on public.trading_settings;
create trigger trg_guard_emergency_liquidation_transition
before update of emergency_liquidation on public.trading_settings
for each row
execute function public.guard_emergency_liquidation_transition();

create or replace function public.request_emergency_liquidation(
  p_confirmation text,
  p_source text default 'API'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_settings public.trading_settings%rowtype;
begin
  if coalesce(p_confirmation, '') <> 'LIQUIDATE_NOW' then
    raise exception 'emergency liquidation requires confirmation LIQUIDATE_NOW'
      using errcode = '22023';
  end if;

  perform set_config(
    'trading.emergency_liquidation_confirmation',
    'LIQUIDATE_NOW',
    true
  );

  update public.trading_settings
  set pause_new_entries = true,
      emergency_liquidation = true,
      pause_lock_reason = 'EMERGENCY_LIQUIDATION',
      manual_event_reason = 'EMERGENCY_LIQUIDATION_REQUESTED:' ||
        left(coalesce(nullif(p_source, ''), 'API'), 120),
      last_manual_event_at = now(),
      version = version + 1,
      updated_at = now()
  where id = 1
  returning * into v_settings;

  if not found then
    raise exception 'trading settings row 1 not found';
  end if;

  return to_jsonb(v_settings);
end;
$function$;

revoke all on function public.request_emergency_liquidation(text, text)
  from public, anon, authenticated;
grant execute on function public.request_emergency_liquidation(text, text) to service_role;

comment on function public.request_emergency_liquidation(text, text) is
  'The only supported false-to-true emergency liquidation transition. Requires literal LIQUIDATE_NOW confirmation and leaves an operator pause lock.';

create or replace function public.complete_emergency_liquidation()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_settings public.trading_settings%rowtype;
  v_active_positions integer;
  v_pending_close_orders integer;
begin
  select * into v_settings
  from public.trading_settings
  where id = 1
  for update;

  if not found then
    raise exception 'trading settings row 1 not found';
  end if;

  if coalesce(v_settings.emergency_liquidation, false) is false then
    return jsonb_build_object(
      'completed', true,
      'already_cleared', true,
      'active_positions', 0,
      'pending_close_orders', 0,
      'settings', to_jsonb(v_settings)
    );
  end if;

  select count(*)::integer into v_active_positions
  from public.trading_positions
  where state in (
    'ENTRY_PENDING',
    'OPEN',
    'EXITING',
    'RECONCILING',
    'RECONCILIATION_FAILED',
    'MANUAL_INTERVENTION_REQUIRED'
  );

  select count(*)::integer into v_pending_close_orders
  from public.trading_orders
  where (position_effect = 'CLOSE' or purpose <> 'ENTRY')
    and state in (
      'REQUESTED',
      'UNKNOWN',
      'EXCHANGE_OPEN',
      'EXCHANGE_PARTIAL',
      'EXCHANGE_DONE',
      'EXCHANGE_PARTIAL_CANCELLED'
    );

  if v_active_positions > 0 or v_pending_close_orders > 0 then
    return jsonb_build_object(
      'completed', false,
      'active_positions', v_active_positions,
      'pending_close_orders', v_pending_close_orders
    );
  end if;

  perform set_config(
    'trading.emergency_liquidation_clearance',
    'POSITIONS_CLEARED',
    true
  );

  update public.trading_settings
  set emergency_liquidation = false,
      pause_new_entries = true,
      pause_lock_reason = 'EMERGENCY_LIQUIDATION',
      manual_event_reason = 'EMERGENCY_LIQUIDATION_COMPLETED',
      last_manual_event_at = now(),
      version = version + 1,
      updated_at = now()
  where id = 1
  returning * into v_settings;

  return jsonb_build_object(
    'completed', true,
    'already_cleared', false,
    'active_positions', 0,
    'pending_close_orders', 0,
    'settings', to_jsonb(v_settings)
  );
end;
$function$;

revoke all on function public.complete_emergency_liquidation()
  from public, anon, authenticated;
grant execute on function public.complete_emergency_liquidation() to service_role;

comment on function public.complete_emergency_liquidation() is
  'Clears emergency mode only when every tracked position is terminal and no close order remains uncertain. Keeps entries operator-locked until the reconciled resume endpoint is used.';

-- Serialize the actual live ENTRY_PENDING insert with emergency/pause settings changes.
-- The Edge scan may have started with an older settings snapshot; this row lock closes
-- the gap between that snapshot and the first durable position/order side effect.
create or replace function public.guard_p10_live_entry_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_settings public.trading_settings%rowtype;
begin
  if new.strategy_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
     or new.state <> 'ENTRY_PENDING'
     or coalesce(new.is_paper, false) is true then
    return new;
  end if;

  select * into v_settings
  from public.trading_settings
  where id = 1
  for share;

  if not found then
    raise exception 'trading settings row 1 not found';
  end if;

  if coalesce(v_settings.configured, false) is false
     or v_settings.mode <> 'LIVE_LIMITED'
     or coalesce(v_settings.pause_new_entries, false) is true
     or coalesce(v_settings.emergency_liquidation, false) is true
     or coalesce(v_settings.withdrawal_mode, false) is true
     or coalesce(v_settings.manual_intervention_required, false) is true then
    raise exception 'P10 live entry blocked by current trading settings'
      using errcode = '55000';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_guard_p10_live_entry_settings
  on public.trading_positions;
create trigger trg_guard_p10_live_entry_settings
before insert on public.trading_positions
for each row
execute function public.guard_p10_live_entry_settings();

comment on function public.guard_p10_live_entry_settings() is
  'Locks and rechecks trading_settings at the durable P10 ENTRY_PENDING insert boundary so a stale scan cannot race an operator pause or emergency liquidation.';
