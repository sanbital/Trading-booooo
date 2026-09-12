-- v6.11.2: adaptive opportunity admission.
--
-- Goal:
--   * preserve the operator's KST daily -30% loss circuit as the sole global stop;
--   * hard-block only execution-invalid or statistically mature adverse setups;
--   * route missing/immature learning into a tightly budgeted opportunity lane instead of
--     turning a learner/schema fault into a system-wide no-trade condition;
--   * keep every decision auditable on the position metadata.
--
-- The v6.11.1 guard was intentionally conservative, but it treated missing learning fields
-- as negative evidence and could reject every candidate. This revision separates structural
-- market risk from learning uncertainty and uses an opportunity score plus a fresh, bounded
-- exploration budget.

alter table public.trading_settings
  add column if not exists lob_core_min_opportunity_score numeric not null default 0.30,
  add column if not exists lob_exploration_min_opportunity_score numeric not null default 0.45,
  add column if not exists lob_exploration_min_net_rr numeric not null default 1.15,
  add column if not exists lob_exploration_max_spread_bps numeric not null default 18,
  add column if not exists lob_controlled_exploration_daily_loss_pct numeric not null default 0.30,
  add column if not exists lob_controlled_exploration_max_concurrent integer not null default 1,
  add column if not exists lob_controlled_exploration_max_entries_per_day integer not null default 8,
  add column if not exists lob_controlled_exploration_fallback_budget_krw numeric not null default 400,
  add column if not exists lob_controlled_exploration_fallback_budget_usdt numeric not null default 0.75;

alter table public.trading_settings
  alter column lob_live_admission_revision set default '6.11.2-ADAPTIVE-OPPORTUNITY';

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_live_guard_v6111;

update public.trading_settings
   set lob_live_shadow_low_evidence = false,
       lob_live_min_pattern_samples = 40,
       lob_live_min_market_samples = 8,
       lob_symbol_loss_streak = 3,
       lob_symbol_loss_cooldown_minutes = 60,
       lob_max_spread_bps = 35,
       lob_min_net_reward_risk_ratio = 1,
       lob_max_stop_to_target_ratio = 1.10,
       lob_min_net_ev_bps = 0.50,
       lob_min_verified_ev_cushion_bps = 0.50,
       scalp_low_evidence_daily_loss_pct = 0.30,
       lob_core_min_opportunity_score = 0.30,
       lob_exploration_min_opportunity_score = 0.45,
       lob_exploration_min_net_rr = 1.15,
       lob_exploration_max_spread_bps = 18,
       lob_controlled_exploration_daily_loss_pct = 0.30,
       lob_controlled_exploration_max_concurrent = 1,
       lob_controlled_exploration_max_entries_per_day = 8,
       lob_controlled_exploration_fallback_budget_krw = 400,
       lob_controlled_exploration_fallback_budget_usdt = 0.75,
       lob_live_admission_revision = '6.11.2-ADAPTIVE-OPPORTUNITY',
       version = version + 1,
       updated_at = now()
 where id = 1;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_adaptive_opportunity_v6112;
