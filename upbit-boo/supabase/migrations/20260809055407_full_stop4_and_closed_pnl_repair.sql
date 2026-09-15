begin;

-- CLOSED Binance accounting is normally immutable. The fill-ledger repair function
-- is the one narrowly scoped exception, so it must enable the existing rewrite guard
-- only for its own accounting UPDATE and then restore the caller's prior setting.
create or replace function public.recompute_closed_position_from_exchange_fills(
  p_position_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_pos public.trading_positions%rowtype;
  v_entry_qty numeric := 0;
  v_entry_cost numeric := 0;
  v_entry_fee numeric := 0;
  v_sold_qty numeric := 0;
  v_proceeds numeric := 0;
  v_sell_fee numeric := 0;
  v_sold_frac numeric := 0;
  v_realized_cost numeric := 0;
  v_fees numeric := 0;
  v_pnl numeric := 0;
  v_return numeric := 0;
  v_changed boolean := false;
  v_previous_rewrite_setting text;
begin
  select * into v_pos
    from public.trading_positions
   where id = p_position_id
   for update;

  if not found
     or lower(coalesce(v_pos.exchange, '')) <> 'binance'
     or upper(coalesce(v_pos.state, '')) <> 'CLOSED'
     or coalesce(v_pos.is_paper, false) then
    return false;
  end if;

  select
    coalesce(sum(case
      when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) = upper(coalesce(f.base_asset,''))
        then greatest(f.quantity - coalesce(f.fee_amount, 0), 0)
      when f.side = 'BUY' then f.quantity
      else 0 end), 0),
    coalesce(sum(case when f.side = 'BUY' then f.quote_amount else 0 end), 0),
    coalesce(sum(case
      when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) <> upper(coalesce(f.base_asset,''))
        then coalesce(f.fee_quote_amount, 0)
      else 0 end), 0),
    coalesce(sum(case when f.side = 'SELL' then f.quantity else 0 end), 0),
    coalesce(sum(case when f.side = 'SELL' then f.quote_amount else 0 end), 0),
    coalesce(sum(case when f.side = 'SELL' then coalesce(f.fee_quote_amount, 0) else 0 end), 0)
  into v_entry_qty, v_entry_cost, v_entry_fee,
       v_sold_qty, v_proceeds, v_sell_fee
  from public.exchange_trade_fills f
  where f.position_id = p_position_id
    and f.exchange = 'binance';

  if v_entry_qty <= 0 or v_sold_qty <= 0 then
    return false;
  end if;

  v_sold_frac := least(v_sold_qty / v_entry_qty, 1);
  if v_sold_frac < 0.995 then
    return false;
  end if;

  v_realized_cost := v_entry_cost * v_sold_frac;
  v_fees := (v_entry_fee * v_sold_frac) + v_sell_fee;
  v_pnl := v_proceeds - v_realized_cost - v_fees;
  v_return := case when v_realized_cost > 0 then v_pnl / v_realized_cost * 100 else 0 end;

  v_changed :=
       abs(coalesce(v_pos.realized_proceeds_quote, 0) - v_proceeds) > 0.00000001
    or abs(coalesce(v_pos.realized_cost_quote, 0) - v_realized_cost) > 0.00000001
    or abs(coalesce(v_pos.paid_fees_quote, 0) - v_fees) > 0.00000001
    or abs(coalesce(v_pos.realized_pnl_quote, 0) - v_pnl) > 0.00000001
    or abs(coalesce(v_pos.realized_return_pct, 0) - v_return) > 0.00000001;

  if not v_changed then
    return false;
  end if;

  v_previous_rewrite_setting := current_setting(
    'trading_boooo.allow_closed_rewrite',
    true
  );
  perform set_config('trading_boooo.allow_closed_rewrite', 'on', true);

  update public.trading_positions
     set realized_proceeds_quote = v_proceeds,
         realized_cost_quote = v_realized_cost,
         paid_fees_quote = v_fees,
         realized_pnl_quote = v_pnl,
         realized_return_pct = v_return,
         fee_accounting_quality = 'EXACT',
         accounting_version = '7.5.4',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'closed_fill_repair', jsonb_build_object(
             'version', '7.5.4-FULL-COST',
             'repaired_at', now(),
             'source', 'COMPLETE_EXCHANGE_TRADE_FILLS',
             'entry_quantity', v_entry_qty,
             'sold_quantity', v_sold_qty,
             'entry_cost_quote', v_entry_cost,
             'proceeds_quote', v_proceeds,
             'fees_quote', v_fees,
             'previous_realized_cost_quote', v_pos.realized_cost_quote,
             'previous_realized_pnl_quote', v_pos.realized_pnl_quote,
             'previous_realized_return_pct', v_pos.realized_return_pct
           )
         ),
         updated_at = now()
   where id = p_position_id;

  perform set_config(
    'trading_boooo.allow_closed_rewrite',
    coalesce(nullif(v_previous_rewrite_setting, ''), 'off'),
    true
  );

  return true;
