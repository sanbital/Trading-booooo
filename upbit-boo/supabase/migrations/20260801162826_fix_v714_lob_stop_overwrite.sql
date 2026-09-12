create or replace function public.enforce_v714_volatility_aware_position_policy()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_qty numeric;
  v_exit_fee_rate numeric;
  v_entry_fee_rate numeric;
  v_entry_cost numeric;
  v_profit_buffer_quote numeric;
  v_min_target numeric;
  v_stop_text text;
  v_stop_bps numeric;
  v_tick numeric;
  v_planned_stop numeric;
begin
  if new.is_paper is distinct from false or new.state <> 'OPEN' then
    return new;
  end if;

  if upper(coalesce(new.metadata#>>'{lob_signal,strategy}', new.metadata#>>'{scalp_signal,strategy}', '')) <> 'LOB_SCALP' then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  v_qty := greatest(coalesce(nullif(new.remaining_quantity, 0), nullif(new.initial_quantity, 0), 0), 0);
  if coalesce(v_entry, 0) <= 0 then
    return new;
  end if;

  v_exit_fee_rate := case when lower(new.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_entry_fee_rate := case when lower(new.exchange) = 'upbit' then 0.0005 else 0 end;
  v_profit_buffer_quote := case when lower(new.exchange) = 'upbit' then 1 else 0.01 end;

  v_stop_text := coalesce(
    nullif(new.metadata#>>'{lob_signal,stop_bps}', ''),
    nullif(new.metadata#>>'{scalp_signal,stop_bps}', '')
  );
  v_stop_bps := case
    when v_stop_text ~ '^[0-9]+([.][0-9]+)?$' then v_stop_text::numeric
    else null
  end;
  v_tick := nullif(new.tick_size, 0);

  if v_stop_bps between 6 and 200 and coalesce(v_tick, 0) > 0 then
    v_planned_stop := floor((v_entry * (1 - v_stop_bps / 10000)) / v_tick) * v_tick;
    new.stop_price := greatest(coalesce(new.stop_price, 0), v_planned_stop);
  else
    -- Missing or malformed LOB geometry falls back to the emergency boundary only.
    -- It must never overwrite a valid tighter stop already stored on the position.
    new.stop_price := greatest(coalesce(new.stop_price, 0), v_entry * 0.97);
    v_planned_stop := new.stop_price;
  end if;

  new.max_holding_at := 'infinity'::timestamptz;

  if v_qty > 0 then
    v_entry_cost := v_entry * v_qty * (1 + v_entry_fee_rate);
    v_min_target := (v_entry_cost + v_profit_buffer_quote) / (v_qty * (1 - v_exit_fee_rate));
    new.target_1 := greatest(coalesce(nullif(new.target_1, 0), v_min_target), v_min_target);
    new.target_2 := greatest(coalesce(nullif(new.target_2, 0), new.target_1), new.target_1, v_min_target);
  end if;

  new.trailing_stop := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.2.4-LOB-PLANNED-STOP',
    'active_exit_revision', '7.2.4-LOB-PLANNED-STOP',
    'pre_60_exit_rule', 'PLANNED_STOP_ONLY',
    'seconds_60_to_180_exit_rule', 'PLANNED_STOP_OR_NET_POSITIVE_TARGET_OR_PERSISTENT_REVERSAL',
    'post_180_exit_rule', 'PLANNED_STOP_OR_EXECUTABLE_NET_POSITIVE_OR_DRAWDOWN_LTE_MINUS_2PCT',
    'reversal_timer_starts_after_seconds', 60,
    'signal_reversal_required_seconds', 30,
    'lob_invalidation_required_seconds', 50,
    'hard_stop_return_pct', -3,
    'planned_stop_bps', v_stop_bps,
    'planned_stop_price', v_planned_stop,
    'minimum_post_180_net_quote', 0,
    'target_profit_buffer_quote', v_profit_buffer_quote,
    'synthetic_exit_haircut_bps', 0,
    'entry_fee_double_count_protection', true,
    'timeout_loss_exit_enabled', false,
    'trail_exit_enabled', false,
    'lob_invalidation_exit_enabled', true,
    'policy_enforced_at', now()
  );
  return new;
end;
$function$;

-- Re-run the final policy trigger on active LOB positions so any legacy 3% overwrite is
-- immediately replaced by the scanner-derived planned stop.
update public.trading_positions
set stop_price = stop_price,
    updated_at = now()
where state in ('ENTRY_PENDING', 'OPEN', 'EXITING')
  and upper(coalesce(
    metadata#>>'{lob_signal,strategy}',
    metadata#>>'{scalp_signal,strategy}',
    ''
  )) = 'LOB_SCALP';
