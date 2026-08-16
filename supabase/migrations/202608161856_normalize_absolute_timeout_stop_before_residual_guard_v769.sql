-- Ensure absolute max-hold safety exits cannot be blocked by first-tranche guards
-- when the engine's exit-decision metadata has not yet been persisted.

create or replace function public.normalize_absolute_timeout_exit_reason_v769()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_held_seconds numeric;
  v_absolute_max_holding_seconds numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL'
     or upper(coalesce(new.purpose, '')) <> 'STOP'
     or new.position_id is null then
    return new;
  end if;

  select * into p
  from public.trading_positions
  where id = new.position_id
  for update;

  if not found or p.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_held_seconds := greatest(
    0,
    extract(epoch from (now() - coalesce(p.opened_at, p.created_at, now())))
  );
  v_absolute_max_holding_seconds := greatest(
    1,
    coalesce(nullif(p.metadata->>'absolute_max_holding_seconds', '')::numeric, 600)
  );

  if v_held_seconds + 0.001 >= v_absolute_max_holding_seconds then
    update public.trading_positions
    set metadata = jsonb_set(
          coalesce(metadata, '{}'::jsonb),
          '{exit_policy_quote,approved_reason}',
          to_jsonb('HALF_HOLD_ABSOLUTE_TIMEOUT'::text),
          true
        ),
        updated_at = now()
    where id = new.position_id;
  end if;

  return new;
end;
$function$;

drop trigger if exists zzzz1_trading_orders_normalize_absolute_timeout_v769 on public.trading_orders;
create trigger zzzz1_trading_orders_normalize_absolute_timeout_v769
before insert on public.trading_orders
for each row
execute function public.normalize_absolute_timeout_exit_reason_v769();
