-- v7.1.9 post-180 recovery tracking is shadow-only and must not change the
-- executable exit policy. The runtime persists this revision in
-- metadata.exit_policy_quote.revision, so the existing LOB sell guard must
-- accept it wherever it already accepts the executable-net parity revision.
-- No threshold, order type, or exit decision is changed by this migration.
do $$
declare
  v_oid oid;
  v_def text;
  v_count integer;
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

  if position('7.1.9-POST180-RECOVERY-SHADOW' in v_def) > 0 then
    return;
  end if;

  v_count := (
    length(v_def) - length(replace(v_def, '''7.1.9-EXECUTABLE-NET-PARITY''', ''))
  ) / length('''7.1.9-EXECUTABLE-NET-PARITY''');

  if v_count <> 3 then
    raise exception 'unexpected executable-net parity revision occurrence count: %', v_count;
  end if;

  v_def := replace(
    v_def,
    '''7.1.9-EXECUTABLE-NET-PARITY''',
    '''7.1.9-EXECUTABLE-NET-PARITY'', ''7.1.9-POST180-RECOVERY-SHADOW'''
  );

  execute v_def;
end
$$;

comment on function public.guard_lob_sell_order_v714() is
  'LOB sell guard including the shadow-only 7.1.9 post-180 recovery revision; executable thresholds remain unchanged.';