alter table public.trading_settings
  add constraint trading_settings_lob_adaptive_opportunity_v6112 check (
    lob_live_min_pattern_samples >= 20
    and lob_live_min_market_samples >= 4
    and lob_symbol_loss_streak >= 2
    and lob_symbol_loss_cooldown_minutes >= 0
    and lob_max_spread_bps between 5 and 50
    and lob_min_net_reward_risk_ratio >= 1
    and lob_max_stop_to_target_ratio between 0.75 and 1.50
    and lob_core_min_opportunity_score between 0 and 1
    and lob_exploration_min_opportunity_score between 0 and 1
    and lob_exploration_min_net_rr >= 1
    and lob_exploration_max_spread_bps between 1 and lob_max_spread_bps
    and lob_controlled_exploration_daily_loss_pct between 0.05 and 2
    and lob_controlled_exploration_max_concurrent between 1 and 3
    and lob_controlled_exploration_max_entries_per_day between 1 and 50
    and lob_controlled_exploration_fallback_budget_krw > 0
    and lob_controlled_exploration_fallback_budget_usdt > 0
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_adaptive_opportunity_v6112;

create or replace function public.safe_numeric_v6112(p_value text)
returns numeric
language plpgsql
immutable
strict
as $$
begin
  return p_value::numeric;
exception when others then
  return null;
end;
$$;

create or replace function public.safe_integer_v6112(p_value text)
returns integer
language plpgsql
immutable
strict
as $$
declare
  v numeric;
begin
  v := p_value::numeric;
  if v > 2147483647 or v < -2147483648 then return null; end if;
  return trunc(v)::integer;
exception when others then
  return null;
end;
$$;

create or replace function public.enforce_lob_live_entry_v6112()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg record;
  signal jsonb;
  block_reasons text[] := array[]::text[];
  v_lane text := 'CORE';
  v_dynamic_status text;
  v_low_evidence boolean := false;
  v_learning_missing boolean := false;
  v_learning_anomaly boolean := false;
  v_ev_missing boolean := false;
  v_weak_payoff boolean := false;

  v_spread numeric;
  v_rr numeric;
  v_attempt_ev_lb numeric;
  v_conditional_ev_lb numeric;
  v_ev_lb numeric;
  v_target_net numeric;
  v_p_target numeric;
  v_p_stop numeric;
  v_data_quality numeric;
  v_day_change_pct numeric := 0;
  v_opportunity_score numeric := 0;

  v_pattern_samples integer := 0;
  v_pattern_mean numeric;
  v_pattern_lower numeric;
  v_pattern_profit_factor numeric;
  v_pattern_profitable_rate numeric;

  v_coin_source text;
  v_coin_market_samples integer := 0;
  v_coin_pattern_samples integer := 0;
  v_coin_mean numeric;
  v_coin_profitable_rate numeric;

  v_recent_count integer := 0;
  v_recent_all_losses boolean := false;
  v_recent_first_closed_at timestamptz;
  v_recent_last_closed_at timestamptz;

  v_exploration_ok boolean := false;
  v_active_exploration integer := 0;
  v_today_exploration_entries integer := 0;
  v_today_realized_loss numeric := 0;
  v_active_worst_case numeric := 0;
  v_managed_capital numeric := 0;
  v_budget_limit numeric := 0;
  v_new_worst_case numeric := 0;
  v_stop_fraction numeric := 0;
  v_budget_day date;
begin
  if new.is_paper is distinct from false or new.state <> 'ENTRY_PENDING' then
    return new;
  end if;

  signal := coalesce(new.metadata -> 'lob_signal', new.metadata -> 'scalp_signal', '{}'::jsonb);
  if upper(coalesce(signal ->> 'strategy', '')) <> 'LOB_SCALP' then
    return new;
  end if;

  select *
    into cfg
    from public.trading_settings
   where id = 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'LOB_ADMISSION_REJECT: trading_settings row id=1 unavailable';
  end if;

  -- Safe parsing is deliberate. A renamed or malformed learning field must not throw from
  -- the trigger and accidentally convert every candidate into a database failure.
  v_dynamic_status := upper(coalesce(signal #>> '{features,dynamicStatus}', 'UNKNOWN'));
  v_spread := public.safe_numeric_v6112(new.metadata ->> 'live_spread_bps');
  v_rr := public.safe_numeric_v6112(signal ->> 'net_reward_risk_ratio');
  v_attempt_ev_lb := public.safe_numeric_v6112(signal ->> 'attempt_ev_lower_bound_bps');
  v_conditional_ev_lb := public.safe_numeric_v6112(signal ->> 'conditional_ev_lower_bound_bps');
  v_ev_lb := coalesce(v_attempt_ev_lb, v_conditional_ev_lb);
  v_target_net := public.safe_numeric_v6112(signal ->> 'target_return_net_bps');
  v_p_target := public.safe_numeric_v6112(signal ->> 'p_target');
  v_p_stop := public.safe_numeric_v6112(signal ->> 'p_stop');
  v_data_quality := public.safe_numeric_v6112(signal #>> '{features,dataQuality}');
  v_day_change_pct := 100 * coalesce(
    public.safe_numeric_v6112(new.metadata #>> '{quote_at_entry,raw,ticker,change_rate}'),
    public.safe_numeric_v6112(new.metadata #>> '{quote_at_entry,raw,ticker,signed_change_rate}'),
    0
  );

  v_pattern_samples := coalesce(
    public.safe_integer_v6112(signal #>> '{pattern_learning,samples}'),
    0
  );
  v_pattern_mean := public.safe_numeric_v6112(signal #>> '{pattern_learning,mean_net_bps}');
  v_pattern_lower := public.safe_numeric_v6112(
    signal #>> '{pattern_learning,mean_net_lower_bound_bps}'
  );
  v_pattern_profit_factor := public.safe_numeric_v6112(
    signal #>> '{pattern_learning,profit_factor}'
  );
  v_pattern_profitable_rate := public.safe_numeric_v6112(
    signal #>> '{pattern_learning,profitable_rate}'
  );

  v_coin_source := upper(coalesce(signal #>> '{coin_learning,source}', ''));
  v_coin_market_samples := coalesce(
    public.safe_integer_v6112(signal #>> '{coin_learning,market_samples}'),
    0
  );
  v_coin_pattern_samples := coalesce(
    public.safe_integer_v6112(signal #>> '{coin_learning,pattern_samples}'),
    0
  );
  v_coin_mean := public.safe_numeric_v6112(signal #>> '{coin_learning,mean_net_bps}');
  v_coin_profitable_rate := public.safe_numeric_v6112(
    signal #>> '{coin_learning,profitable_rate}'
  );

  v_weak_payoff := jsonb_typeof(signal -> 'warnings') = 'array'
    and (signal -> 'warnings') ? 'NET_PAYOFF_TOO_WEAK';
  v_learning_missing :=
    signal #>> '{pattern_learning,samples}' is null
    or signal #>> '{coin_learning,source}' is null;
  v_learning_anomaly :=
    v_pattern_samples < 0
    or v_coin_market_samples < 0
    or v_coin_pattern_samples < 0
    or (v_pattern_profitable_rate is not null and
        (v_pattern_profitable_rate < 0 or v_pattern_profitable_rate > 1))
    or (v_coin_profitable_rate is not null and
        (v_coin_profitable_rate < 0 or v_coin_profitable_rate > 1))
    or (v_pattern_mean is not null and abs(v_pattern_mean) > 5000)
    or (v_coin_mean is not null and abs(v_coin_mean) > 5000)
    or (v_coin_source <> '' and v_coin_source not in ('PRIOR', 'PATTERN', 'MARKET'));
  v_ev_missing := v_attempt_ev_lb is null and v_conditional_ev_lb is null;
  v_low_evidence :=
    lower(coalesce(new.metadata ->> 'low_evidence', 'false')) = 'true'
    or lower(coalesce(new.metadata ->> 'is_exploration', 'false')) = 'true'
    or v_dynamic_status in ('INSUFFICIENT', 'UNKNOWN')
    or v_learning_missing
    or v_learning_anomaly
    or v_ev_missing;

  -- Opportunity score blends conservative EV, net payoff geometry, executable spread,
  -- feature quality and target-vs-stop probability. Learning affects confidence and lane,
  -- but cannot by itself turn a missing value into a negative trade.
  v_opportunity_score :=
      0.35 * least(1, greatest(0, coalesce(v_ev_lb, 0) / 8))
    + 0.25 * least(1, greatest(0, (coalesce(v_rr, 1) - 1) / 1))
    + 0.20 * least(
        1,
        greatest(0, 1 - coalesce(v_spread, cfg.lob_max_spread_bps) /
          greatest(1, cfg.lob_max_spread_bps))
      )
    + 0.10 * least(1, greatest(0, coalesce(v_data_quality, 0)))
    + 0.10 * least(
        1,
        greatest(0, (coalesce(v_p_target, 0.5) - coalesce(v_p_stop, 0.5) + 0.20) / 0.40)
      );

  -- Structural risk is always a candidate-level hard block. These fields are required to
  -- bound exchange execution and payoff; blocking one malformed candidate does not pause
  -- the scanner or the global engine.
  if v_rr is null then
    block_reasons := array_append(block_reasons, 'MISSING_NET_RR');
  elsif v_rr < cfg.lob_min_net_reward_risk_ratio then
    block_reasons := array_append(block_reasons, 'NET_RR_BELOW_1');
  end if;

  if v_spread is null then
    block_reasons := array_append(block_reasons, 'MISSING_LIVE_SPREAD');
  elsif v_spread > cfg.lob_max_spread_bps then
    block_reasons := array_append(block_reasons, 'SPREAD_TOO_WIDE');
  end if;

  if v_ev_lb is not null and v_ev_lb <= 0 then
    block_reasons := array_append(block_reasons, 'NON_POSITIVE_VERIFIED_EV');
  end if;

  if v_weak_payoff then
    block_reasons := array_append(block_reasons, 'NET_PAYOFF_TOO_WEAK');
  end if;

  if v_day_change_pct >= cfg.lob_chase_change_rate_pct
     and coalesce(v_spread, 999999) >= cfg.lob_chase_min_spread_bps
  then
    block_reasons := array_append(block_reasons, 'WIDE_SPREAD_CHASE');
  end if;

  -- Learning becomes a veto only with mature, materially adverse evidence. Mildly negative
  -- or missing observations reduce confidence and route the trade to controlled exploration.
  if not v_learning_anomaly
     and v_pattern_samples >= cfg.lob_live_min_pattern_samples and (
       (v_pattern_lower is not null and v_pattern_lower < -3)
       or (
         v_pattern_mean is not null and v_pattern_mean <= -8
         and v_pattern_profit_factor is not null and v_pattern_profit_factor < 0.80
         and v_pattern_profitable_rate is not null and v_pattern_profitable_rate < 0.35
       )
     )
  then
    block_reasons := array_append(block_reasons, 'MATURE_NEGATIVE_PATTERN');
  end if;

  if not v_learning_anomaly
     and v_coin_source = 'MARKET'
     and v_coin_market_samples >= cfg.lob_live_min_market_samples
     and v_coin_mean is not null
     and (
       v_coin_mean <= -15
       or (
         v_coin_mean <= -8
         and v_coin_profitable_rate is not null
         and v_coin_profitable_rate <= 0.30
       )
     )
  then
    block_reasons := array_append(block_reasons, 'MATURE_NEGATIVE_MARKET');
  elsif not v_learning_anomaly
     and v_coin_source = 'PATTERN'
     and v_coin_pattern_samples >= cfg.lob_live_min_pattern_samples
     and v_coin_mean is not null
     and v_coin_mean <= -15
  then
    block_reasons := array_append(block_reasons, 'MATURE_NEGATIVE_COIN_PATTERN');
  end if;

  -- A local cooldown prevents immediate repetition without creating an exchange/global halt.
  if cfg.lob_symbol_loss_cooldown_minutes > 0 then
    select count(*), coalesce(bool_and(x.realized_pnl_quote < 0), false),
           min(x.closed_at), max(x.closed_at)
      into v_recent_count, v_recent_all_losses,
           v_recent_first_closed_at, v_recent_last_closed_at
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

    if v_recent_count >= cfg.lob_symbol_loss_streak
       and v_recent_all_losses
       and v_recent_first_closed_at >=
         now() - make_interval(mins => cfg.lob_symbol_loss_cooldown_minutes)
    then
      block_reasons := array_append(block_reasons, 'SYMBOL_LOSS_COOLDOWN');
    end if;
  end if;

  if cardinality(block_reasons) > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'LOB_ADMISSION_REJECT[%s:%s]: %s',
        new.exchange,
        new.market,
        array_to_string(block_reasons, ',')
      );
  end if;

  if v_low_evidence then
    v_lane := 'CONTROLLED_EXPLORATION';

    -- Normal path: a positive conservative EV, stronger payoff geometry and tighter spread.
    -- Schema-drift fallback: if EV fields alone are absent, require substantially stronger
    -- RR, very tight spread, positive net target and pTarget > pStop.
    v_exploration_ok :=
      (
        not v_ev_missing
        and v_ev_lb >= 0.50
        and v_rr >= cfg.lob_exploration_min_net_rr
        and v_spread <= cfg.lob_exploration_max_spread_bps
        and v_opportunity_score >= cfg.lob_exploration_min_opportunity_score
      )
      or (
        v_ev_missing
        and v_rr >= greatest(1.35, cfg.lob_exploration_min_net_rr)
        and v_spread <= least(8, cfg.lob_exploration_max_spread_bps)
        and coalesce(v_target_net, 0) > 0
        and coalesce(v_p_target, 0) > coalesce(v_p_stop, 1)
      );

    if not v_exploration_ok then
      block_reasons := array_append(block_reasons, 'EXPLORATION_EDGE_TOO_WEAK');
    end if;

    select count(*)
      into v_active_exploration
      from public.trading_positions
     where exchange = new.exchange
       and is_paper = false
       and state in ('ENTRY_PENDING', 'OPEN', 'EXITING')
       and metadata ->> 'admission_revision' = '6.11.2-ADAPTIVE-OPPORTUNITY'
       and metadata ->> 'admission_lane' = 'CONTROLLED_EXPLORATION';

    if v_active_exploration >= cfg.lob_controlled_exploration_max_concurrent then
      block_reasons := array_append(block_reasons, 'EXPLORATION_CONCURRENCY_LIMIT');
    end if;

    v_budget_day := case
      when lower(new.exchange) = 'upbit'
        then (now() at time zone 'Asia/Seoul')::date
      else (now() at time zone 'UTC')::date
    end;

    select
      count(*),
      coalesce(sum(
        case
          when state = 'CLOSED' then greatest(0, -coalesce(realized_pnl_quote, 0))
          else 0
        end
      ), 0),
      coalesce(sum(
        case
          when state in ('ENTRY_PENDING', 'OPEN', 'EXITING') then
            coalesce(
              public.safe_numeric_v6112(metadata #>> '{admission_budget,worst_case_loss_quote}'),
              0
            )
          else 0
        end
      ), 0)
      into v_today_exploration_entries, v_today_realized_loss, v_active_worst_case
      from public.trading_positions
     where exchange = new.exchange
       and is_paper = false
       and metadata ->> 'admission_revision' = '6.11.2-ADAPTIVE-OPPORTUNITY'
       and metadata ->> 'admission_lane' = 'CONTROLLED_EXPLORATION'
       and (
         case
           when lower(new.exchange) = 'upbit'
             then (created_at at time zone 'Asia/Seoul')::date
           else (created_at at time zone 'UTC')::date
         end
       ) = v_budget_day;

    if v_today_exploration_entries >= cfg.lob_controlled_exploration_max_entries_per_day then
      block_reasons := array_append(block_reasons, 'EXPLORATION_DAILY_ENTRY_LIMIT');
    end if;

    if coalesce(new.planned_entry_price, 0) > 0 and coalesce(new.stop_price, 0) > 0 then
      v_stop_fraction := greatest(
        0,
        (new.planned_entry_price - new.stop_price) / new.planned_entry_price
      );
    else
      v_stop_fraction := 0.005;
    end if;
    v_new_worst_case := greatest(0, coalesce(new.reserved_quote, 0)) *
      (greatest(0.0005, v_stop_fraction) + 0.003);

    select coalesce((
      select managed_capital_quote
        from public.lob_exploration_budget_daily
       where exchange = lower(new.exchange)
       order by day_key desc
       limit 1
    ), 0)
      into v_managed_capital;

    v_budget_limit := case
      when v_managed_capital > 0 then
        v_managed_capital * cfg.lob_controlled_exploration_daily_loss_pct / 100
      when lower(new.exchange) = 'upbit' then
        cfg.lob_controlled_exploration_fallback_budget_krw
      else
        cfg.lob_controlled_exploration_fallback_budget_usdt
    end;

    if v_today_realized_loss + v_active_worst_case + v_new_worst_case > v_budget_limit then
      block_reasons := array_append(block_reasons, 'EXPLORATION_LOSS_BUDGET');
    end if;

    if cardinality(block_reasons) > 0 then
      raise exception using
        errcode = 'P0001',
        message = format(
          'LOB_ADMISSION_REJECT[%s:%s]: %s',
          new.exchange,
          new.market,
          array_to_string(block_reasons, ',')
        );
    end if;
  elsif v_opportunity_score < cfg.lob_core_min_opportunity_score then
    raise exception using
      errcode = 'P0001',
      message = format(
        'LOB_ADMISSION_REJECT[%s:%s]: CORE_OPPORTUNITY_SCORE_LOW',
        new.exchange,
        new.market
      );
  end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'admission_revision', '6.11.2-ADAPTIVE-OPPORTUNITY',
    'admission_lane', v_lane,
    'admission_opportunity_score', round(v_opportunity_score, 6),
    'admission_learning_missing', v_learning_missing,
    'admission_learning_anomaly', v_learning_anomaly,
    'admission_ev_missing', v_ev_missing,
    'admission_budget', case
      when v_lane = 'CONTROLLED_EXPLORATION' then jsonb_build_object(
        'day_key', v_budget_day,
        'limit_quote', v_budget_limit,
        'realized_loss_quote_before', v_today_realized_loss,
        'active_worst_case_quote_before', v_active_worst_case,
        'worst_case_loss_quote', v_new_worst_case
      )
      else null
    end
  );

  return new;
end;
$$;

drop trigger if exists trading_positions_lob_live_guard_v6111
  on public.trading_positions;
drop trigger if exists trading_positions_lob_live_guard_v6112
  on public.trading_positions;
create trigger trading_positions_lob_live_guard_v6112
before insert on public.trading_positions
for each row
execute function public.enforce_lob_live_entry_v6112();

revoke all on function public.safe_numeric_v6112(text)
  from public, anon, authenticated;
revoke all on function public.safe_integer_v6112(text)
  from public, anon, authenticated;
revoke all on function public.enforce_lob_live_entry_v6112()
  from public, anon, authenticated;

comment on function public.enforce_lob_live_entry_v6112() is
  'Two-lane LOB admission: mature opportunities use CORE; missing/immature learning uses a bounded CONTROLLED_EXPLORATION lane. Candidate rejection never changes the global trading mode.';
comment on column public.trading_settings.lob_live_admission_revision is
  'Current admission model revision. Global loss stop remains scalp_daily_loss_pct.';
