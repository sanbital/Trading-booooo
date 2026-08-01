-- Tighten only the terminal LOB hard stop after 180 seconds.
-- Positive executable net exits, pre-180 reversals, targets, and the shadow
-- recovery observer remain unchanged.
do $$
declare
  v_oid oid;
  v_def text;
  v_old_reason_count integer;
  v_guarded_threshold_count integer;
  v_fallback_threshold_count integer;
  v_revision_count integer;
begin
  select p.oid
    into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'guard_lob_sell_order_v714'
    and p.prokind = 'f';

  if v_oid is null then
    raise exception 'guard_lob_sell_order_v714 not found';
  end if;

  v_def := pg_get_functiondef(v_oid);

  if position('HARD_STOP_MINUS_2_AFTER_180S' in v_def) > 0
     and position('7.2.0-POST180-MINUS2-HARD-STOP' in v_def) > 0 then
    return;
  end if;

  v_old_reason_count := (
    length(v_def) - length(replace(v_def, 'HARD_STOP_MINUS_3_AFTER_180S', ''))
  ) / length('HARD_STOP_MINUS_3_AFTER_180S');
  v_guarded_threshold_count := (
    length(v_def) - length(replace(v_def, 'v_guarded_net_return_pct <= -3', ''))
  ) / length('v_guarded_net_return_pct <= -3');
  v_fallback_threshold_count := (
    length(v_def) - length(replace(v_def, 'v_drawdown_pct <= -3', ''))
  ) / length('v_drawdown_pct <= -3');
  v_revision_count := (
    length(v_def) - length(replace(v_def, '''7.1.9-POST180-RECOVERY-SHADOW''', ''))
  ) / length('''7.1.9-POST180-RECOVERY-SHADOW''');

  if v_old_reason_count <> 1
     or v_guarded_threshold_count <> 1
     or v_fallback_threshold_count <> 1
     or v_revision_count <> 3 then
    raise exception
      'unexpected guard shape reason=% guarded=% fallback=% revision=%',
      v_old_reason_count,
      v_guarded_threshold_count,
      v_fallback_threshold_count,
      v_revision_count;
  end if;

  v_def := replace(
    v_def,
    '''7.1.9-POST180-RECOVERY-SHADOW''',
    '''7.1.9-POST180-RECOVERY-SHADOW'', ''7.2.0-POST180-MINUS2-HARD-STOP'''
  );
  v_def := replace(
    v_def,
    'HARD_STOP_MINUS_3_AFTER_180S',
    'HARD_STOP_MINUS_2_AFTER_180S'
  );
  v_def := replace(
    v_def,
    'v_guarded_net_return_pct <= -3',
    'v_guarded_net_return_pct <= -2'
  );
  v_def := replace(
    v_def,
    'v_drawdown_pct <= -3',
    'v_drawdown_pct <= -2'
  );
  v_def := replace(v_def, 'V719_MINUS3_EXIT_MISMATCH', 'V720_MINUS2_EXIT_MISMATCH');
  v_def := replace(v_def, 'V719_MINUS3_EXIT_MUST_BE_STOP', 'V720_MINUS2_EXIT_MUST_BE_STOP');

  execute v_def;
end
$$;

comment on function public.guard_lob_sell_order_v714() is
  'LOB sell guard: after 180 seconds, exit at positive executable net or at executable net return <= -2%; v7.2.0 runtime revision allowed.';
