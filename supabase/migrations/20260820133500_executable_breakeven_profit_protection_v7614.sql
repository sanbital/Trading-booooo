-- v7.6.14: replace the fixed gross breakeven arm with an economic, fill-aware arm.
--
-- Scope is deliberately narrow:
--   * Binance spot and Binance Futures
--   * real OPEN LOB_SCALP positions
--   * pre-T1 only
--
-- The floor is derived from the position's actual applied BUY principal and fee,
-- the current remaining quantity, an exit-fee estimate derived from the observed
-- entry fee plus 1bp safety, and the quantity-aware executable bid persisted by
-- the monitor in metadata.live_mark.executable_price. Later profit-lock/trailing
-- stages are preserved unchanged. Existing sell reasons and DB exit guards are
-- reused; this migration introduces no new liquidation authority.

create or replace function public.protect_lob_open_profit_v6130()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  v_entry numeric;
  v_peak numeric;
  v_mfe_bps numeric;
  v_tick numeric;
  v_cost_buffer numeric;
  v_observed_entry_fee_bps numeric := 0;
  v_candidate_stop numeric;
  v_existing_trail numeric;
  v_stage text := 'NONE';
  v_held_seconds numeric := 0;
  v_original_stop numeric;
  v_is_momentum boolean := false;
  v_cost_recovery_trigger numeric;
  v_profit_lock_trigger numeric;
  v_trail_trigger numeric;
  v_lock_net_bps numeric;
  v_trail_distance_bps numeric;
  v_buy_principal numeric := 0;
  v_exact_buy_fee numeric := 0;
  v_buy_quantity numeric := 0;
  v_exit_fee_rate numeric := 0;
  v_unrecovered_cost numeric := 0;
  v_current_exec numeric := 0;
  v_current_exact_net numeric := 0;
  v_dynamic_be_price numeric := 0;
  v_dynamic_locked_net_bps numeric := 0;
  v_dynamic_armed boolean := false;
  v_locked_net_bps_estimate numeric := 0;
