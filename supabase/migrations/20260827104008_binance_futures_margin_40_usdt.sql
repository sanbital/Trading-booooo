-- Lower the operator-authorized Binance USDⓈ-M entry ticket from 50 USDT to
-- 40 USDT of posted margin. Existing positions and orders are intentionally untouched.

alter table public.trading_settings
  drop constraint if exists trading_settings_binance_futures_fixed_margin_ck;

alter table public.trading_settings
  add constraint trading_settings_binance_futures_fixed_margin_ck
  check (
    binance_futures_allocation_mode <> 'FIXED' or
    binance_futures_allocation_usdt >= 40
  );

create or replace function public.guard_order_position_venue_v760()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_leverage numeric;
  v_minimum_notional numeric;
begin
  if new.position_id is null then
    return new;
  end if;

  select * into p
  from public.trading_positions
  where id = new.position_id;

  if not found then
    raise exception using errcode='23514', message='ORDER_POSITION_NOT_FOUND';
  end if;
  if lower(coalesce(new.exchange, '')) <> lower(coalesce(p.exchange, ''))
     or upper(coalesce(new.market, '')) <> upper(coalesce(p.market, ''))
     or upper(coalesce(new.quote_currency, '')) <> upper(coalesce(p.quote_currency, '')) then
    raise exception using errcode='23514', message=format(
      'ORDER_POSITION_VENUE_MISMATCH order=%s:%s:%s position=%s:%s:%s',
      new.exchange, new.market, new.quote_currency,
      p.exchange, p.market, p.quote_currency
    );
  end if;

  if lower(p.exchange) = 'binance_futures'
     and upper(coalesce(new.purpose, '')) = 'ENTRY' then
    v_leverage := least(20, greatest(1, coalesce(nullif(p.leverage, 0), 3)));
    v_minimum_notional := 40 * v_leverage;
    if coalesce(new.requested_notional_quote, 0) + 0.00000001 < v_minimum_notional then
      raise exception using errcode='23514', message=format(
        'FUTURES_ENTRY_MARGIN_BELOW_40_USDT market=%s requested_notional=%s minimum_notional=%s leverage=%s',
        p.market, new.requested_notional_quote, v_minimum_notional, v_leverage
      );
    end if;
  end if;
  return new;
end;
$function$;

comment on function public.guard_order_position_venue_v760() is
  'Binance futures ENTRY requires at least 40 USDT posted margin; order venue must equal its position';

do $$
declare
  v_constraint text;
  v_guard text;
begin
  select pg_get_constraintdef(c.oid) into v_constraint
  from pg_constraint c
  where c.conrelid = 'public.trading_settings'::regclass
    and c.conname = 'trading_settings_binance_futures_fixed_margin_ck';

  select pg_get_functiondef(p.oid) into v_guard
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'guard_order_position_venue_v760';

  if v_constraint is null
     or position('binance_futures_allocation_usdt >= (40)' in v_constraint) = 0 then
    raise exception 'BINANCE_FUTURES_40_USDT_SETTING_GUARD_MISSING';
  end if;
  if v_guard is null
     or position('v_minimum_notional := 40 * v_leverage' in v_guard) = 0
     or position('FUTURES_ENTRY_MARGIN_BELOW_40_USDT' in v_guard) = 0 then
    raise exception 'BINANCE_FUTURES_40_USDT_ORDER_GUARD_MISSING';
  end if;
end
$$;
