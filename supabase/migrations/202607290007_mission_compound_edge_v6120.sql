-- v6.12.0 MISSION-COMPOUND-EDGE
--
-- The objective is no longer "reject more trades". The model must improve fee-net return,
-- profitable-trade rate and capital activity together. A candidate policy cannot promote by
-- starving itself of trades, and a live model cannot keep a clean win rate by ignoring a
-- sustained supply of positive-EV, executable opportunities.
--
-- Safety contract retained:
--   * spot only; no withdrawal, margin, futures or leverage routes;
--   * positive fee-net EV remains mandatory;
--   * spread, stale-book, chase and mature adverse-learning vetoes remain candidate-local;
--   * the operator-approved KST daily -30% circuit remains the sole global economic stop.

alter table public.trading_settings
  add column if not exists lob_mission_enabled boolean not null default true,
  add column if not exists lob_mission_revision text not null default '6.12.0-MISSION-COMPOUND-EDGE',
  add column if not exists lob_mission_participation_floor numeric not null default 0.20,
  add column if not exists lob_mission_min_qualified_opportunities integer not null default 4,
  add column if not exists lob_mission_hourly_min_trades integer not null default 1,
  add column if not exists lob_mission_daily_min_trades integer not null default 8,
  add column if not exists lob_mission_weekly_min_trades integer not null default 40,
  add column if not exists lob_mission_min_profit_factor numeric not null default 1.05,
  add column if not exists lob_mission_target_profit_factor numeric not null default 1.25,
  add column if not exists lob_mission_min_capture_rate numeric not null default 0.25,
  add column if not exists lob_mission_min_trade_rate_ratio numeric not null default 0.90,
  add column if not exists lob_mission_min_turnover_ratio numeric not null default 0.90,
  add column if not exists lob_mission_activity_deficit boolean not null default false,
  add column if not exists lob_mission_activity_deficit_streak integer not null default 0,
  add column if not exists lob_mission_last_rebalanced_at timestamptz,
  add column if not exists lob_mission_last_scorecard_at timestamptz;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_adaptive_opportunity_v6112;
alter table public.trading_settings
  drop constraint if exists trading_settings_lob_mission_v6120;
