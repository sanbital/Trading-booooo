-- Absolute max-hold is a hard safety boundary. Once reached, a STOP must be
-- allowed to close the full remainder before residual/first-tranche guards run.
-- This also works when trading_positions.absolute_max_holding_at is NULL by
-- falling back to metadata.absolute_max_holding_seconds (default 600 seconds).

do $$
declare
  v_def text;
  v_old text := $old$
  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif v_residual_stage then
$old$;
  v_new text := $new$
  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif upper(coalesce(new.purpose, '')) = 'STOP'
        and v_approved_reason in ('HALF_HOLD_ABSOLUTE_TIMEOUT', 'POST180_MAX_HOLD_TIMEOUT')
        and v_held_seconds + 0.001 >= greatest(
          1,
          coalesce(nullif(p.metadata->>'absolute_max_holding_seconds', '')::numeric, 600)
        ) then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif v_residual_stage then
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
    raise exception 'expected sell guard block not found';
  end if;

  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end
$$;