end;
$function$;

revoke all on function public.recompute_closed_position_from_exchange_fills(uuid)
  from public, anon, authenticated;
grant execute on function public.recompute_closed_position_from_exchange_fills(uuid)
  to service_role;

-- Profit keeps the staged +5%/+10% behavior. Loss does not: a fee-net -4%
-- executable price authorizes the entire remaining quantity in the first cycle.
create or replace function public.enforce_residual_exit_position_policy_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(new.initial_quantity, 0) <= 0 then
    return new;
  end if;

  v_step := greatest(0, coalesce(new.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, new.initial_quantity * 0.00000001);
  v_residual_stage := coalesce(new.remaining_quantity, new.initial_quantity) <=
    new.initial_quantity * 0.5 + v_tolerance;

  new.stop_price := v_entry * 0.96;
  new.target_1 := v_entry * 1.05;
  new.target_2 := v_entry * 1.10;
  new.t1_allocation_pct := 50;
  new.t1_completed := v_residual_stage;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.5.2-FULL-SL4-HOTFIX-R1',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'first_tranche_ratio', 0.5,
      'residual_ratio', 0.5,
      'first_take_profit_pct', 5,
      'loss_exit_ratio', 1,
      'full_stop_loss_pct', -4,
      'residual_take_profit_pct', 10,
      'residual_exit_enabled', true,
      'protected_stop_loss_enabled', true,
      'non_threshold_exit_enabled', false,
      'return_basis', 'EXECUTABLE_PRICE_NET_OF_EXIT_FEE_VS_ENTRY_PRICE',
      'stage', case when v_residual_stage then 'RESIDUAL' else 'FIRST_TRANCHE' end,
      'enforced_at', now()
    )
  );
  return new;
end;
$function$;