alter table public.trading_settings
  add constraint trading_settings_lob_mission_v6120 check (
    lob_mission_participation_floor between 0.05 and 0.80
    and lob_mission_min_qualified_opportunities between 1 and 100
    and lob_mission_hourly_min_trades between 0 and 20
    and lob_mission_daily_min_trades between 0 and 500
    and lob_mission_weekly_min_trades between 0 and 3000
    and lob_mission_min_profit_factor between 0.50 and 5
    and lob_mission_target_profit_factor >= lob_mission_min_profit_factor
    and lob_mission_min_capture_rate between 0 and 1
    and lob_mission_min_trade_rate_ratio between 0.50 and 1.50
    and lob_mission_min_turnover_ratio between 0.50 and 1.50
    and lob_mission_activity_deficit_streak >= 0
    and lob_live_min_pattern_samples >= 20
    and lob_live_min_market_samples >= 4
    and lob_symbol_loss_streak >= 2
    and lob_symbol_loss_cooldown_minutes >= 0
    and lob_max_spread_bps between 5 and 50
    and lob_min_net_reward_risk_ratio between 0.75 and 2
    and lob_max_stop_to_target_ratio between 0.75 and 1.50
    and lob_core_min_opportunity_score between 0 and 1
    and lob_exploration_min_opportunity_score between 0 and 1
    and lob_exploration_min_net_rr between 0.80 and 2
    and lob_exploration_max_spread_bps between 1 and lob_max_spread_bps
    and lob_controlled_exploration_daily_loss_pct between 0.05 and 2
    and lob_controlled_exploration_max_concurrent between 1 and 3
    and lob_controlled_exploration_max_entries_per_day between 1 and 50
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_mission_v6120;

update public.trading_settings
   set lob_mission_enabled = true,
       lob_mission_revision = '6.12.0-MISSION-COMPOUND-EDGE',
       lob_mission_participation_floor = 0.20,
       lob_mission_min_qualified_opportunities = 4,
       lob_mission_hourly_min_trades = 1,
       lob_mission_daily_min_trades = 8,
       lob_mission_weekly_min_trades = 40,
       lob_mission_min_profit_factor = 1.05,
       lob_mission_target_profit_factor = 1.25,
       lob_mission_min_capture_rate = 0.25,
       lob_mission_min_trade_rate_ratio = 0.90,
       lob_mission_min_turnover_ratio = 0.90,
       -- A high-probability scalp may rationally have RR below 1. The joint condition is
       -- positive fee-net EV plus probability edge, not a cosmetic RR threshold.
       lob_min_net_reward_risk_ratio = 0.80,
       lob_exploration_min_net_rr = 0.90,
       lob_max_stop_to_target_ratio = 1.25,
       lob_core_min_opportunity_score = least(coalesce(lob_core_min_opportunity_score, 0.30), 0.24),
       lob_exploration_min_opportunity_score = least(
         coalesce(lob_exploration_min_opportunity_score, 0.45), 0.38
       ),
       lob_exploration_max_spread_bps = least(
         coalesce(lob_exploration_max_spread_bps, 18), 15
       ),
       lob_ev_bias_fallback_cap_bps = least(coalesce(lob_ev_bias_fallback_cap_bps, 4), 2),
       scalp_ev_bias_penalty_bps = least(coalesce(scalp_ev_bias_penalty_bps, 0), 2),
       scalp_target_trades_per_hour = greatest(coalesce(scalp_target_trades_per_hour, 5), 5),
       lob_live_admission_revision = '6.12.0-MISSION-COMPOUND-EDGE',
       version = version + 1,
       updated_at = now()
 where id = 1;

create table if not exists public.trading_trade_mission_audits (
  position_id uuid primary key references public.trading_positions(id) on delete cascade,
  exchange text not null,
  market text not null,
  policy_version bigint,
  admission_lane text,
  pattern text,
  predicted_ev_bps numeric,
  realized_net_bps numeric not null,
  profitable boolean not null,
  forecast_residual_bps numeric,
  realized_pnl_quote numeric not null,
  realized_cost_quote numeric not null,
  paid_fees_quote numeric not null,
  opened_at timestamptz,
  closed_at timestamptz not null,
  mission_revision text not null default '6.12.0-MISSION-COMPOUND-EDGE',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trading_trade_mission_audits_exchange_closed_idx
  on public.trading_trade_mission_audits(exchange, closed_at desc);

create table if not exists public.trading_mission_scorecards (
  id bigint generated by default as identity primary key,
  period_type text not null check (period_type in ('HOURLY','DAILY','WEEKLY')),
  exchange text not null check (exchange in ('upbit','binance')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  qualified_opportunities integer not null default 0,
  entry_attempts integer not null default 0,
  entries integer not null default 0,
  required_entries integer not null default 0,
  participation_rate numeric not null default 1,
  closed_trades integer not null default 0,
  wins integer not null default 0,
  win_rate numeric not null default 0,
  break_even_win_rate numeric not null default 0,
  net_pnl_quote numeric not null default 0,
  mean_net_bps numeric not null default 0,
  profit_factor numeric not null default 0,
  paid_fees_quote numeric not null default 0,
  shadow_buy_opportunities integer not null default 0,
  shadow_profitable_opportunities integer not null default 0,
  captured_profitable_opportunities integer not null default 0,
  missed_profitable_opportunities integer not null default 0,
  opportunity_capture_rate numeric not null default 1,
  evaluation_ready boolean not null default false,
  activity_pass boolean not null default true,
  profitability_pass boolean not null default false,
  win_rate_pass boolean not null default false,
  capture_pass boolean not null default true,
  mission_pass boolean not null default false,
  mission_revision text not null default '6.12.0-MISSION-COMPOUND-EDGE',
  metrics jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  unique(period_type, exchange, period_start)
);
create index if not exists trading_mission_scorecards_latest_idx
  on public.trading_mission_scorecards(exchange, period_type, period_start desc);

create or replace function public.annotate_lob_mission_decision_v6120()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_ev numeric;
  v_rr numeric;
  v_operational boolean;
begin
  if upper(coalesce(new.strategy, '')) <> 'LOB_SCALP' then return new; end if;
  v_ev := coalesce(
    public.safe_numeric_v6112(new.audit ->> 'attempt_ev_lower_bound_bps'),
    public.safe_numeric_v6112(new.audit ->> 'conditional_ev_lower_bound_bps'),
    new.ev_lower_bound_bps,
    public.safe_numeric_v6112(new.audit #>> '{lob_signal,attempt_ev_lower_bound_bps}'),
    public.safe_numeric_v6112(new.audit #>> '{lob_signal,conditional_ev_lower_bound_bps}')
  );
  v_rr := coalesce(
    public.safe_numeric_v6112(new.audit ->> 'net_reward_risk_ratio'),
    public.safe_numeric_v6112(new.audit #>> '{lob_signal,net_reward_risk_ratio}')
  );
  v_operational := coalesce(new.reason, '') ~* (
    'pre-existing account balance|already tracked|already exposed|no buying power|' ||
    'recommendation.*expired|stale orderbook|insufficient depth|maker.*minimum'
  );
  new.audit := coalesce(new.audit, '{}'::jsonb) || jsonb_build_object(
    'mission_revision', '6.12.0-MISSION-COMPOUND-EDGE',
    'mission_ev_lower_bound_bps', v_ev,
    'mission_net_reward_risk_ratio', v_rr,
    'mission_operationally_unavailable', v_operational,
    'mission_qualified_opportunity',
      coalesce(v_ev > 0 and v_rr >= 0.80 and not v_operational, false)
  );
  return new;
end;
$$;

drop trigger if exists trading_decisions_mission_annotation_v6120
  on public.trading_decisions;
create trigger trading_decisions_mission_annotation_v6120
before insert or update of audit, reason, ev_lower_bound_bps on public.trading_decisions
for each row execute function public.annotate_lob_mission_decision_v6120();

create or replace function public.refresh_trading_mission_scorecard_v6120(
  p_period_type text,
  p_exchange text,
  p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  v_type text := upper(coalesce(p_period_type, ''));
  v_exchange text := lower(coalesce(p_exchange, ''));
  v_start timestamptz;
  v_end timestamptz;
  v_base_min integer := 0;
  v_qualified integer := 0;
  v_attempts integer := 0;
  v_entries integer := 0;
  v_required integer := 0;
  v_participation numeric := 1;
  v_closed integer := 0;
  v_wins integer := 0;
  v_win_rate numeric := 0;
  v_net numeric := 0;
  v_mean_bps numeric := 0;
  v_fees numeric := 0;
  v_gross_profit_bps numeric := 0;
  v_gross_loss_bps numeric := 0;
  v_profit_factor numeric := 0;
  v_avg_win_bps numeric := 0;
  v_avg_loss_bps numeric := 0;
  v_break_even numeric := 0;
  v_shadow_buy integer := 0;
  v_shadow_profitable integer := 0;
  v_shadow_captured integer := 0;
  v_shadow_missed integer := 0;
  v_capture numeric := 1;
  v_ready boolean := false;
  v_activity_pass boolean := true;
  v_profitability_pass boolean := false;
  v_win_pass boolean := false;
  v_capture_pass boolean := true;
  v_mission_pass boolean := false;
  v_row public.trading_mission_scorecards%rowtype;
begin
  if v_exchange not in ('upbit','binance') then
    raise exception 'unsupported mission exchange %', p_exchange;
  end if;
  if v_type not in ('HOURLY','DAILY','WEEKLY') then
    raise exception 'unsupported mission period %', p_period_type;
  end if;

  select * into cfg from public.trading_settings where id = 1;
  if not found then raise exception 'trading_settings id=1 unavailable'; end if;

  if v_type = 'HOURLY' then
    v_start := date_trunc('hour', p_as_of);
    v_end := v_start + interval '1 hour';
    v_base_min := cfg.lob_mission_hourly_min_trades;
  elsif v_type = 'DAILY' and v_exchange = 'upbit' then
    v_start := date_trunc('day', p_as_of at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
    v_end := v_start + interval '1 day';
    v_base_min := cfg.lob_mission_daily_min_trades;
  elsif v_type = 'DAILY' then
    v_start := date_trunc('day', p_as_of at time zone 'UTC') at time zone 'UTC';
    v_end := v_start + interval '1 day';
    v_base_min := cfg.lob_mission_daily_min_trades;
  elsif v_exchange = 'upbit' then
    v_start := date_trunc('week', p_as_of at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
    v_end := v_start + interval '1 week';
    v_base_min := cfg.lob_mission_weekly_min_trades;
  else
    v_start := date_trunc('week', p_as_of at time zone 'UTC') at time zone 'UTC';
    v_end := v_start + interval '1 week';
    v_base_min := cfg.lob_mission_weekly_min_trades;
  end if;

  select
    count(*) filter (where coalesce((audit ->> 'mission_qualified_opportunity')::boolean, false)),
    count(*)
    into v_qualified, v_attempts
    from public.trading_decisions
   where lower(exchange) = v_exchange
     and upper(coalesce(strategy, '')) = 'LOB_SCALP'
     and created_at >= v_start and created_at < v_end;

  select count(*) into v_entries
    from public.trading_positions
   where lower(exchange) = v_exchange
     and is_paper = false
     and coalesce(opened_at, created_at) >= v_start
     and coalesce(opened_at, created_at) < v_end
     and state not in ('CANCELLED','ERROR');

  if v_qualified >= cfg.lob_mission_min_qualified_opportunities then
    v_required := least(
      v_qualified,
      greatest(v_base_min, ceil(v_qualified * cfg.lob_mission_participation_floor)::integer)
    );
  end if;
  v_participation := case when v_qualified > 0
    then least(1, v_entries::numeric / v_qualified)
    else 1 end;

  with closed as (
    select
      realized_pnl_quote,
      paid_fees_quote,
      case when realized_cost_quote > 0
        then realized_pnl_quote / realized_cost_quote * 10000 else 0 end as net_bps
    from public.trading_positions
    where lower(exchange) = v_exchange
      and is_paper = false
      and state = 'CLOSED'
      and closed_at >= v_start and closed_at < v_end
  )
  select
    count(*),
    count(*) filter (where realized_pnl_quote > 0),
    coalesce(sum(realized_pnl_quote), 0),
    coalesce(avg(net_bps), 0),
    coalesce(sum(paid_fees_quote), 0),
    coalesce(sum(greatest(net_bps, 0)), 0),
    coalesce(sum(greatest(-net_bps, 0)), 0),
    coalesce(avg(net_bps) filter (where net_bps > 0), 0),
    coalesce(avg(-net_bps) filter (where net_bps < 0), 0)
    into v_closed, v_wins, v_net, v_mean_bps, v_fees,
         v_gross_profit_bps, v_gross_loss_bps, v_avg_win_bps, v_avg_loss_bps
    from closed;

  v_win_rate := case when v_closed > 0 then v_wins::numeric / v_closed else 0 end;
  v_profit_factor := case
    when v_gross_loss_bps > 0 then v_gross_profit_bps / v_gross_loss_bps
    when v_gross_profit_bps > 0 then 999
    else 0 end;
  v_break_even := case
    when v_avg_win_bps + v_avg_loss_bps > 0
      then v_avg_loss_bps / (v_avg_win_bps + v_avg_loss_bps)
    else 0 end;

  select
    count(*) filter (where upper(coalesce(s.decision, '')) = 'BUY'),
    count(*) filter (
      where upper(coalesce(s.decision, '')) = 'BUY' and coalesce(s.realized_return, 0) > 0
    ),
    count(*) filter (
      where upper(coalesce(s.decision, '')) = 'BUY'
        and coalesce(s.realized_return, 0) > 0
        and exists (
          select 1 from public.trading_positions p
          where p.candidate_id = s.candidate_id and p.is_paper = false
        )
    )
    into v_shadow_buy, v_shadow_profitable, v_shadow_captured
    from public.scalp_shadow_outcomes s
   where lower(s.exchange) = v_exchange
     and s.scanned_at >= v_start and s.scanned_at < v_end;

  v_shadow_missed := greatest(0, v_shadow_profitable - v_shadow_captured);
  v_capture := case when v_shadow_profitable > 0
    then v_shadow_captured::numeric / v_shadow_profitable else 1 end;
  v_ready := v_closed >= 5;
  v_activity_pass := v_entries >= v_required;
  v_profitability_pass := v_ready and v_net > 0 and v_profit_factor >= cfg.lob_mission_min_profit_factor;
  v_win_pass := v_ready and v_win_rate > v_break_even;
  v_capture_pass := v_shadow_profitable < 5 or v_capture >= cfg.lob_mission_min_capture_rate;
  v_mission_pass := v_ready and v_activity_pass and v_profitability_pass and v_win_pass and v_capture_pass;

  insert into public.trading_mission_scorecards(
    period_type, exchange, period_start, period_end,
    qualified_opportunities, entry_attempts, entries, required_entries, participation_rate,
    closed_trades, wins, win_rate, break_even_win_rate, net_pnl_quote, mean_net_bps,
    profit_factor, paid_fees_quote, shadow_buy_opportunities, shadow_profitable_opportunities,
    captured_profitable_opportunities, missed_profitable_opportunities,
    opportunity_capture_rate, evaluation_ready, activity_pass, profitability_pass,
    win_rate_pass, capture_pass, mission_pass, mission_revision, metrics, captured_at
  ) values (
    v_type, v_exchange, v_start, v_end,
    v_qualified, v_attempts, v_entries, v_required, v_participation,
    v_closed, v_wins, v_win_rate, v_break_even, v_net, v_mean_bps,
    v_profit_factor, v_fees, v_shadow_buy, v_shadow_profitable,
    v_shadow_captured, v_shadow_missed, v_capture, v_ready, v_activity_pass,
    v_profitability_pass, v_win_pass, v_capture_pass, v_mission_pass,
    '6.12.0-MISSION-COMPOUND-EDGE',
    jsonb_build_object(
      'anti_gaming', jsonb_build_object(
        'qualified_opportunities', v_qualified,
        'required_entries', v_required,
        'actual_entries', v_entries,
        'participation_floor', cfg.lob_mission_participation_floor,
        'trade_rate_ratio_floor', cfg.lob_mission_min_trade_rate_ratio,
        'turnover_ratio_floor', cfg.lob_mission_min_turnover_ratio
      ),
      'economic_objective', jsonb_build_object(
        'net_pnl_quote', v_net,
        'mean_net_bps', v_mean_bps,
        'profit_factor', v_profit_factor,
        'win_rate', v_win_rate,
        'break_even_win_rate', v_break_even,
        'opportunity_capture_rate', v_capture
      )
    ),
    now()
  )
  on conflict(period_type, exchange, period_start) do update set
    period_end = excluded.period_end,
    qualified_opportunities = excluded.qualified_opportunities,
    entry_attempts = excluded.entry_attempts,
    entries = excluded.entries,
    required_entries = excluded.required_entries,
    participation_rate = excluded.participation_rate,
    closed_trades = excluded.closed_trades,
    wins = excluded.wins,
    win_rate = excluded.win_rate,
    break_even_win_rate = excluded.break_even_win_rate,
    net_pnl_quote = excluded.net_pnl_quote,
    mean_net_bps = excluded.mean_net_bps,
    profit_factor = excluded.profit_factor,
    paid_fees_quote = excluded.paid_fees_quote,
    shadow_buy_opportunities = excluded.shadow_buy_opportunities,
    shadow_profitable_opportunities = excluded.shadow_profitable_opportunities,
    captured_profitable_opportunities = excluded.captured_profitable_opportunities,
    missed_profitable_opportunities = excluded.missed_profitable_opportunities,
    opportunity_capture_rate = excluded.opportunity_capture_rate,
    evaluation_ready = excluded.evaluation_ready,
    activity_pass = excluded.activity_pass,
    profitability_pass = excluded.profitability_pass,
    win_rate_pass = excluded.win_rate_pass,
    capture_pass = excluded.capture_pass,
    mission_pass = excluded.mission_pass,
    mission_revision = excluded.mission_revision,
    metrics = excluded.metrics,
    captured_at = excluded.captured_at
  returning * into v_row;

  update public.trading_settings
     set lob_mission_last_scorecard_at = now(), updated_at = now()
   where id = 1;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.audit_closed_trade_mission_v6120()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  signal jsonb;
  v_predicted numeric;
  v_realized_bps numeric;
begin
  if new.is_paper is distinct from false or new.state <> 'CLOSED' or new.closed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.state = 'CLOSED' and old.updated_at = new.updated_at then
    return new;
  end if;
  signal := coalesce(new.metadata -> 'lob_signal', new.metadata -> 'scalp_signal', '{}'::jsonb);
  v_predicted := coalesce(
    public.safe_numeric_v6112(signal ->> 'conditional_ev_lower_bound_bps'),
    public.safe_numeric_v6112(signal ->> 'attempt_ev_lower_bound_bps'),
    public.safe_numeric_v6112(signal ->> 'ev_lower_bound_bps')
  );
  v_realized_bps := case when coalesce(new.realized_cost_quote, 0) > 0
    then coalesce(new.realized_pnl_quote, 0) / new.realized_cost_quote * 10000
    else 0 end;

  insert into public.trading_trade_mission_audits(
    position_id, exchange, market, policy_version, admission_lane, pattern,
    predicted_ev_bps, realized_net_bps, profitable, forecast_residual_bps,
    realized_pnl_quote, realized_cost_quote, paid_fees_quote,
    opened_at, closed_at, metadata, updated_at
  ) values (
    new.id, lower(new.exchange), new.market,
    public.safe_integer_v6112(new.metadata #>> '{lob_policy,version}'),
    new.metadata ->> 'admission_lane', signal ->> 'pattern',
    v_predicted, v_realized_bps, coalesce(new.realized_pnl_quote, 0) > 0,
    case when v_predicted is null then null else v_realized_bps - v_predicted end,
    coalesce(new.realized_pnl_quote, 0), coalesce(new.realized_cost_quote, 0),
    coalesce(new.paid_fees_quote, 0), new.opened_at, new.closed_at,
    jsonb_build_object('close_reason', new.close_reason, 'fee_accounting_quality', new.fee_accounting_quality),
    now()
  )
  on conflict(position_id) do update set
    realized_net_bps = excluded.realized_net_bps,
    profitable = excluded.profitable,
    forecast_residual_bps = excluded.forecast_residual_bps,
    realized_pnl_quote = excluded.realized_pnl_quote,
    realized_cost_quote = excluded.realized_cost_quote,
    paid_fees_quote = excluded.paid_fees_quote,
    closed_at = excluded.closed_at,
    metadata = excluded.metadata,
    updated_at = now();

  perform public.refresh_trading_mission_scorecard_v6120('HOURLY', lower(new.exchange), new.closed_at);
  perform public.refresh_trading_mission_scorecard_v6120('DAILY', lower(new.exchange), new.closed_at);
  perform public.refresh_trading_mission_scorecard_v6120('WEEKLY', lower(new.exchange), new.closed_at);
  return new;
end;
$$;

drop trigger if exists trading_positions_trade_mission_audit_v6120
  on public.trading_positions;
create trigger trading_positions_trade_mission_audit_v6120
after insert or update of state, realized_pnl_quote, realized_cost_quote, paid_fees_quote
on public.trading_positions
for each row execute function public.audit_closed_trade_mission_v6120();

create or replace function public.rebalance_lob_mission_activity_v6120()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  v_since timestamptz := now() - interval '1 hour';
  v_qualified integer := 0;
  v_entries integer := 0;
  v_required integer := 0;
  v_deficit boolean := false;
  v_changed boolean := false;
  v_result jsonb;
begin
  perform pg_advisory_xact_lock(6120);
  select * into cfg from public.trading_settings where id = 1 for update;
  if not found or not cfg.lob_mission_enabled then
    return jsonb_build_object('changed', false, 'reason', 'MISSION_DISABLED');
  end if;
  if cfg.lob_mission_last_rebalanced_at is not null
     and cfg.lob_mission_last_rebalanced_at > now() - interval '5 minutes'
  then
    return jsonb_build_object('changed', false, 'reason', 'REBALANCE_COOLDOWN');
  end if;

  select count(*) into v_qualified
    from public.trading_decisions
   where upper(coalesce(strategy, '')) = 'LOB_SCALP'
     and created_at >= v_since
     and coalesce((audit ->> 'mission_qualified_opportunity')::boolean, false);
  select count(*) into v_entries
    from public.trading_positions
   where is_paper = false
     and coalesce(opened_at, created_at) >= v_since
     and state not in ('CANCELLED','ERROR');

  if v_qualified >= cfg.lob_mission_min_qualified_opportunities then
    v_required := least(
      v_qualified,
      greatest(
        cfg.lob_mission_hourly_min_trades,
        ceil(v_qualified * cfg.lob_mission_participation_floor)::integer
      )
    );
  end if;
  v_deficit := v_entries < v_required;

  if v_deficit then
    -- Relax only model confidence/ranking thresholds. Positive fee-net EV, executable spread,
    -- local cooldowns, exploration loss budget and the -30% daily circuit are untouched.
    update public.trading_settings
       set lob_mission_activity_deficit = true,
           lob_mission_activity_deficit_streak = lob_mission_activity_deficit_streak + 1,
           scalp_ev_bias_penalty_bps = greatest(0, coalesce(scalp_ev_bias_penalty_bps, 0) - 0.25),
           lob_min_net_reward_risk_ratio = greatest(0.80, lob_min_net_reward_risk_ratio - 0.05),
           lob_exploration_min_net_rr = greatest(0.90, lob_exploration_min_net_rr - 0.05),
           lob_core_min_opportunity_score = greatest(0.20, lob_core_min_opportunity_score - 0.02),
           lob_exploration_min_opportunity_score = greatest(
             0.35, lob_exploration_min_opportunity_score - 0.02
           ),
           lob_mission_last_rebalanced_at = now(),
           updated_at = now()
     where id = 1;
    v_changed := true;
  else
    update public.trading_settings
       set lob_mission_activity_deficit = false,
           lob_mission_activity_deficit_streak = 0,
           lob_mission_last_rebalanced_at = now(),
           updated_at = now()
     where id = 1;
  end if;

  v_result := jsonb_build_object(
    'changed', v_changed,
    'mission_revision', '6.12.0-MISSION-COMPOUND-EDGE',
    'qualified_opportunities_1h', v_qualified,
    'entries_1h', v_entries,
    'required_entries_1h', v_required,
    'activity_deficit', v_deficit
  );
  return v_result;
end;
$$;

create or replace function public.on_lob_mission_cycle_event_v6120()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.code in ('ENTRY_ADMISSION_SUMMARY','ENTRY_ADMISSION_COLLAPSE') then
    perform public.rebalance_lob_mission_activity_v6120();
    perform public.refresh_trading_mission_scorecard_v6120('HOURLY', 'upbit', new.created_at);
    perform public.refresh_trading_mission_scorecard_v6120('HOURLY', 'binance', new.created_at);
  end if;
  return new;
end;
$$;

drop trigger if exists trading_events_lob_mission_cycle_v6120
  on public.trading_events;
create trigger trading_events_lob_mission_cycle_v6120
after insert on public.trading_events
for each row execute function public.on_lob_mission_cycle_event_v6120();

create or replace function public.enforce_lob_mission_promotion_v6120()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  c jsonb;
  b jsonb;
  v_candidate_samples numeric;
  v_candidate_pf numeric;
  v_baseline_pf numeric;
  v_candidate_net numeric;
  v_baseline_net numeric;
  v_candidate_win numeric;
  v_baseline_win numeric;
  v_trade_rate_ratio numeric;
  v_turnover_ratio numeric;
  v_fill_rate numeric;
begin
  if new.status is not distinct from old.status
     or new.status not in ('CHAMPION','CONTROL')
  then return new; end if;

  select * into cfg from public.trading_settings where id = 1;
  c := coalesce(new.metrics -> 'candidate', '{}'::jsonb);
  b := coalesce(new.metrics -> 'baseline', '{}'::jsonb);
  v_candidate_samples := coalesce(public.safe_numeric_v6112(c ->> 'samples'), 0);
  v_candidate_pf := coalesce(public.safe_numeric_v6112(c ->> 'profitFactor'), 0);
  v_baseline_pf := coalesce(public.safe_numeric_v6112(b ->> 'profitFactor'), 0);
  v_candidate_net := coalesce(public.safe_numeric_v6112(c ->> 'meanNetBps'), 0);
  v_baseline_net := coalesce(public.safe_numeric_v6112(b ->> 'meanNetBps'), 0);
  v_candidate_win := coalesce(public.safe_numeric_v6112(c ->> 'winRate'), 0);
  v_baseline_win := coalesce(public.safe_numeric_v6112(b ->> 'winRate'), 0);
  v_trade_rate_ratio := case
    when coalesce(public.safe_numeric_v6112(b ->> 'tradesPerAssignedScan'), 0) > 0 then
      coalesce(public.safe_numeric_v6112(c ->> 'tradesPerAssignedScan'), 0) /
      public.safe_numeric_v6112(b ->> 'tradesPerAssignedScan')
    else case when coalesce(public.safe_numeric_v6112(c ->> 'tradesPerAssignedScan'), 0) > 0
      then 999 else 0 end end;
  v_turnover_ratio := case
    when coalesce(public.safe_numeric_v6112(b ->> 'capitalTurnsPerHour'), 0) > 0 then
      coalesce(public.safe_numeric_v6112(c ->> 'capitalTurnsPerHour'), 0) /
      public.safe_numeric_v6112(b ->> 'capitalTurnsPerHour')
    else case when coalesce(public.safe_numeric_v6112(c ->> 'capitalTurnsPerHour'), 0) > 0
      then 999 else 0 end end;
  v_fill_rate := coalesce(public.safe_numeric_v6112(c ->> 'fillPerReservation'), 0);

  if v_candidate_samples <= 0 or v_fill_rate <= 0 then
    raise exception 'LOB_MISSION_PROMOTION_REJECT: zero completed live trades cannot promote';
  end if;
  if v_candidate_net <= v_baseline_net then
    raise exception 'LOB_MISSION_PROMOTION_REJECT: fee-net return did not improve';
  end if;
  if v_candidate_win <= v_baseline_win then
    raise exception 'LOB_MISSION_PROMOTION_REJECT: win rate did not improve';
  end if;
  if v_candidate_pf < greatest(cfg.lob_mission_min_profit_factor, v_baseline_pf) then
    raise exception 'LOB_MISSION_PROMOTION_REJECT: profit factor did not improve enough';
  end if;
  if v_trade_rate_ratio < cfg.lob_mission_min_trade_rate_ratio then
    raise exception 'LOB_MISSION_PROMOTION_REJECT: trade-rate starvation detected';
  end if;
  if v_turnover_ratio < cfg.lob_mission_min_turnover_ratio then
    raise exception 'LOB_MISSION_PROMOTION_REJECT: capital-turnover starvation detected';
  end if;

  new.criteria := coalesce(new.criteria, '{}'::jsonb) || jsonb_build_object(
    'mission_revision', '6.12.0-MISSION-COMPOUND-EDGE',
    'requires_net_return_improvement', true,
    'requires_win_rate_improvement', true,
    'requires_profit_factor_improvement', true,
    'min_trade_rate_ratio', cfg.lob_mission_min_trade_rate_ratio,
    'min_capital_turnover_ratio', cfg.lob_mission_min_turnover_ratio,
    'metric_gaming_by_trade_starvation_forbidden', true
  );
  return new;
end;
$$;

drop trigger if exists lob_policy_versions_mission_promotion_v6120
  on public.lob_policy_versions;
create trigger lob_policy_versions_mission_promotion_v6120
before update of status on public.lob_policy_versions
for each row execute function public.enforce_lob_mission_promotion_v6120();

update public.lob_policy_versions
   set criteria = coalesce(criteria, '{}'::jsonb) || jsonb_build_object(
     'mission_revision', '6.12.0-MISSION-COMPOUND-EDGE',
     'requires_net_return_improvement', true,
     'requires_win_rate_improvement', true,
     'requires_profit_factor_improvement', true,
     'min_trade_rate_ratio', 0.90,
     'min_capital_turnover_ratio', 0.90,
     'metric_gaming_by_trade_starvation_forbidden', true
   ),
   updated_at = now()
 where status in ('CHAMPION','CHALLENGER','CONTROL');

-- Stamp future admitted rows with the economic mission without changing the admission_revision
-- used by the v6.11.2 controlled-exploration budget queries.
create or replace function public.stamp_lob_mission_position_v6120()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_paper is false and new.state = 'ENTRY_PENDING' then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'mission_revision', '6.12.0-MISSION-COMPOUND-EDGE',
      'mission_activity_floor', 0.20,
      'mission_objective', 'NET_RETURN+WIN_RATE+ACTIVITY'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists zz_trading_positions_mission_stamp_v6120
  on public.trading_positions;
create trigger zz_trading_positions_mission_stamp_v6120
before insert on public.trading_positions
for each row execute function public.stamp_lob_mission_position_v6120();

revoke all on function public.annotate_lob_mission_decision_v6120()
  from public, anon, authenticated;
revoke all on function public.refresh_trading_mission_scorecard_v6120(text,text,timestamptz)
  from public, anon, authenticated;
revoke all on function public.audit_closed_trade_mission_v6120()
  from public, anon, authenticated;
revoke all on function public.rebalance_lob_mission_activity_v6120()
  from public, anon, authenticated;
revoke all on function public.on_lob_mission_cycle_event_v6120()
  from public, anon, authenticated;
revoke all on function public.enforce_lob_mission_promotion_v6120()
  from public, anon, authenticated;
revoke all on function public.stamp_lob_mission_position_v6120()
  from public, anon, authenticated;

comment on table public.trading_mission_scorecards is
  'Hourly/daily/weekly joint objective: fee-net return, break-even-adjusted win rate, opportunity capture and opportunity-normalized activity.';
comment on function public.enforce_lob_mission_promotion_v6120() is
  'Forbids policy promotion by trade starvation; net return, win rate, profit factor, trade rate and capital turnover must improve together.';
comment on function public.rebalance_lob_mission_activity_v6120() is
  'When positive-EV opportunity supply persists but entries collapse, relaxes confidence/ranking thresholds without weakening positive-EV, execution or global loss safety.';

-- Backfill the current reporting windows. These statements are idempotent through scorecard
-- uniqueness and do not place orders.
select public.refresh_trading_mission_scorecard_v6120('HOURLY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('HOURLY', 'binance', now());
select public.refresh_trading_mission_scorecard_v6120('DAILY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('DAILY', 'binance', now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY', 'binance', now());
