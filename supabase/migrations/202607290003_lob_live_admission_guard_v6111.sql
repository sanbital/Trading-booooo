-- v6.11.1: fee-net live admission guard.
--
-- The engine keeps scanning and recording every decision, but weak/insufficient LOB
-- candidates are shadow-only: the database refuses the ENTRY_PENDING reservation before
-- any exchange order can be submitted. The operator-approved KST daily -30% circuit
-- remains unchanged and is still the only global kill switch.

alter table public.trading_settings
  add column if not exists lob_live_shadow_low_evidence boolean not null default true,
  add column if not exists lob_live_min_pattern_samples integer not null default 20,
  add column if not exists lob_live_min_market_samples integer not null default 2,
  add column if not exists lob_symbol_loss_streak integer not null default 2,
  add column if not exists lob_symbol_loss_cooldown_minutes integer not null default 120,
  add column if not exists lob_chase_change_rate_pct numeric not null default 5,
  add column if not exists lob_chase_min_spread_bps numeric not null default 15,
  add column if not exists lob_live_admission_revision text not null default '6.11.1-DB-GUARD';

update public.trading_settings
   set lob_live_shadow_low_evidence = true,
       lob_live_min_pattern_samples = greatest(coalesce(lob_live_min_pattern_samples, 20), 20),
       lob_live_min_market_samples = greatest(coalesce(lob_live_min_market_samples, 2), 2),
       lob_symbol_loss_streak = greatest(coalesce(lob_symbol_loss_streak, 2), 2),
       lob_symbol_loss_cooldown_minutes = greatest(coalesce(lob_symbol_loss_cooldown_minutes, 120), 120),
       lob_chase_change_rate_pct = 5,
       lob_chase_min_spread_bps = 15,
       lob_max_spread_bps = least(coalesce(lob_max_spread_bps, 25), 25),
       lob_min_net_reward_risk_ratio = greatest(coalesce(lob_min_net_reward_risk_ratio, 1), 1),
       lob_max_stop_to_target_ratio = least(coalesce(lob_max_stop_to_target_ratio, 1), 1),
       lob_min_net_ev_bps = greatest(coalesce(lob_min_net_ev_bps, 3), 3),
       lob_min_verified_ev_cushion_bps = greatest(coalesce(lob_min_verified_ev_cushion_bps, 3), 3),
       scalp_low_evidence_daily_loss_pct = 0,
       lob_live_admission_revision = '6.11.1-DB-GUARD',
       version = version + 1,
       updated_at = now()
 where id = 1;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_live_guard_v6111;
