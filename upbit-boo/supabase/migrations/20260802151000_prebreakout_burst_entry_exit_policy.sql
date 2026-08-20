-- PREBREAKOUT-BURST-V1
-- LOB positions have no planned stop, experimental arm stop, fixed target, timeout or
-- post-180 profit timer. The only price floor is -2% of executable net. Normal exits are
-- evidence-based: confirmed upper-band re-entry, failed reclaim, or order-book collapse.

create or replace function public.guard_lob_sell_order_v714()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_strategy text;
  v_purpose text;
  v_approved_reason text;
  v_policy text;
  v_quote_price numeric;
  v_quote_at timestamptz;
  v_remaining_qty numeric;
  v_qty numeric;
  v_fee_rate numeric;
  v_unrecovered_cost numeric;
  v_allocated_cost numeric;
  v_net numeric;
  v_net_return_pct numeric;
  v_weakness_votes integer;
  v_reentry boolean;
  v_reclaim_failed boolean;
  v_book_collapse boolean;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.is_paper is distinct from false then
    return new;
  end if;
  v_strategy := upper(coalesce(p.metadata#>>'{lob_signal,strategy}', ''));
  if v_strategy <> 'LOB_SCALP' then
    return new;
  end if;

  v_purpose := upper(coalesce(new.purpose, ''));
  v_approved_reason := coalesce(p.metadata#>>'{exit_policy_quote,approved_reason}', '');
  v_policy := coalesce(p.metadata#>>'{exit_policy_quote,burst_policy_version}', '');

  -- Human/emergency and reconciliation exits are operational escape hatches, not strategy
  -- stops. They remain unconditional.
  if v_purpose in ('EMERGENCY', 'MANUAL', 'RECONCILIATION')
     or v_approved_reason in ('RISK_EMERGENCY', 'RECONCILIATION_FAILURE', 'MANUAL_EMERGENCY_CLOSE') then
    return new;
  end if;
  if v_purpose <> 'STOP' then
    raise exception using errcode='23514', message=format(
      'BURST_POLICY_NON_STOP_EXIT_BLOCKED market=%s purpose=%s', new.market, v_purpose
    );
  end if;

  v_quote_price := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,executable_vwap}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,sell_price}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,executable_price}', '')::numeric
  );
  v_quote_at := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz,
    nullif(p.metadata#>>'{live_mark,measured_at}', '')::timestamptz
  );
  if coalesce(v_quote_price, 0) <= 0 or v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
    raise exception using errcode='23514', message=format(
      'BURST_POLICY_MISSING_OR_STALE_EXECUTABLE_QUOTE market=%s reason=%s',
      new.market, v_approved_reason
    );
  end if;

  v_remaining_qty := greatest(coalesce(p.remaining_quantity, 0), 0);
  v_qty := least(greatest(coalesce(new.requested_volume, 0), 0), v_remaining_qty);
  v_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_unrecovered_cost := greatest(
    0,
    coalesce(p.realized_cost_quote, 0) + coalesce(p.paid_fees_quote, 0) -
    coalesce(p.realized_proceeds_quote, 0)
  );
  v_allocated_cost := case when v_remaining_qty > 0
    then v_unrecovered_cost * v_qty / v_remaining_qty else 0 end;
  v_net := v_quote_price * v_qty * (1 - v_fee_rate) - v_allocated_cost;
  v_net_return_pct := case when v_allocated_cost > 0
    then v_net / v_allocated_cost * 100 else 0 end;

  if v_approved_reason = 'HARD_STOP_MINUS_2' and v_net_return_pct <= -2 then
    return new;
  end if;
  if v_policy <> 'PREBREAKOUT-BURST-V1' then
    raise exception using errcode='23514', message=format(
      'BURST_POLICY_REVISION_MISMATCH market=%s policy=%s reason=%s',
      new.market, v_policy, v_approved_reason
    );
  end if;

  v_weakness_votes := greatest(0, coalesce(nullif(
    p.metadata#>>'{exit_policy_quote,bb_weakness_votes}', '')::integer, 0));
  v_reentry := coalesce((p.metadata#>>'{exit_policy_quote,bb_upper_reentry_confirmed}')::boolean, false);
  v_reclaim_failed := coalesce((p.metadata#>>'{exit_policy_quote,bb_reclaim_failed}')::boolean, false);
  v_book_collapse := coalesce((p.metadata#>>'{exit_policy_quote,orderbook_collapse}')::boolean, false);

  if v_approved_reason = 'BB_UPPER_REENTRY_CONFIRMED' and v_reentry and v_weakness_votes >= 2 then
    return new;
  end if;
  if v_approved_reason = 'BB_RECLAIM_FAILED' and v_reclaim_failed and v_weakness_votes >= 1 then
    return new;
  end if;
  if v_approved_reason = 'ORDERBOOK_COLLAPSE' and v_book_collapse then
    return new;
  end if;

  raise exception using errcode='23514', message=format(
    'BURST_POLICY_EXIT_BLOCKED market=%s reason=%s net_return_pct=%s weakness=%s reentry=%s reclaim_failed=%s collapse=%s',
    new.market, v_approved_reason, round(v_net_return_pct, 6), v_weakness_votes,
    v_reentry, v_reclaim_failed, v_book_collapse
  );
end;
$function$;

comment on function public.guard_lob_sell_order_v714() is
  'PREBREAKOUT-BURST-V1: no planned/experimental/time stop or fixed target. Executable-net -2 percent is the only loss floor; normal exits require BB upper re-entry plus weak flow, failed reclaim, or order-book collapse.';
