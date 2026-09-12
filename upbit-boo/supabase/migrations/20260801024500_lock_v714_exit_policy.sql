begin;

-- v7.1.4 is the sole authority for LOB position geometry and sell-order approval.
-- Remove every legacy trigger that can rewrite stop/target values or reject an order
-- using an older time/profit policy.
drop trigger if exists trading_positions_v708_profit_only_exit on public.trading_positions;
drop trigger if exists zz_trading_positions_exit_policy_v713 on public.trading_positions;
drop trigger if exists zz_trading_orders_lob_exit_guard_v713 on public.trading_orders;
drop trigger if exists trading_orders_target_fee_net_guard_v722 on public.trading_orders;

drop function if exists public.enforce_v708_profit_only_exit_policy();
drop function if exists public.enforce_v713_net1_minus3_position_policy();
drop function if exists public.guard_lob_sell_order_v713();
drop function if exists public.guard_target_market_order_fee_net_v722();

-- Recreate the v7.1.4 triggers last, with deterministic names that sort after the
-- remaining non-policy bookkeeping triggers.
drop trigger if exists zz_trading_positions_exit_policy_v714 on public.trading_positions;
create trigger zz_trading_positions_exit_policy_v714
before insert or update on public.trading_positions
for each row execute function public.enforce_v714_volatility_aware_position_policy();

drop trigger if exists zz_trading_orders_lob_exit_guard_v714 on public.trading_orders;
create trigger zz_trading_orders_lob_exit_guard_v714
before insert on public.trading_orders
for each row execute function public.guard_lob_sell_order_v714();

-- Re-run the canonical position policy for currently open live LOB positions.
update public.trading_positions
set updated_at = now()
where is_paper is false
  and state = 'OPEN'
  and upper(coalesce(metadata#>>'{lob_signal,strategy}', metadata#>>'{scalp_signal,strategy}', '')) = 'LOB_SCALP';

-- Fail the migration if a legacy policy trigger or function survived.
do $lock$
declare
  v_legacy_trigger_count integer;
  v_legacy_function_count integer;
  v_v714_position_trigger_count integer;
  v_v714_order_trigger_count integer;
begin
  select count(*) into v_legacy_trigger_count
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and n.nspname = 'public'
    and t.tgname in (
      'trading_positions_v708_profit_only_exit',
      'zz_trading_positions_exit_policy_v713',
      'zz_trading_orders_lob_exit_guard_v713',
      'trading_orders_target_fee_net_guard_v722'
    );

  select count(*) into v_legacy_function_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'enforce_v708_profit_only_exit_policy',
      'enforce_v713_net1_minus3_position_policy',
      'guard_lob_sell_order_v713',
      'guard_target_market_order_fee_net_v722'
    );

  select count(*) into v_v714_position_trigger_count
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and n.nspname = 'public'
    and c.relname = 'trading_positions'
    and t.tgname = 'zz_trading_positions_exit_policy_v714';

  select count(*) into v_v714_order_trigger_count
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and n.nspname = 'public'
    and c.relname = 'trading_orders'
    and t.tgname = 'zz_trading_orders_lob_exit_guard_v714';

  if v_legacy_trigger_count <> 0 or v_legacy_function_count <> 0 then
    raise exception 'V714_POLICY_LOCK_FAILED legacy_triggers=% legacy_functions=%',
      v_legacy_trigger_count, v_legacy_function_count;
  end if;

  if v_v714_position_trigger_count <> 1 or v_v714_order_trigger_count <> 1 then
    raise exception 'V714_POLICY_LOCK_FAILED position_guard=% order_guard=%',
      v_v714_position_trigger_count, v_v714_order_trigger_count;
  end if;
end;
$lock$;

commit;
