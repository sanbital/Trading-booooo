-- Restrict the reconciliation latch to current post-submit uncertainty.
-- Historical CLOSED/APPLIED executions are not evidence for a new global pause.

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

  -- Defense in depth: reconciliation means a current exchange submission may have an
  -- unknown result. Historical CLOSED/APPLIED fills are not current uncertainty and must
  -- never authorize a fresh global latch. A newly discovered late fill on a terminal row
  -- remains valid evidence for five minutes so its trigger can stage reconciliation.
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
           or (
             p.state in ('CANCELLED', 'ERROR')
             and (
               (coalesce(o.executed_volume, 0) > 0
                and o.updated_at >= clock_timestamp() - interval '5 minutes')
               or exists (
                 select 1 from public.exchange_trade_fills f
                 where f.bot_order_id = o.id
                   and coalesce(f.quantity, 0) > 0
                   and f.created_at >= clock_timestamp() - interval '5 minutes'
               )
               or exists (
                 select 1 from public.trading_fills f
                 where f.order_id = o.id
                   and coalesce(f.volume, 0) > 0
                   and f.executed_at >= clock_timestamp() - interval '5 minutes'
               )
             )
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

