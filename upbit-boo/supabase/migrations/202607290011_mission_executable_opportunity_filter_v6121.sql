-- v6.12.1 executable-opportunity filter.
--
-- A tiny positive diagnostic number is not an executable opportunity when the order-time
-- engine explicitly rejected payoff, EV, chase, lane strength or risk budget. Such rows remain
-- valuable counterfactual data, but they must not force activity-threshold relaxation.

create or replace function public.annotate_lob_mission_decision_v6120()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_strategy text;
  v_ev numeric;
  v_rr numeric;
  v_unavailable boolean;
  v_reason text := upper(coalesce(new.reason, ''));
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

  v_unavailable := v_reason ~ (
    'PRE-EXISTING ACCOUNT BALANCE|ALREADY TRACKED|ALREADY EXPOSED|NO BUYING POWER|' ||
    'RECOMMENDATION.*EXPIRED|STALE ORDERBOOK|INSUFFICIENT (ASK |BID )?DEPTH|' ||
    'MAKER.*MINIMUM|NET_EV_NOT_POSITIVE|NON_POSITIVE_VERIFIED_EV|' ||
    'NET_PAYOFF_TOO_WEAK|WIDE_SPREAD_CHASE|SPREAD_TOO_WIDE|' ||
    'REVALIDATION_EDGE_TOO_WEAK|EXPLORATION_EDGE_TOO_WEAK|' ||
    'REVALIDATION_LOSS_BUDGET|EXPLORATION_LOSS_BUDGET|' ||
    'REVALIDATION_CONCURRENCY_LIMIT|EXPLORATION_CONCURRENCY_LIMIT|' ||
    'REVALIDATION_DAILY_ENTRY_LIMIT|EXPLORATION_DAILY_ENTRY_LIMIT|' ||
    'SYMBOL_LOSS_COOLDOWN|MISSING_LIVE_SPREAD|MISSING_NET_RR'
  );

  new.audit := coalesce(new.audit, '{}'::jsonb) || jsonb_build_object(
    'mission_revision', '6.12.0-MISSION-COMPOUND-EDGE',
    'mission_strategy', v_strategy,
    'mission_ev_lower_bound_bps', v_ev,
    'mission_net_reward_risk_ratio', v_rr,
    'mission_operationally_unavailable', v_unavailable,
    'mission_qualified_opportunity',
      coalesce(v_ev > 0 and v_rr >= 0.80 and not v_unavailable, false)
  );
  return new;
end;
$$;

update public.trading_decisions
   set audit = audit
 where created_at >= (select lob_mission_epoch_at from public.trading_settings where id = 1)
   and upper(coalesce(strategy, audit ->> 'strategy', '')) = 'LOB_SCALP';

select public.refresh_trading_mission_scorecard_v6120('HOURLY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('HOURLY', 'binance', now());
select public.refresh_trading_mission_scorecard_v6120('DAILY', 'upbit', now());
select public.refresh_trading_mission_scorecard_v6120('DAILY', 'binance', now());
