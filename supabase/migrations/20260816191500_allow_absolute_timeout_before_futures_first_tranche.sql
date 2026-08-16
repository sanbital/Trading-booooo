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
        and v_approved_reason = 'HALF_HOLD_ABSOLUTE_TIMEOUT'
        and (
          (p.absolute_max_holding_at is not null and now() + interval '1 millisecond' >= p.absolute_max_holding_at)
          or v_held_seconds + 0.001 >= greatest(
            1,
            coalesce(nullif(p.metadata->>'absolute_max_holding_seconds', '')::numeric, 600)
          )
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
    raise exception 'expected guard_residual_sell_order_v751 source block not found';
  end if;

  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end
$$;
