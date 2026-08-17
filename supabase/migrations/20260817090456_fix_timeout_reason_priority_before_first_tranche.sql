-- Keep timeout exits authoritative even when exit_policy_quote metadata is stale.
-- This mirrors the production hotfix applied after EPICUSDT demonstrated that
-- POST180_MAX_HOLD_TIMEOUT could be masked by a stale first-tranche reason.

do $$
declare
  v_def text;
  v_old text := $old$
  v_approved_reason := case
    when coalesce(p.metadata->>'pending_exit_reason', '') in (
      'STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'PRE_T1_PROFIT_PROTECTION_EXIT',
      'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT'
    ) then p.metadata->>'pending_exit_reason'
    else coalesce(
      nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
      nullif(p.metadata->>'pending_exit_reason', ''),
      ''
    )
  end;
$old$;
  v_new text := $new$
  v_approved_reason := case
    when upper(coalesce(p.metadata->>'pending_exit_reason', '')) in (
      'HALF_HOLD_ABSOLUTE_TIMEOUT',
      'POST180_MAX_HOLD_TIMEOUT',
      'STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'PRE_T1_PROFIT_PROTECTION_EXIT',
      'FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT'
    ) then upper(p.metadata->>'pending_exit_reason')
    else upper(coalesce(
      nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
      nullif(p.metadata->>'pending_exit_reason', ''),
      ''
    ))
  end;
$new$;
begin
  select pg_get_functiondef(p.oid)
    into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'guard_residual_sell_order_v751'
    and pg_get_function_identity_arguments(p.oid) = '';

  if v_def is null then
    raise exception 'guard_residual_sell_order_v751() not found';
  end if;

  if position(v_new in v_def) > 0 then
    return;
  end if;

  if position(v_old in v_def) = 0 then
    raise exception 'expected reason block not found';
  end if;

  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end
$$;
