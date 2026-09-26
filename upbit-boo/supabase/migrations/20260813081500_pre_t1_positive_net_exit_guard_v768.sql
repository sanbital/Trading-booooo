-- v7.6.8: pre-T1 profit protection must never manufacture a loss exit.
--
-- Two independent guards are installed:
-- 1) an AFTER-in-name-order BEFORE UPDATE sanitizer runs after the legacy aa_* profit
--    protection trigger and rejects a newly raised protected stop unless the current
--    executable bid is still above it and its fee-net locked return is strictly positive;
-- 2) a final trading_orders guard rejects any pre-T1 protection SELL whose executable
--    quote is not strictly net profitable.

create or replace function public.sanitize_pre_t1_profit_protection_v768()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_entry numeric;
  v_old_protected numeric;
  v_new_protected numeric;
  v_live_executable numeric;
  v_locked_net_bps numeric;
begin
  if new.is_paper is distinct from false or new.state <> 'OPEN' then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(old.average_entry_price, 0), 0);
  v_old_protected := coalesce(public.safe_numeric_v6112(old.metadata#>>'{profit_protection,protected_stop_price}'), 0);
  v_new_protected := coalesce(public.safe_numeric_v6112(new.metadata#>>'{profit_protection,protected_stop_price}'), 0);

  -- Nothing newly armed or raised above the entry price: leave legacy state untouched.
  if v_entry <= 0 or v_new_protected <= v_entry or v_new_protected <= v_old_protected then
    return new;
  end if;

  v_live_executable := public.safe_numeric_v6112(new.metadata#>>'{live_mark,executable_price}');
  v_locked_net_bps := public.safe_numeric_v6112(new.metadata#>>'{profit_protection,locked_net_bps_estimate}');

  -- A historical MFE may not retroactively arm a stop that current executable liquidity
  -- has already crossed. A protection floor that is non-positive after estimated costs is
  -- not profit protection either. Revert only the newly attempted protection state.
  if coalesce(v_live_executable, 0) <= v_new_protected or coalesce(v_locked_net_bps, 0) <= 0 then
    new.trailing_stop := old.trailing_stop;
    if old.metadata ? 'profit_protection' then
      new.metadata := jsonb_set(
        coalesce(new.metadata, '{}'::jsonb),
        '{profit_protection}',
        old.metadata->'profit_protection',
        true
      );
    else
      new.metadata := coalesce(new.metadata, '{}'::jsonb) - 'profit_protection';
    end if;
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'profit_protection_guard',
      jsonb_build_object(
        'revision', '7.6.8-PRE-T1-POSITIVE-NET',
        'reason', 'RETROACTIVE_PROFIT_PROTECTION_BLOCKED',
        'attempted_protected_stop_price', v_new_protected,
        'current_executable_price', v_live_executable,
        'locked_net_bps_estimate', v_locked_net_bps,
        'blocked_at', now()
      )
    );
  end if;

  return new;
end;
$function$;

drop trigger if exists ab_trading_positions_pre_t1_profit_net_guard_v768
  on public.trading_positions;
create trigger ab_trading_positions_pre_t1_profit_net_guard_v768
before update of peak_price, paid_fees_quote, realized_cost_quote
on public.trading_positions
for each row execute function public.sanitize_pre_t1_profit_protection_v768();

create or replace function public.guard_pre_t1_profit_exit_positive_net_v768()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  p public.trading_positions%rowtype;
  v_reason text;
  v_pending text;
  v_net_allowed boolean;
  v_expected_net numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select * into p from public.trading_positions where id = new.position_id;
  if not found then
    return new;
  end if;

  v_pending := coalesce(p.metadata->>'pending_exit_reason', '');
  v_reason := case
    when v_pending in ('PRE_T1_PROFIT_PROTECTION_EXIT', 'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT')
      then v_pending
    else coalesce(p.metadata#>>'{exit_policy_quote,approved_reason}', '')
  end;

  if v_reason not in ('PRE_T1_PROFIT_PROTECTION_EXIT', 'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT') then
    return new;
  end if;

  v_net_allowed := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,executable_net_allowed}', '')::boolean,
    nullif(p.metadata#>>'{exit_policy_quote,allowed}', '')::boolean,
    false
  );
  v_expected_net := coalesce(
    public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,expected_net_profit_quote}'),
    0
  );

  if not v_net_allowed or v_expected_net <= 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'PRE_T1_PROFIT_PROTECTION_REQUIRES_POSITIVE_NET market=%s reason=%s allowed=%s expected_net=%s',
        p.market, v_reason, v_net_allowed, round(v_expected_net, 8)
      );
  end if;

  return new;
end;
$function$;

drop trigger if exists zzzzzz_trading_orders_pre_t1_net_guard_v768
  on public.trading_orders;
create trigger zzzzzz_trading_orders_pre_t1_net_guard_v768
before insert on public.trading_orders
for each row execute function public.guard_pre_t1_profit_exit_positive_net_v768();