alter table public.trading_settings
  add constraint trading_settings_lob_live_guard_v6111 check (
    lob_live_min_pattern_samples >= 1
    and lob_live_min_market_samples >= 1
    and lob_symbol_loss_streak >= 2
    and lob_symbol_loss_cooldown_minutes >= 0
    and lob_chase_change_rate_pct >= 0
    and lob_chase_min_spread_bps >= 0
    and lob_min_net_reward_risk_ratio >= 1
    and lob_max_stop_to_target_ratio <= 1
    and lob_max_spread_bps <= 25
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_live_guard_v6111;

create or replace function public.enforce_lob_live_entry_v6111()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg record;
  signal jsonb;
  block_reasons text[] := array[]::text[];
  dynamic_status text;
  live_spread_bps numeric := 0;
  net_reward_risk numeric := 0;
  pattern_samples integer := 0;
  pattern_mean_net_bps numeric := 0;
  coin_source text;
  coin_market_samples integer := 0;
  coin_pattern_samples integer := 0;
  coin_mean_net_bps numeric := 0;
  day_change_rate numeric := 0;
  recent_count integer := 0;
  recent_all_losses boolean := false;
  recent_last_closed_at timestamptz;
begin
  if new.is_paper is distinct from false or new.state <> 'ENTRY_PENDING' then
    return new;
  end if;

  signal := coalesce(new.metadata -> 'lob_signal', new.metadata -> 'scalp_signal', '{}'::jsonb);
  if upper(coalesce(signal ->> 'strategy', '')) <> 'LOB_SCALP' then
    return new;
  end if;

  select
    lob_live_shadow_low_evidence,
    lob_live_min_pattern_samples,
    lob_live_min_market_samples,
    lob_symbol_loss_streak,
    lob_symbol_loss_cooldown_minutes,
    lob_chase_change_rate_pct,
    lob_chase_min_spread_bps,
    lob_max_spread_bps
  into cfg
  from public.trading_settings
  where id = 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'LOB_SHADOW_ONLY: trading_settings row id=1 unavailable';
  end if;

  dynamic_status := upper(coalesce(signal #>> '{features,dynamicStatus}', 'INSUFFICIENT'));
  live_spread_bps := coalesce(nullif(new.metadata ->> 'live_spread_bps', '')::numeric, 0);
  net_reward_risk := coalesce(nullif(signal ->> 'net_reward_risk_ratio', '')::numeric, 0);
  pattern_samples := coalesce(nullif(signal #>> '{pattern_learning,samples}', '')::integer, 0);
  pattern_mean_net_bps := coalesce(
    nullif(signal #>> '{pattern_learning,mean_net_bps}', '')::numeric,
    0
  );
  coin_source := upper(coalesce(signal #>> '{coin_learning,source}', ''));
  coin_market_samples := coalesce(
    nullif(signal #>> '{coin_learning,market_samples}', '')::integer,
    0
  );
  coin_pattern_samples := coalesce(
    nullif(signal #>> '{coin_learning,pattern_samples}', '')::integer,
    0
  );
  coin_mean_net_bps := coalesce(
    nullif(signal #>> '{coin_learning,mean_net_bps}', '')::numeric,
    0
  );
  day_change_rate := coalesce(
    nullif(new.metadata #>> '{quote_at_entry,raw,ticker,change_rate}', '')::numeric,
    nullif(new.metadata #>> '{quote_at_entry,raw,ticker,signed_change_rate}', '')::numeric,
    0
  );

  if cfg.lob_live_shadow_low_evidence and (
    coalesce((new.metadata ->> 'low_evidence')::boolean, false)
    or coalesce((new.metadata ->> 'is_exploration')::boolean, false)
    or dynamic_status = 'INSUFFICIENT'
  ) then
    block_reasons := array_append(block_reasons, 'LOW_EVIDENCE');
  end if;

  if jsonb_typeof(signal -> 'warnings') = 'array'
     and (signal -> 'warnings') ? 'NET_PAYOFF_TOO_WEAK'
  then
    block_reasons := array_append(block_reasons, 'NET_PAYOFF_TOO_WEAK');
  end if;

  if net_reward_risk < 1 then
    block_reasons := array_append(block_reasons, 'NET_RR_BELOW_1');
  end if;

  if live_spread_bps > cfg.lob_max_spread_bps then
    block_reasons := array_append(block_reasons, 'SPREAD_TOO_WIDE');
  end if;

  if day_change_rate * 100 >= cfg.lob_chase_change_rate_pct
     and live_spread_bps >= cfg.lob_chase_min_spread_bps
  then
    block_reasons := array_append(block_reasons, 'WIDE_SPREAD_CHASE');
  end if;

  if pattern_samples >= cfg.lob_live_min_pattern_samples
     and pattern_mean_net_bps <= 0
  then
    block_reasons := array_append(block_reasons, 'NEGATIVE_PATTERN_EDGE');
  end if;

  if coin_source = 'MARKET'
     and coin_market_samples >= cfg.lob_live_min_market_samples
     and coin_mean_net_bps <= 0
  then
    block_reasons := array_append(block_reasons, 'NEGATIVE_MARKET_EDGE');
  elsif coin_source = 'PATTERN'
     and coin_pattern_samples >= cfg.lob_live_min_pattern_samples
     and coin_mean_net_bps <= 0
  then
    block_reasons := array_append(block_reasons, 'NEGATIVE_COIN_PATTERN_EDGE');
  end if;

  if cfg.lob_symbol_loss_cooldown_minutes > 0 then
    select count(*), coalesce(bool_and(x.realized_pnl_quote <= 0), false), max(x.closed_at)
      into recent_count, recent_all_losses, recent_last_closed_at
      from (
        select coalesce(realized_pnl_quote, 0) as realized_pnl_quote, closed_at
          from public.trading_positions
         where exchange = new.exchange
           and market = new.market
           and is_paper = false
           and state = 'CLOSED'
           and closed_at is not null
         order by closed_at desc
         limit cfg.lob_symbol_loss_streak
      ) x;

    if recent_count >= cfg.lob_symbol_loss_streak
       and recent_all_losses
       and recent_last_closed_at >= now() - make_interval(mins => cfg.lob_symbol_loss_cooldown_minutes)
    then
      block_reasons := array_append(block_reasons, 'SYMBOL_LOSS_COOLDOWN');
    end if;
  end if;

  if cardinality(block_reasons) > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'LOB_SHADOW_ONLY[%s:%s]: %s',
        new.exchange,
        new.market,
        array_to_string(block_reasons, ',')
      );
  end if;

  return new;
end;
$$;

drop trigger if exists trading_positions_lob_live_guard_v6111
  on public.trading_positions;
create trigger trading_positions_lob_live_guard_v6111
before insert on public.trading_positions
for each row
execute function public.enforce_lob_live_entry_v6111();

revoke all on function public.enforce_lob_live_entry_v6111()
  from public, anon, authenticated;

comment on function public.enforce_lob_live_entry_v6111() is
  'Blocks weak LOB live reservations before any exchange order; decisions remain available in the shadow/decision ledger.';
comment on column public.trading_settings.lob_live_admission_revision is
  'Database admission guard revision. Engine scanning remains active; only qualifying live reservations pass.';
