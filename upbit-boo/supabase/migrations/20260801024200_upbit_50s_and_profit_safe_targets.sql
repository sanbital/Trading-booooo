begin;

update public.trading_settings
set lob_search_base_observation_ms = 60000,
    lob_search_max_observation_ms = 60000,
    lob_observation_window_ms = 50000,
    lob_min_target_net_profit_bps = 20,
    lob_profit_protect_cost_buffer_bps_upbit = greatest(lob_profit_protect_cost_buffer_bps_upbit, 25),
    lob_profit_protect_cost_buffer_bps_binance = greatest(lob_profit_protect_cost_buffer_bps_binance, 35),
    version = version + 1,
    updated_at = now()
where id = 1;

create or replace function public.enforce_v708_profit_only_exit_policy()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  entry_price numeric;
  minimum_target_multiplier numeric;
  minimum_target numeric;
begin
  if new.state = 'OPEN' then
    entry_price := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
    if entry_price is not null and entry_price > 0 then
      minimum_target_multiplier := case
        when lower(new.exchange) = 'upbit' then 1.0045
        else 1.0080
      end;
      minimum_target := entry_price * minimum_target_multiplier;

      new.stop_price := entry_price * 0.95;
      new.target_1 := greatest(coalesce(nullif(new.target_1, 0), minimum_target), minimum_target);
      new.target_2 := greatest(coalesce(nullif(new.target_2, 0), new.target_1), new.target_1, minimum_target);
      new.max_holding_at := 'infinity'::timestamptz;
      if coalesce(new.trailing_stop, 0) < entry_price then new.trailing_stop := null; end if;

      new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
        'exit_policy_revision', '7.2.2-P95-FILL-SAFE-TARGET',
        'hard_stop_return_pct', -5,
        'minimum_target_multiplier', minimum_target_multiplier,
        'minimum_target_price', minimum_target,
        'target_shortfall_safety_bps', case when lower(new.exchange)='upbit' then 20 else 50 end,
        'model_target_preserved_when_higher', true,
        'timeout_loss_exit_enabled', false,
        'target_requires_order_time_net_profit_guard', true,
        'profit_only_exit_enforced_at', now()
      );
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.guard_target_market_order_fee_net_v722()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_target numeric;
  v_quantity numeric;
  v_fee_rate numeric;
  v_shortfall_bps numeric;
  v_guarded_fill_price numeric;
  v_guarded_net_quote numeric;
  v_held_seconds numeric;
begin
  if upper(coalesce(new.side,'')) <> 'SELL'
     or upper(coalesce(new.order_type,'')) <> 'MARKET'
     or upper(coalesce(new.purpose,'')) not in ('TARGET_1','TARGET_2')
     or new.position_id is null then
    return new;
  end if;

  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.is_paper is distinct from false then return new; end if;

  v_held_seconds := greatest(0, extract(epoch from (now() - coalesce(p.opened_at, now()))));
  if v_held_seconds >= 180 then return new; end if;

  v_entry := coalesce(nullif(p.average_entry_price,0), nullif(p.planned_entry_price,0));
  v_target := case when upper(new.purpose)='TARGET_2' then coalesce(nullif(p.target_2,0),p.target_1) else p.target_1 end;
  v_quantity := least(greatest(coalesce(new.requested_volume,0),0), greatest(coalesce(p.remaining_quantity,0),0));
  if coalesce(v_entry,0)<=0 or coalesce(v_target,0)<=0 or v_quantity<=0 then
    raise exception using errcode='23514', message=format('V722_TARGET_ORDER_MISSING_ECONOMICS market=%s',new.market);
  end if;

  v_fee_rate := case when lower(p.exchange)='upbit' then 0.0005 else 0.001 end;
  v_shortfall_bps := case when lower(p.exchange)='upbit' then 20 else 50 end;
  v_guarded_fill_price := v_target * (1 - v_shortfall_bps/10000);
  v_guarded_net_quote := v_guarded_fill_price*v_quantity*(1-v_fee_rate)
                         - v_entry*v_quantity*(1+v_fee_rate);

  if (lower(p.exchange)='upbit' and v_guarded_net_quote < 1)
     or (lower(p.exchange)<>'upbit' and v_guarded_net_quote <= 0) then
    raise exception using
      errcode='23514',
      message=format('V722_TARGET_ORDER_NOT_FEE_NET_SAFE market=%s guarded_net=%s target=%s shortfall_bps=%s',new.market,round(v_guarded_net_quote,8),v_target,v_shortfall_bps);
  end if;

  return new;
end;
$function$;

drop trigger if exists trading_orders_target_fee_net_guard_v722 on public.trading_orders;
create trigger trading_orders_target_fee_net_guard_v722
before insert on public.trading_orders
for each row execute function public.guard_target_market_order_fee_net_v722();

update public.trading_positions
set target_1 = target_1, target_2 = target_2, updated_at = now()
where is_paper is false and state = 'OPEN';

commit;
