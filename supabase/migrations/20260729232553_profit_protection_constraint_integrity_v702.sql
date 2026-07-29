-- Trading-booooo v7.0.2-PROFIT-PROTECTION-CONSTRAINT-INTEGRITY
--
-- The legacy profit-protection trigger raised stop_price above average_entry_price.
-- trading_positions_check1 intentionally forbids that: stop_price is the immutable
-- downside stop, while trailing_stop is the post-entry profit-protection channel.
-- Once a runner had enough MFE, every later position update therefore failed with
-- SQLSTATE 23514 and the exit monitor could no longer advance.
--
-- Keep the fee-aware milestone calculation, but write the protected price only to
-- trailing_stop. The temporary-table regression at the bottom carries the production
-- check constraint so this migration fails atomically if the conflict is reintroduced.

create or replace function public.protect_lob_open_profit_v6130()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
  if coalesce(new.realized_cost_quote, 0) > 0 and coalesce(new.paid_fees_quote, 0) > 0 then
    v_observed_entry_fee_bps := new.paid_fees_quote / new.realized_cost_quote * 10000;
  end if;
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

  if v_mfe_bps >= v_cost_recovery_trigger then
    v_stage := 'COST_RECOVERY';
    v_candidate_stop := greatest(v_candidate_stop, v_entry * (1 + v_cost_buffer / 10000));
  end if;
  if v_mfe_bps >= v_profit_lock_trigger then
    v_stage := 'NET_PROFIT_LOCK';
    v_candidate_stop := greatest(
      v_candidate_stop,
      v_entry * (1 + (v_cost_buffer + v_lock_net_bps) / 10000)
    );
  end if;
  if v_mfe_bps >= v_trail_trigger then
    v_stage := case when v_is_momentum then 'MOMENTUM_PEAK_TRAIL' else 'PEAK_TRAIL' end;
    v_candidate_stop := greatest(
      v_candidate_stop,
      v_peak * (1 - v_trail_distance_bps / 10000)
    );
  end if;

  v_tick := greatest(coalesce(new.tick_size, 0), 0);
  if v_tick > 0 then
    v_candidate_stop := floor(v_candidate_stop / v_tick) * v_tick;
    v_candidate_stop := least(v_candidate_stop, v_peak - v_tick);
  else
    v_candidate_stop := least(v_candidate_stop, v_peak * (1 - 0.000001));
  end if;
  v_candidate_stop := greatest(v_candidate_stop, v_existing_trail);

  if v_candidate_stop > coalesce(new.trailing_stop, 0) then
    -- Do not mutate stop_price: trading_positions_check1 requires it to remain below
    -- entry. decideExit() already uses max(stop_price, trailing_stop) after T1.
    new.trailing_stop := v_candidate_stop;
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'profit_protection',
      jsonb_build_object(
        'revision', '7.0.2-PROFIT-PROTECTION-CONSTRAINT-INTEGRITY',
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
        'locked_gross_bps', round((v_candidate_stop / v_entry - 1) * 10000, 4),
        'locked_net_bps_estimate',
          round((v_candidate_stop / v_entry - 1) * 10000 - v_cost_buffer, 4),
        'updated_at', now()
      )
    );
  end if;
  return new;
end;
$$;

revoke all on function public.protect_lob_open_profit_v6130()
  from public, anon, authenticated;

create temp table v702_profit_constraint_test (
  is_paper boolean,
  state text,
  metadata jsonb,
  exchange text,
  average_entry_price numeric,
  peak_price numeric,
  stop_price numeric,
  trailing_stop numeric,
  tick_size numeric,
  opened_at timestamptz,
  realized_cost_quote numeric,
  paid_fees_quote numeric,
  constraint v702_static_stop_below_entry check (stop_price < average_entry_price)
);

create trigger v702_profit_constraint_test_trigger
before update of peak_price, paid_fees_quote, realized_cost_quote
on v702_profit_constraint_test
for each row execute function public.protect_lob_open_profit_v6130();

insert into v702_profit_constraint_test values (
  false,
  'OPEN',
  jsonb_build_object(
    'lob_signal',
    jsonb_build_object('strategy', 'LOB_SCALP', 'pattern', 'MOMENTUM_CONTINUATION')
  ),
  'binance',
  1000,
  1000,
  990,
  null,
  0.1,
  now() - interval '20 seconds',
  100,
  0.1
);

update v702_profit_constraint_test set peak_price = 1004.5;

do $$
declare
  r v702_profit_constraint_test%rowtype;
begin
  select * into r from v702_profit_constraint_test limit 1;
  if r.stop_price <> 990 then
    raise exception 'V702_STATIC_STOP_WAS_MUTATED';
  end if;
  if coalesce(r.trailing_stop, 0) <= r.average_entry_price then
    raise exception 'V702_PROFIT_TRAIL_WAS_NOT_RAISED';
  end if;
  if r.metadata#>>'{profit_protection,protection_column}' <> 'trailing_stop' then
    raise exception 'V702_PROTECTION_COLUMN_AUDIT_MISSING';
  end if;
end;
$$;