begin
  if new.is_paper is distinct from false or new.state <> 'OPEN' then
    return new;
  end if;

  signal := coalesce(new.metadata->'lob_signal', new.metadata->'scalp_signal', '{}'::jsonb);
  if upper(coalesce(signal->>'strategy', '')) <> 'LOB_SCALP' then
    return new;
  end if;

  select * into cfg from public.trading_settings where id = 1;
  if not found or not cfg.lob_profit_protect_enabled then
    return new;
  end if;

  v_is_momentum := upper(coalesce(signal->>'pattern', '')) = 'MOMENTUM_CONTINUATION';
  v_entry := coalesce(new.average_entry_price, old.average_entry_price, 0);
  v_peak := greatest(coalesce(new.peak_price, 0), coalesce(old.peak_price, 0), v_entry);
  if v_entry <= 0 or v_peak <= v_entry then
    return new;
  end if;

  if new.opened_at is not null then
    v_held_seconds := greatest(0, extract(epoch from (now() - new.opened_at)));
  end if;
  if v_held_seconds < cfg.lob_profit_protect_min_hold_seconds then
    return new;
  end if;

  v_mfe_bps := (v_peak / v_entry - 1) * 10000;
  v_tick := greatest(coalesce(new.tick_size, 0), 0);

  -- Read exact applied BUY economics from the durable order ledger. The index on
  -- trading_orders(position_id, created_at) keeps this lookup position-scoped.
  if lower(new.exchange) in ('binance', 'binance_futures') then
    select
      coalesce(sum(coalesce(o.executed_funds_quote, 0)), 0),
      coalesce(sum(coalesce(o.paid_fee_quote, 0)), 0),
      coalesce(sum(coalesce(o.executed_volume, 0)), 0)
    into v_buy_principal, v_exact_buy_fee, v_buy_quantity
    from public.trading_orders o
    where o.position_id = new.id
      and upper(coalesce(o.side, '')) = 'BUY'
      and o.state in ('APPLIED', 'EXCHANGE_DONE', 'EXCHANGE_PARTIAL_CANCELLED')
      and coalesce(o.executed_volume, 0) > 0;
  end if;

  if v_buy_principal <= 0 then
    v_buy_principal := greatest(
      coalesce(new.realized_cost_quote, 0),
      coalesce(new.initial_quantity, 0) * v_entry
    );
  end if;
  if v_buy_quantity <= 0 then
    v_buy_quantity := greatest(
      coalesce(new.initial_quantity, 0),
      coalesce(new.remaining_quantity, 0)
    );
  end if;

  if v_buy_principal > 0 and v_exact_buy_fee > 0 then
    v_observed_entry_fee_bps := v_exact_buy_fee / v_buy_principal * 10000;
  elsif coalesce(new.realized_cost_quote, 0) > 0 and coalesce(new.paid_fees_quote, 0) > 0 then
    v_observed_entry_fee_bps := new.paid_fees_quote / new.realized_cost_quote * 10000;
  end if;

  -- Legacy later-stage thresholds remain intact. The new economic arm can engage
  -- before them; once the old stages become eligible they may only ratchet the stop up.
  v_cost_buffer := greatest(
    case
      when lower(new.exchange) = 'upbit' then cfg.lob_profit_protect_cost_buffer_bps_upbit
      else cfg.lob_profit_protect_cost_buffer_bps_binance
    end,
    v_observed_entry_fee_bps * 2 + 2
  );
  v_lock_net_bps := case
    when v_is_momentum then cfg.lob_momentum_profit_lock_net_bps
    else cfg.lob_profit_lock_net_bps
  end;
  v_trail_distance_bps := case
    when v_is_momentum then cfg.lob_momentum_profit_trail_distance_bps
    else cfg.lob_profit_trail_distance_bps
  end;
  v_cost_recovery_trigger := greatest(
    cfg.lob_profit_protect_breakeven_trigger_bps,
    v_cost_buffer + case
      when v_is_momentum then cfg.lob_momentum_cost_recovery_margin_bps
      else 2
    end
  );
  v_profit_lock_trigger := greatest(
    cfg.lob_profit_lock_trigger_bps,
    v_cost_buffer + v_lock_net_bps + 2
  );
  v_trail_trigger := greatest(
    cfg.lob_profit_trail_trigger_bps,
    v_cost_buffer + case
      when v_is_momentum then cfg.lob_momentum_trail_net_trigger_bps
      else 20
    end
  );

  v_original_stop := coalesce(
    public.safe_numeric_v6112(old.metadata#>>'{profit_protection,original_stop_price}'),
    old.stop_price,
    new.stop_price
  );
  v_existing_trail := greatest(
    coalesce(old.trailing_stop, 0),
    coalesce(new.trailing_stop, 0),
    coalesce(v_original_stop, 0),
    coalesce(old.stop_price, 0),
    coalesce(new.stop_price, 0)
  );
  v_candidate_stop := v_existing_trail;

  -- Dynamic economic breakeven arm.
  --
  -- Current executable price is quantity-aware bid VWAP already written by the
  -- monitor in the same UPDATE that invokes this trigger. The arm is therefore
  -- based on what the full remaining position can actually sell for now, not on
  -- the candle high or an optimistic top-of-book price.
  --
  -- The exit-fee estimate uses the observed entry fee rate + 1bp. Production
  -- Binance BUY/SELL fee rates have been symmetric, while the extra bp prevents
  -- exact-zero accounting from being mistaken for a positive-net floor.
  if lower(new.exchange) in ('binance', 'binance_futures')
     and coalesce(new.t1_completed, false) = false
     and v_buy_principal > 0
     and v_exact_buy_fee > 0
     and coalesce(new.remaining_quantity, 0) > 0 then
    v_exit_fee_rate := least(
      0.01,
      greatest(0, v_exact_buy_fee / v_buy_principal) + 0.0001
    );
    v_unrecovered_cost := greatest(
      0,
      v_buy_principal + v_exact_buy_fee - coalesce(new.realized_proceeds_quote, 0)
    );
    v_current_exec := greatest(
      public.safe_numeric_v6112(new.metadata#>>'{live_mark,executable_price}'),
      0
    );

    if v_current_exec > 0 and v_exit_fee_rate < 1 then
      v_dynamic_be_price := v_unrecovered_cost /
        (coalesce(new.remaining_quantity, 0) * (1 - v_exit_fee_rate));

      -- Round to an actually orderable, strictly-positive-net price. One extra tick
      -- is intentional: the downstream sanitizer requires a positive, not zero, net.
      if v_tick > 0 then
        v_dynamic_be_price := ceil(v_dynamic_be_price / v_tick) * v_tick + v_tick;
      else
        v_dynamic_be_price := v_dynamic_be_price * 1.000001;
      end if;

      v_current_exact_net :=
        v_current_exec * coalesce(new.remaining_quantity, 0) * (1 - v_exit_fee_rate) -
        v_unrecovered_cost;
      v_dynamic_locked_net_bps := case
        when v_unrecovered_cost > 0 then
          (
            v_dynamic_be_price * coalesce(new.remaining_quantity, 0) * (1 - v_exit_fee_rate) -
            v_unrecovered_cost
          ) / v_unrecovered_cost * 10000
        else 0
      end;

      if v_current_exact_net > 0
         and v_current_exec > v_dynamic_be_price
         and v_dynamic_locked_net_bps > 0 then
        v_dynamic_armed := true;
        v_stage := 'EXECUTABLE_BREAKEVEN';
        v_candidate_stop := greatest(v_candidate_stop, v_dynamic_be_price);
      end if;
    end if;
  end if;

  if v_mfe_bps >= v_cost_recovery_trigger then
    v_stage := 'COST_RECOVERY';
    v_candidate_stop := greatest(
      v_candidate_stop,
      v_entry * (1 + v_cost_buffer / 10000)
    );
  end if;
  if v_mfe_bps >= v_profit_lock_trigger then
    v_stage := 'NET_PROFIT_LOCK';
    v_candidate_stop := greatest(
      v_candidate_stop,
      v_entry * (1 + (v_cost_buffer + v_lock_net_bps) / 10000)
    );
  end if;
  if v_mfe_bps >= v_trail_trigger then
    v_stage := case
      when v_is_momentum then 'MOMENTUM_PEAK_TRAIL'
      else 'PEAK_TRAIL'
    end;
    v_candidate_stop := greatest(
      v_candidate_stop,
      v_peak * (1 - v_trail_distance_bps / 10000)
    );
  end if;

  if v_tick > 0 then
    v_candidate_stop := floor(v_candidate_stop / v_tick) * v_tick;
    v_candidate_stop := least(v_candidate_stop, v_peak - v_tick);
  else
    v_candidate_stop := least(v_candidate_stop, v_peak * (1 - 0.000001));
  end if;
  v_candidate_stop := greatest(v_candidate_stop, v_existing_trail);

  -- The downstream v7.6.8 sanitizer rejects any newly armed protection whose
  -- locked_net_bps_estimate is non-positive. For the dynamic lane use the exact
  -- economic net at the final candidate stop; legacy lanes retain their estimate.
  v_locked_net_bps_estimate := case
    when v_dynamic_armed and v_unrecovered_cost > 0 and v_exit_fee_rate < 1 then
      (
        v_candidate_stop * coalesce(new.remaining_quantity, 0) * (1 - v_exit_fee_rate) -
        v_unrecovered_cost
      ) / v_unrecovered_cost * 10000
    else
      (v_candidate_stop / v_entry - 1) * 10000 - v_cost_buffer
  end;

  if v_candidate_stop > coalesce(new.trailing_stop, 0) then
    new.trailing_stop := v_candidate_stop;
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'profit_protection',
      jsonb_build_object(
        'revision', '7.6.14-EXECUTABLE-BREAKEVEN',
        'stage', v_stage,
        'momentum_lane', v_is_momentum,
        'original_stop_price', v_original_stop,
        'protected_stop_price', v_candidate_stop,
        'protection_column', 'trailing_stop',
        'peak_price', v_peak,
        'mfe_bps', round(v_mfe_bps, 4),
        'estimated_cost_buffer_bps', round(v_cost_buffer, 4),
        'cost_recovery_trigger_bps', round(v_cost_recovery_trigger, 4),
        'profit_lock_trigger_bps', round(v_profit_lock_trigger, 4),
        'trail_trigger_bps', round(v_trail_trigger, 4),
        'trail_distance_bps', round(v_trail_distance_bps, 4),
        'dynamic_breakeven_armed', v_dynamic_armed,
        'dynamic_breakeven_price', case
          when v_dynamic_be_price > 0 then v_dynamic_be_price
          else null
        end,
        'current_executable_price', case
          when v_current_exec > 0 then v_current_exec
          else null
        end,
        'current_executable_net_profit_quote', case
          when v_current_exec > 0 then v_current_exact_net
          else null
        end,
        'exact_buy_principal_quote', case
          when v_buy_principal > 0 then v_buy_principal
          else null
        end,
        'exact_buy_fee_quote', case
          when v_exact_buy_fee > 0 then v_exact_buy_fee
          else null
        end,
        'observed_buy_fee_bps', round(v_observed_entry_fee_bps, 4),
        'dynamic_exit_fee_bps', case
          when v_exit_fee_rate > 0 then round(v_exit_fee_rate * 10000, 4)
          else null
        end,
        'exact_unrecovered_cost_quote', case
          when v_unrecovered_cost > 0 then v_unrecovered_cost
          else null
        end,
        'dynamic_floor_net_bps', case
          when v_dynamic_armed then round(v_dynamic_locked_net_bps, 4)
          else null
        end,
        'locked_gross_bps', round((v_candidate_stop / v_entry - 1) * 10000, 4),
        'locked_net_bps_estimate', round(v_locked_net_bps_estimate, 4),
        'updated_at', now()
      )
    );
  end if;
  return new;
end;
$function$;

-- Deployment invariants. Fail closed if the function body was not installed as intended
-- or if the existing pre-T1 positive-net sanitizer is no longer attached after it.
do $$
declare
  v_def text;
  v_sanitizer text;
  v_profit_trigger_name text;
  v_sanitize_trigger_name text;
begin
  select pg_get_functiondef('public.protect_lob_open_profit_v6130()'::regprocedure)
    into v_def;
  select pg_get_functiondef('public.sanitize_pre_t1_profit_protection_v768()'::regprocedure)
    into v_sanitizer;

  if position('7.6.14-EXECUTABLE-BREAKEVEN' in v_def) = 0
     or position('v_current_exact_net > 0' in v_def) = 0
     or position('v_dynamic_locked_net_bps > 0' in v_def) = 0
     or position('v_exact_buy_fee / v_buy_principal' in v_def) = 0
     or position('EXECUTABLE_BREAKEVEN' in v_def) = 0 then
    raise exception 'v7.6.14 executable breakeven function invariant failed';
  end if;

  if position('RETROACTIVE_PROFIT_PROTECTION_BLOCKED' in v_sanitizer) = 0
     or position('v_locked_net_bps' in v_sanitizer) = 0 then
    raise exception 'v7.6.8 pre-T1 positive-net sanitizer invariant failed';
  end if;

  select tgname into v_profit_trigger_name
  from pg_trigger
  where tgrelid = 'public.trading_positions'::regclass
    and not tgisinternal
    and pg_get_triggerdef(oid) like '%protect_lob_open_profit_v6130%'
  limit 1;

  select tgname into v_sanitize_trigger_name
  from pg_trigger
  where tgrelid = 'public.trading_positions'::regclass
    and not tgisinternal
    and pg_get_triggerdef(oid) like '%sanitize_pre_t1_profit_protection_v768%'
  limit 1;

  if v_profit_trigger_name is null or v_sanitize_trigger_name is null
     or v_profit_trigger_name >= v_sanitize_trigger_name then
    raise exception 'profit-protection trigger ordering invariant failed: % / %',
      v_profit_trigger_name, v_sanitize_trigger_name;
  end if;
end
$$;
