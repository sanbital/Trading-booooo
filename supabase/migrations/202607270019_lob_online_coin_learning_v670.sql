-- Trading-booooo v6.7.0-ONLINE-COIN-LEARNING
--
-- The previous LOB learner was an hourly, pattern-wide batch. It could change three
-- pattern multipliers, but it could not learn that one coin repeatedly needs more room,
-- resolves faster, or is being closed by the same early invalidation rule. This migration
-- adds an idempotent outcome ledger and hierarchical exchange/pattern + coin/pattern
-- profiles. Every live close increments a profile version immediately from the autotrader;
-- the hourly job backfills any update missed during a transient failure.

create table if not exists public.lob_online_outcomes (
  position_id uuid primary key references public.trading_positions(id) on delete cascade,
  exchange text not null check (exchange in ('upbit', 'binance')),
  market text not null,
  pattern text not null check (
    pattern in (
      'OFI_CONTINUATION',
      'ABSORPTION_REVERSAL',
      'SWEEP_RECLAIM',
      'QUEUE_DEPLETION_BREAKOUT',
      'REPLENISHMENT_ICEBERG'
    )
  ),
  exit_reason text not null,
  opened_at timestamptz,
  closed_at timestamptz not null,
  held_seconds numeric not null check (held_seconds >= 0),
  net_bps numeric not null,
  profitable boolean not null,
  target_hit boolean not null,
  mae_bps numeric not null check (mae_bps >= 0),
  mfe_bps numeric not null check (mfe_bps >= 0),
  entry_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists lob_online_outcomes_market_idx
  on public.lob_online_outcomes(exchange, market, pattern, closed_at desc);

create table if not exists public.lob_market_profiles (
  exchange text not null check (exchange in ('upbit', 'binance')),
  -- '*' is the exchange/pattern parent used as the hierarchical prior.
  market text not null,
  pattern text not null check (
    pattern in (
      'OFI_CONTINUATION',
      'ABSORPTION_REVERSAL',
      'SWEEP_RECLAIM',
      'QUEUE_DEPLETION_BREAKOUT',
      'REPLENISHMENT_ICEBERG'
    )
  ),
  version bigint not null default 0,
  samples integer not null default 0 check (samples >= 0),
  profitable_trades integer not null default 0 check (profitable_trades >= 0),
  target_hits integer not null default 0 check (target_hits >= 0),
  early_exit_losses integer not null default 0 check (early_exit_losses >= 0),
  ewma_net_bps numeric not null default 0,
  ewma_hold_seconds numeric not null default 0 check (ewma_hold_seconds >= 0),
  ewma_profitable_hold_seconds numeric not null default 0
    check (ewma_profitable_hold_seconds >= 0),
  ewma_mae_bps numeric not null default 0 check (ewma_mae_bps >= 0),
  ewma_mfe_bps numeric not null default 0 check (ewma_mfe_bps >= 0),
  ewma_profitable_mae_bps numeric not null default 0
    check (ewma_profitable_mae_bps >= 0),
  exit_counts jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (exchange, market, pattern)
);

create index if not exists lob_market_profiles_updated_idx
  on public.lob_market_profiles(updated_at desc);

alter table public.lob_online_outcomes enable row level security;
alter table public.lob_market_profiles enable row level security;

drop policy if exists lob_online_outcomes_service_all on public.lob_online_outcomes;
create policy lob_online_outcomes_service_all
  on public.lob_online_outcomes for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists lob_market_profiles_service_all on public.lob_market_profiles;
create policy lob_market_profiles_service_all
  on public.lob_market_profiles for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.learn_lob_trade_outcome(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position public.trading_positions%rowtype;
  v_pattern text;
  v_exit_reason text;
  v_held_seconds numeric;
  v_net_bps numeric;
  v_mae_bps numeric;
  v_mfe_bps numeric;
  v_profitable boolean;
  v_target_hit boolean;
  v_inserted integer := 0;
  v_scope_market text;
  v_profile jsonb;
begin
  select *
    into v_position
    from public.trading_positions
   where id = p_position_id;

  if not found then
    return jsonb_build_object('updated', false, 'reason', 'POSITION_NOT_FOUND');
  end if;
  if v_position.state <> 'CLOSED' or v_position.is_paper then
    return jsonb_build_object('updated', false, 'reason', 'NOT_CLOSED_LIVE');
  end if;

  v_pattern := v_position.metadata #>> '{lob_signal,pattern}';
  if v_pattern not in (
    'OFI_CONTINUATION',
    'ABSORPTION_REVERSAL',
    'SWEEP_RECLAIM',
    'QUEUE_DEPLETION_BREAKOUT',
    'REPLENISHMENT_ICEBERG'
  ) then
    return jsonb_build_object('updated', false, 'reason', 'NO_LOB_PATTERN');
  end if;

  v_exit_reason := upper(coalesce(
    nullif(v_position.metadata ->> 'pending_exit_reason', ''),
    nullif(v_position.close_reason, ''),
    'UNKNOWN'
  ));
  v_held_seconds := greatest(
    0,
    extract(epoch from (
      coalesce(v_position.closed_at, v_position.updated_at) -
      coalesce(v_position.opened_at, v_position.created_at)
    ))
  );
  v_net_bps := case
    when coalesce(v_position.realized_cost_quote, 0) > 0
      then coalesce(v_position.realized_pnl_quote, 0) /
        v_position.realized_cost_quote * 10000
    else 0
  end;
  v_profitable := v_net_bps > 0;
  v_target_hit := v_exit_reason like '%TARGET%';
  v_mae_bps := case
    when coalesce(v_position.average_entry_price, 0) > 0
      then greatest(
        0,
        (
          v_position.average_entry_price -
          least(
            v_position.average_entry_price,
            coalesce(v_position.trough_price, v_position.average_entry_price)
          )
        ) / v_position.average_entry_price * 10000
      )
    else 0
  end;
  v_mfe_bps := case
    when coalesce(v_position.average_entry_price, 0) > 0
      then greatest(
        0,
        (
          greatest(
            v_position.average_entry_price,
            coalesce(v_position.peak_price, v_position.average_entry_price)
          ) - v_position.average_entry_price
        ) / v_position.average_entry_price * 10000
      )
    else 0
  end;

  insert into public.lob_online_outcomes (
    position_id,
    exchange,
    market,
    pattern,
    exit_reason,
    opened_at,
    closed_at,
    held_seconds,
    net_bps,
    profitable,
    target_hit,
    mae_bps,
    mfe_bps,
    entry_snapshot
  ) values (
    v_position.id,
    v_position.exchange,
    v_position.market,
    v_pattern,
    v_exit_reason,
    v_position.opened_at,
    coalesce(v_position.closed_at, v_position.updated_at),
    v_held_seconds,
    v_net_bps,
    v_profitable,
    v_target_hit,
    v_mae_bps,
    v_mfe_bps,
    coalesce(v_position.metadata -> 'lob_signal', '{}'::jsonb)
  )
  on conflict (position_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select to_jsonb(p)
      into v_profile
      from public.lob_market_profiles p
     where p.exchange = v_position.exchange
       and p.market = v_position.market
       and p.pattern = v_pattern;
    return jsonb_build_object(
      'updated', false,
      'reason', 'ALREADY_LEARNED',
      'profile', v_profile
    );
  end if;

  foreach v_scope_market in array array[v_position.market, '*'] loop
    insert into public.lob_market_profiles as profile (
      exchange,
      market,
      pattern,
      version,
      samples,
      profitable_trades,
      target_hits,
      early_exit_losses,
      ewma_net_bps,
      ewma_hold_seconds,
      ewma_profitable_hold_seconds,
      ewma_mae_bps,
      ewma_mfe_bps,
      ewma_profitable_mae_bps,
      exit_counts,
      updated_at
    ) values (
      v_position.exchange,
      v_scope_market,
      v_pattern,
      1,
      1,
      case when v_profitable then 1 else 0 end,
      case when v_target_hit then 1 else 0 end,
      case when not v_profitable and v_held_seconds < 20 then 1 else 0 end,
      v_net_bps,
      v_held_seconds,
      case when v_profitable then v_held_seconds else 0 end,
      v_mae_bps,
      v_mfe_bps,
      case when v_profitable then v_mae_bps else 0 end,
      jsonb_build_object(v_exit_reason, 1),
      now()
    )
    on conflict (exchange, market, pattern) do update
    set version = profile.version + 1,
        samples = profile.samples + 1,
        profitable_trades = profile.profitable_trades +
          case when v_profitable then 1 else 0 end,
        target_hits = profile.target_hits +
          case when v_target_hit then 1 else 0 end,
        early_exit_losses = profile.early_exit_losses +
          case when not v_profitable and v_held_seconds < 20 then 1 else 0 end,
        ewma_net_bps = profile.ewma_net_bps +
          greatest(0.03, least(0.20, 2.0 / (profile.samples + 2))) *
          (v_net_bps - profile.ewma_net_bps),
        ewma_hold_seconds = profile.ewma_hold_seconds +
          greatest(0.03, least(0.20, 2.0 / (profile.samples + 2))) *
          (v_held_seconds - profile.ewma_hold_seconds),
        ewma_profitable_hold_seconds = case
          when v_profitable and profile.profitable_trades = 0
            then v_held_seconds
          when v_profitable then profile.ewma_profitable_hold_seconds +
            greatest(0.03, least(0.20, 2.0 / (profile.profitable_trades + 2))) *
            (v_held_seconds - profile.ewma_profitable_hold_seconds)
          else profile.ewma_profitable_hold_seconds
        end,
        ewma_mae_bps = profile.ewma_mae_bps +
          greatest(0.03, least(0.20, 2.0 / (profile.samples + 2))) *
          (v_mae_bps - profile.ewma_mae_bps),
        ewma_mfe_bps = profile.ewma_mfe_bps +
          greatest(0.03, least(0.20, 2.0 / (profile.samples + 2))) *
          (v_mfe_bps - profile.ewma_mfe_bps),
        ewma_profitable_mae_bps = case
          when v_profitable and profile.profitable_trades = 0
            then v_mae_bps
          when v_profitable then profile.ewma_profitable_mae_bps +
            greatest(0.03, least(0.20, 2.0 / (profile.profitable_trades + 2))) *
            (v_mae_bps - profile.ewma_profitable_mae_bps)
          else profile.ewma_profitable_mae_bps
        end,
        exit_counts = jsonb_set(
          coalesce(profile.exit_counts, '{}'::jsonb),
          array[v_exit_reason],
          to_jsonb(
            coalesce((profile.exit_counts ->> v_exit_reason)::integer, 0) + 1
          ),
          true
        ),
        updated_at = now();
  end loop;

  select to_jsonb(p)
    into v_profile
    from public.lob_market_profiles p
   where p.exchange = v_position.exchange
     and p.market = v_position.market
     and p.pattern = v_pattern;

  return jsonb_build_object(
    'updated', true,
    'position_id', v_position.id,
    'profile', v_profile
  );
end;
$$;

create or replace function public.backfill_lob_online_learning(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select p.id
      from public.trading_positions p
      left join public.lob_online_outcomes o on o.position_id = p.id
     where p.state = 'CLOSED'
       and not p.is_paper
       and p.metadata ? 'lob_signal'
       and o.position_id is null
     order by p.closed_at asc
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    perform public.learn_lob_trade_outcome(v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.get_lob_online_learning_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with global_profiles as (
    select *
      from public.lob_market_profiles
     where market = '*'
  ),
  totals as (
    select
      coalesce(sum(version), 0) as profile_version,
      coalesce(sum(samples), 0) as samples,
      coalesce(sum(profitable_trades), 0) as profitable_trades,
      coalesce(sum(target_hits), 0) as target_hits,
      case when coalesce(sum(samples), 0) > 0
        then sum(ewma_net_bps * samples) / sum(samples)
      end as mean_net_bps,
      case when coalesce(sum(samples), 0) > 0
        then sum(ewma_hold_seconds * samples) / sum(samples)
      end as mean_hold_seconds,
      max(updated_at) as last_updated_at
    from global_profiles
  )
  select jsonb_build_object(
    'mode', 'ONLINE_ON_EVERY_LIVE_CLOSE',
    'profile_version', totals.profile_version,
    'samples', totals.samples,
    'profitable_trades', totals.profitable_trades,
    'profitable_rate', case when totals.samples > 0
      then totals.profitable_trades::numeric / totals.samples
    end,
    'target_hits', totals.target_hits,
    'mean_net_bps', totals.mean_net_bps,
    'mean_hold_seconds', totals.mean_hold_seconds,
    'profiled_markets', (
      select count(distinct exchange || ':' || market)
        from public.lob_market_profiles
       where market <> '*'
    ),
    'last_updated_at', totals.last_updated_at
  )
  from totals;
$$;

revoke all on function public.learn_lob_trade_outcome(uuid) from public;
revoke all on function public.backfill_lob_online_learning(integer) from public;
revoke all on function public.get_lob_online_learning_status() from public;
grant execute on function public.learn_lob_trade_outcome(uuid) to service_role;
grant execute on function public.backfill_lob_online_learning(integer) to service_role;
grant execute on function public.get_lob_online_learning_status() to service_role;

-- Seed the hierarchy from all existing closed live LOB positions. Idempotency is provided
-- by lob_online_outcomes.position_id, so a repeated migration application cannot double
-- count a trade.
select public.backfill_lob_online_learning(5000);

-- v6.6 raised the operator's six-slot allocation to twelve without an explicit control
-- change. That halved order notionals because the same managed capital was divided twice
-- as many ways. Restore the original allocation and keep candidate breadth independent
-- from capital slicing.
alter table public.trading_settings
  alter column scalp_position_slots set default 6;

update public.trading_settings
set scalp_position_slots = 6,
    version = coalesce(version, 0) + 1,
    updated_at = now()
where id = 1
  and strategy = 'LOB_SCALP';