create or replace function public.guard_residual_sell_order_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_price numeric;
  v_quote_at timestamptz;
  v_gross_return_pct numeric;
  v_net_return_pct numeric;
  v_fee_rate numeric;
  v_protected_qty numeric;
  v_sellable_qty numeric;
  v_requested_qty numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
  v_min_exit_notional numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select * into p
  from public.trading_positions
  where id = new.position_id
  for update;

  if not found then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_POSITION_NOT_FOUND';
  end if;
  if p.state not in ('OPEN','EXITING') then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_POSITION_NOT_SELLABLE state=%s market=%s', p.state, p.market
    );
  end if;

  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(p.initial_quantity, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_INVALID_POSITION_BASIS';
  end if;

  v_price := coalesce(
    nullif(new.requested_price, 0),
    nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,executable_vwap}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,sell_price}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,executable_price}', '')::numeric
  );
  v_quote_at := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz,
    nullif(p.metadata#>>'{live_mark,measured_at}', '')::timestamptz
  );

  if coalesce(v_price, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_MISSING_EXECUTABLE_PRICE';
  end if;
  if new.requested_price is null and (v_quote_at is null or now() - v_quote_at > interval '30 seconds') then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_STALE_EXECUTABLE_PRICE';
  end if;

  v_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_gross_return_pct := (v_price / v_entry - 1) * 100;
  v_net_return_pct := (v_price * (1 - v_fee_rate) / v_entry - 1) * 100;
  v_step := greatest(0, coalesce(p.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, p.initial_quantity * 0.00000001);
  v_protected_qty := greatest(0, p.initial_quantity * 0.5);
  v_residual_stage := p.remaining_quantity <= v_protected_qty + v_tolerance;
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));

  if v_net_return_pct <= -3.999 then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif v_residual_stage then
    if v_net_return_pct < 9.999 then
      raise exception using errcode='23514', message=format(
        'RESIDUAL_THRESHOLD_NOT_REACHED market=%s net_return_pct=%s',
        p.market, round(v_net_return_pct, 6)
      );
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity);
  else
    if v_gross_return_pct < 4.999 then
      raise exception using errcode='23514', message=format(
        'FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_return_pct=%s',
        p.market, round(v_gross_return_pct, 6)
      );
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
  end if;

  if v_step > 0 then
    v_sellable_qty := floor((v_sellable_qty + v_step * 0.000000001) / v_step) * v_step;
  end if;
  new.requested_volume := least(v_requested_qty, v_sellable_qty);

  if coalesce(new.requested_volume, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_NO_AUTHORIZED_QUANTITY market=%s residual_stage=%s remaining_qty=%s',
      p.market, v_residual_stage, p.remaining_quantity
    );
  end if;

  v_min_exit_notional := case when lower(p.exchange) = 'upbit' then 5000 else 5 end;
  if new.requested_volume * v_price < v_min_exit_notional then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_EXIT_BELOW_EXCHANGE_MINIMUM market=%s notional=%s minimum=%s',
      p.market, round(new.requested_volume * v_price, 8), v_min_exit_notional
    );
  end if;

  new.requested_notional_quote := new.requested_volume * v_price;
  return new;
end;
$function$;

comment on function public.enforce_residual_exit_position_policy_v751() is
  'v7.5.2 hotfix: profit scales at TP5/TP10; fee-net SL4 exits 100% immediately';
comment on function public.guard_residual_sell_order_v751() is
  'v7.5.2 hotfix guard: any fee-net loss <= -4% authorizes the full remaining sell';

-- Re-stamp active positions and repair all complete CLOSED Binance ledgers.
update public.trading_positions
set updated_at = now()
where state in ('OPEN','EXITING')
  and coalesce(initial_quantity, 0) > 0;

