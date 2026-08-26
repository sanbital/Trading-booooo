create or replace function public.latch_p10_entry_safety(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
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

  -- A Binance Futures close is committed to the durable ledger before the exchange
  -- position endpoint is guaranteed to reflect the new zero. The scan that observes
  -- that short propagation window already returns SKIPPED on an unmatched exposure, so
  -- defer the global latch and require the next fresh scan to confirm it.
  -- A genuine unmatched exposure persists past this grace and is latched normally on
  -- the following scan. No entry is admitted by the uncertain scan itself.
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
