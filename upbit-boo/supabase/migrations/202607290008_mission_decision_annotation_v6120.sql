-- v6.12.0 mission annotation repair.
--
-- `trading_decisions.strategy` is null in the current autotrader ledger; the actual strategy
-- and order-time economics live in `audit`. Infer the mission contract from those canonical
-- fields so qualified-opportunity supply and activity deficits are measured rather than
-- silently reported as zero.

create or replace function public.annotate_lob_mission_decision_v6120()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_strategy text;
  v_ev numeric;
  v_rr numeric;
  v_operational boolean;
begin
  v_strategy := upper(coalesce(
    new.strategy,
    new.audit ->> 'strategy',
    new.audit #>> '{scanned_lob,strategy}',
    new.audit #>> '{lob_signal,strategy}',
    ''
  ));
  if v_strategy <> 'LOB_SCALP' then return new; end if;

  v_ev := coalesce(
    public.safe_numeric_v6112(new.audit ->> 'attempt_ev_lower_bound_bps'),
    public.safe_numeric_v6112(new.audit ->> 'conditional_ev_lower_bound_bps'),
    new.ev_lower_bound_bps,
    public.safe_numeric_v6112(new.audit ->> 'ev_lower_bound_bps'),
    public.safe_numeric_v6112(new.audit #>> '{scanned_lob,ev_lower_bound_bps}'),
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
    'mission_strategy', v_strategy,
    'mission_ev_lower_bound_bps', v_ev,
    'mission_net_reward_risk_ratio', v_rr,
    'mission_operationally_unavailable', v_operational,
    'mission_qualified_opportunity',
      coalesce(v_ev > 0 and v_rr >= 0.80 and not v_operational, false)
  );
  return new;
end;
$$;

-- Recompile scorecards against the strategy stored in the audit ledger.
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
     and upper(coalesce(strategy, audit ->> 'mission_strategy', audit ->> 'strategy', '')) = 'LOB_SCALP'
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
    ), now()
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
   where upper(coalesce(strategy, audit ->> 'mission_strategy', audit ->> 'strategy', '')) = 'LOB_SCALP'
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
           lob_mission_last_rebalanced_at = now(), updated_at = now()
     where id = 1;
    v_changed := true;
  else
    update public.trading_settings
       set lob_mission_activity_deficit = false,
           lob_mission_activity_deficit_streak = 0,
           lob_mission_last_rebalanced_at = now(), updated_at = now()
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

-- Re-annotate the post-release decisions and refresh all current scorecards.
update public.trading_decisions
   set audit = audit
 where created_at >= '2026-07-29T01:27:04Z'
   and upper(coalesce(strategy, audit ->> 'strategy', '')) = 'LOB_SCALP';

select public.refresh_trading_mission_scorecard_v6120('HOURLY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('HOURLY', 'binance', now());
select public.refresh_trading_mission_scorecard_v6120('DAILY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('DAILY', 'binance', now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY', 'binance', now());