create or replace function public.backfill_closed_binance_position_economics(
  p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_limit integer := least(100, greatest(1, coalesce(p_limit, 50)));
  v_updated integer := 0;
  v_previous_rewrite_setting text;
begin
  v_previous_rewrite_setting := current_setting(
    'trading_boooo.allow_closed_rewrite',
    true
  );
  perform set_config('trading_boooo.allow_closed_rewrite', 'on', true);

  with fill_totals as (
    select
      f.position_id,
      coalesce(sum(case
        when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) = upper(coalesce(f.base_asset,''))
          then greatest(f.quantity - coalesce(f.fee_amount, 0), 0)
        when f.side = 'BUY' then f.quantity else 0 end), 0) as entry_qty,
      coalesce(sum(case when f.side = 'BUY' then f.quote_amount else 0 end), 0) as entry_cost,
      coalesce(sum(case
        when f.side = 'BUY' and upper(coalesce(f.fee_asset,'')) <> upper(coalesce(f.base_asset,''))
          then coalesce(f.fee_quote_amount, 0) else 0 end), 0) as entry_fee,
      coalesce(sum(case when f.side = 'SELL' then f.quantity else 0 end), 0) as sold_qty,
      coalesce(sum(case when f.side = 'SELL' then f.quote_amount else 0 end), 0) as proceeds,
      coalesce(sum(case when f.side = 'SELL' then coalesce(f.fee_quote_amount, 0) else 0 end), 0) as sell_fee
    from public.exchange_trade_fills f
    where f.exchange = 'binance'
    group by f.position_id
  ), expected as (
    select
      p.id,
      ft.entry_qty,
      ft.sold_qty,
      ft.entry_cost * least(ft.sold_qty / nullif(ft.entry_qty, 0), 1) as realized_cost,
      ft.proceeds,
      ft.entry_fee * least(ft.sold_qty / nullif(ft.entry_qty, 0), 1) + ft.sell_fee as fees
    from public.trading_positions p
    join fill_totals ft on ft.position_id = p.id
    where p.exchange = 'binance'
      and p.state = 'CLOSED'
      and coalesce(p.is_paper, false) = false
      and ft.entry_qty > 0
      and ft.sold_qty / ft.entry_qty >= 0.995
  ), candidates as (
    select e.*
    from expected e
    join public.trading_positions p on p.id = e.id
    where abs(coalesce(p.realized_proceeds_quote, 0) - e.proceeds) > 0.00000001
       or abs(coalesce(p.realized_cost_quote, 0) - e.realized_cost) > 0.00000001
       or abs(coalesce(p.paid_fees_quote, 0) - e.fees) > 0.00000001
       or abs(
         coalesce(p.realized_pnl_quote, 0) -
         (e.proceeds - e.realized_cost - e.fees)
       ) > 0.00000001
    order by e.id
    limit v_limit
  )
  update public.trading_positions p
     set realized_proceeds_quote = e.proceeds,
         realized_cost_quote = e.realized_cost,
         paid_fees_quote = e.fees,
         realized_pnl_quote = e.proceeds - e.realized_cost - e.fees,
         realized_return_pct = case
           when e.realized_cost > 0
             then (e.proceeds - e.realized_cost - e.fees) / e.realized_cost * 100
           else 0 end,
         fee_accounting_quality = 'EXACT',
         accounting_version = '7.5.4',
         metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
           'closed_fill_repair', jsonb_build_object(
             'version', '7.5.4-FULL-COST',
             'repaired_at', now(),
             'source', 'COMPLETE_EXCHANGE_TRADE_FILLS',
             'entry_quantity', e.entry_qty,
             'sold_quantity', e.sold_qty,
             'entry_cost_quote', e.realized_cost,
             'proceeds_quote', e.proceeds,
             'fees_quote', e.fees,
             'previous_realized_cost_quote', p.realized_cost_quote,
             'previous_realized_pnl_quote', p.realized_pnl_quote,
             'previous_realized_return_pct', p.realized_return_pct
           )
         ),
         updated_at = now()
    from candidates e
   where p.id = e.id;

  get diagnostics v_updated = row_count;

  perform set_config(
    'trading_boooo.allow_closed_rewrite',
    coalesce(nullif(v_previous_rewrite_setting, ''), 'off'),
    true
  );
  return v_updated;
exception
  when others then
    perform set_config(
      'trading_boooo.allow_closed_rewrite',
      coalesce(nullif(v_previous_rewrite_setting, ''), 'off'),
      true
    );
    raise;
end;
$function$;

revoke all on function public.backfill_closed_binance_position_economics(integer)
  from public, anon, authenticated;
grant execute on function public.backfill_closed_binance_position_economics(integer)
  to service_role;

-- The historical backfill is deliberately run by the following migration in bounded
-- batches. Keeping DDL separate prevents an HTTP deployment timeout from hiding whether
-- the guard functions were committed.
do $verify$
begin
  if position(
    'trading_boooo.allow_closed_rewrite'
    in pg_get_functiondef('public.recompute_closed_position_from_exchange_fills(uuid)'::regprocedure)
  ) = 0 then
    raise exception 'CLOSED_FILL_REPAIR_REWRITE_GUARD_MISSING';
  end if;

  if position(
    'v_net_return_pct <= -3.999'
    in pg_get_functiondef('public.guard_residual_sell_order_v751()'::regprocedure)
  ) = 0 then
    raise exception 'FULL_STOP_LOSS_4_GUARD_MISSING';
  end if;

  if to_regprocedure(
    'public.backfill_closed_binance_position_economics(integer)'
  ) is null then
    raise exception 'CLOSED_BINANCE_BACKFILL_FUNCTION_MISSING';
  end if;
end;
$verify$;
commit;
