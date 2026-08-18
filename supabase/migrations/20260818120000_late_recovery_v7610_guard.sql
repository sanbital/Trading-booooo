-- Trading-booooo v7.6.10 Late Recovery database order guard.
-- No table/schema changes. Existing residual/T1 protections remain authoritative.

DO $migration$
DECLARE
  v_def text;
  v_anchor text := $anchor$  v_policy := coalesce(p.metadata#>>'{exit_policy_quote,burst_policy_version}', '');

  -- LEGACY_BURST_GUARD_SCOPED_V761$anchor$;
  v_replacement text := $replacement$  v_policy := coalesce(p.metadata#>>'{exit_policy_quote,burst_policy_version}', '');

  -- Late Recovery is enforced by guard_residual_sell_order_v751 below. The legacy burst
  -- guard must not reinterpret these supplemental reasons as legacy burst exits.
  if v_approved_reason in ('LATE_RECOVERY_NET_POSITIVE_EXIT', 'LATE_RECOVERY_DRAWDOWN_33_EXIT') then
    return new;
  end if;

  -- LEGACY_BURST_GUARD_SCOPED_V761$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.guard_lob_sell_order_v714()'::regprocedure) INTO v_def;
  IF v_def IS NULL OR (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'LATE_RECOVERY_V7610_BURST_GUARD_SOURCE_DRIFT';
  END IF;
  EXECUTE replace(v_def, v_anchor, v_replacement);
END
$migration$;

DO $migration$
DECLARE
  v_def text;
  v_anchor text := $anchor$  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif upper(coalesce(new.purpose, '')) = 'STOP'$anchor$;
  v_replacement text := $replacement$  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif not v_residual_stage
        and upper(coalesce(new.purpose, '')) = 'STOP'
        and v_approved_reason in ('LATE_RECOVERY_NET_POSITIVE_EXIT', 'LATE_RECOVERY_DRAWDOWN_33_EXIT') then
    if v_held_seconds < 460
       or v_held_seconds >= greatest(
         1,
         coalesce(public.safe_numeric_v6112(p.metadata->>'absolute_max_holding_seconds'), 600)
       ) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_OUTSIDE_OWNER_WINDOW market=%s held_seconds=%s',
        p.market, round(v_held_seconds, 3)
      );
    end if;
    if upper(coalesce(new.order_type, '')) <> 'LIMIT'
       or upper(coalesce(new.time_in_force, '')) <> 'FOK' then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_REQUIRES_LIMIT_FOK market=%s type=%s tif=%s',
        p.market, new.order_type, new.time_in_force
      );
    end if;
    if coalesce(p.metadata#>>'{exit_policy_quote,approval_scope}', '') <> 'SINGLE_FOK_ORDER'
       or coalesce(p.metadata#>>'{exit_policy_quote,approved_reason}', '') <> v_approved_reason
       or coalesce(p.metadata#>>'{exit_policy_quote,late_recovery_revision}', '') <> '7.6.10-LATE-RECOVERY-460-R33'
       or lower(coalesce(p.metadata#>>'{exit_policy_quote,full_depth}', 'false')) <> 'true' then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_MISSING_ORDER_AUTHORITY market=%s reason=%s', p.market, v_approved_reason
      );
    end if;
    if v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_STALE_EXECUTABLE_QUOTE market=%s reason=%s', p.market, v_approved_reason
      );
    end if;
    if p.metadata#>>'{exit_policy_quote,sell_quantity}' is null
       or abs(
         coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_quantity}'), 0)
         - v_requested_qty
       ) > greatest(v_tolerance, v_requested_qty * 0.00000001) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_QUANTITY_MISMATCH market=%s requested=%s approved=%s',
        p.market, v_requested_qty,
        coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_quantity}'), 0)
      );
    end if;
    if p.metadata#>>'{exit_policy_quote,sell_price}' is null
       or abs(
         coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_price}'), 0)
         - v_price
       ) > greatest(0.000000000001, abs(v_price) * 0.00000001) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_PRICE_MISMATCH market=%s requested=%s approved=%s',
        p.market, v_price,
        coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_price}'), 0)
      );
    end if;
    if v_requested_qty + v_tolerance < greatest(0, p.remaining_quantity) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_REQUIRES_FULL_POSITION market=%s requested=%s remaining=%s',
        p.market, v_requested_qty, p.remaining_quantity
      );
    end if;
    if p.metadata#>>'{exit_policy_quote,expected_net_profit_quote}' is null then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_NET_EVIDENCE_MISSING market=%s reason=%s', p.market, v_approved_reason
      );
    end if;

    if v_approved_reason = 'LATE_RECOVERY_NET_POSITIVE_EXIT' then
      if coalesce(p.metadata#>>'{exit_policy_quote,status}', '') <> 'LATE_RECOVERY_NET_POSITIVE'
         or v_expected_net_profit_quote < 0 then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_NET_POSITIVE_NOT_PROVEN market=%s expected_net=%s',
          p.market, round(v_expected_net_profit_quote, 8)
        );
      end if;
    else
      if coalesce(p.metadata#>>'{exit_policy_quote,status}', '') <> 'LATE_RECOVERY_DRAWDOWN_33'
         or v_expected_net_profit_quote >= 0 then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_DRAWDOWN_NEGATIVE_NET_REQUIRED market=%s expected_net=%s',
          p.market, round(v_expected_net_profit_quote, 8)
        );
      end if;
      if coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0) <= 0
         or coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0) >= v_entry then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_DRAWDOWN_TROUGH_INVALID market=%s entry=%s trough=%s',
          p.market, v_entry,
          coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0)
        );
      end if;
      if (
        (v_price - coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0))
        / nullif(
          v_entry - coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0),
          0
        )
      ) + 0.000000001 < 0.33 then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_DRAWDOWN_33_NOT_REACHED market=%s entry=%s trough=%s limit=%s',
          p.market, v_entry,
          coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0),
          v_price
        );
      end if;
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif upper(coalesce(new.purpose, '')) = 'STOP'$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.guard_residual_sell_order_v751()'::regprocedure) INTO v_def;
  IF v_def IS NULL OR (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'LATE_RECOVERY_V7610_RESIDUAL_GUARD_SOURCE_DRIFT';
  END IF;
  EXECUTE replace(v_def, v_anchor, v_replacement);
END
$migration$;

COMMENT ON FUNCTION public.guard_residual_sell_order_v751() IS
  'Split/residual exit authority plus fail-closed Late Recovery 460s/FOK guard (v7.6.10).';
