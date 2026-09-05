-- v6.12.2 mission-epoch scorecards.
--
-- Do not credit the new mission with trades placed by the failed predecessor, and do not use
-- six-hour legacy scalp shadows as evidence for a three-minute LOB strategy. The original
-- aggregator is retained as a compatibility implementation; this wrapper recalculates every
-- mission-critical field from the v6.12 epoch and only accepts horizon-compatible v6.12 shadow
-- labels for opportunity capture.

alter function public.refresh_trading_mission_scorecard_v6120(text,text,timestamptz)
  rename to refresh_trading_mission_scorecard_legacy_v6120;

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
  base jsonb;
  row_out public.trading_mission_scorecards%rowtype;
  v_type text := upper(coalesce(p_period_type,''));
  v_exchange text := lower(coalesce(p_exchange,''));
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_eval_start timestamptz;
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
  v_pf numeric := 0;
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
begin
  select * into cfg from public.trading_settings where id=1;
  if not found then raise exception 'trading_settings id=1 unavailable'; end if;

  base := public.refresh_trading_mission_scorecard_legacy_v6120(v_type,v_exchange,p_as_of);
  v_period_start := (base->>'period_start')::timestamptz;
  v_period_end := (base->>'period_end')::timestamptz;
  v_eval_start := greatest(v_period_start,cfg.lob_mission_epoch_at);
  v_base_min := case v_type
    when 'HOURLY' then cfg.lob_mission_hourly_min_trades
    when 'DAILY' then cfg.lob_mission_daily_min_trades
    else cfg.lob_mission_weekly_min_trades end;

  select
    count(*) filter(where coalesce((audit->>'mission_qualified_opportunity')::boolean,false)),
    count(*)
    into v_qualified,v_attempts
    from public.trading_decisions
   where lower(exchange)=v_exchange
     and upper(coalesce(strategy,audit->>'mission_strategy',audit->>'strategy',''))='LOB_SCALP'
     and created_at>=v_eval_start and created_at<v_period_end;

  select count(*) into v_entries
    from public.trading_positions
   where lower(exchange)=v_exchange and is_paper=false
     and coalesce(opened_at,created_at)>=v_eval_start
     and coalesce(opened_at,created_at)<v_period_end
     and state not in ('CANCELLED','ERROR');

  if v_qualified>=cfg.lob_mission_min_qualified_opportunities then
    v_required:=least(v_qualified,greatest(v_base_min,ceil(v_qualified*cfg.lob_mission_participation_floor)::integer));
  end if;
  v_participation:=case when v_qualified>0 then least(1,v_entries::numeric/v_qualified) else 1 end;

  with closed as (
    select realized_pnl_quote,paid_fees_quote,
           case when realized_cost_quote>0 then realized_pnl_quote/realized_cost_quote*10000 else 0 end net_bps
      from public.trading_positions
     where lower(exchange)=v_exchange and is_paper=false and state='CLOSED'
       and closed_at>=v_eval_start and closed_at<v_period_end
  )
  select count(*),count(*) filter(where realized_pnl_quote>0),coalesce(sum(realized_pnl_quote),0),
         coalesce(avg(net_bps),0),coalesce(sum(paid_fees_quote),0),
         coalesce(sum(greatest(net_bps,0)),0),coalesce(sum(greatest(-net_bps,0)),0),
         coalesce(avg(net_bps) filter(where net_bps>0),0),
         coalesce(avg(-net_bps) filter(where net_bps<0),0)
    into v_closed,v_wins,v_net,v_mean_bps,v_fees,v_gross_profit_bps,v_gross_loss_bps,
         v_avg_win_bps,v_avg_loss_bps
    from closed;

  v_win_rate:=case when v_closed>0 then v_wins::numeric/v_closed else 0 end;
  v_pf:=case when v_gross_loss_bps>0 then v_gross_profit_bps/v_gross_loss_bps
             when v_gross_profit_bps>0 then 999 else 0 end;
  v_break_even:=case when v_avg_win_bps+v_avg_loss_bps>0
    then v_avg_loss_bps/(v_avg_win_bps+v_avg_loss_bps) else 0 end;

  -- Legacy shadows use a six-hour horizon. They are excluded from the 180-second mission.
  select
    count(*) filter(where upper(coalesce(decision,''))='BUY'),
    count(*) filter(where upper(coalesce(decision,''))='BUY' and coalesce(realized_return,0)>0),
    count(*) filter(where upper(coalesce(s.decision,''))='BUY' and coalesce(s.realized_return,0)>0
      and exists(select 1 from public.trading_positions p where p.candidate_id=s.candidate_id and p.is_paper=false))
    into v_shadow_buy,v_shadow_profitable,v_shadow_captured
    from public.scalp_shadow_outcomes s
   where lower(s.exchange)=v_exchange
     and s.scanned_at>=v_eval_start and s.scanned_at<v_period_end
     and coalesce(s.model_version,'') like '6.12.%'
     and coalesce(s.expected_holding_minutes,999)<=6;

  v_shadow_missed:=greatest(0,v_shadow_profitable-v_shadow_captured);
  v_capture:=case when v_shadow_profitable>0 then v_shadow_captured::numeric/v_shadow_profitable else 1 end;
  v_ready:=v_closed>=5;
  v_activity_pass:=v_entries>=v_required;
  v_profitability_pass:=v_ready and v_net>0 and v_pf>=cfg.lob_mission_min_profit_factor;
  v_win_pass:=v_ready and v_win_rate>v_break_even;
  v_capture_pass:=v_shadow_profitable<5 or v_capture>=cfg.lob_mission_min_capture_rate;
  v_mission_pass:=v_ready and v_activity_pass and v_profitability_pass and v_win_pass and v_capture_pass;

  update public.trading_mission_scorecards
     set qualified_opportunities=v_qualified,entry_attempts=v_attempts,entries=v_entries,
         required_entries=v_required,participation_rate=v_participation,
         closed_trades=v_closed,wins=v_wins,win_rate=v_win_rate,break_even_win_rate=v_break_even,
         net_pnl_quote=v_net,mean_net_bps=v_mean_bps,profit_factor=v_pf,paid_fees_quote=v_fees,
         shadow_buy_opportunities=v_shadow_buy,shadow_profitable_opportunities=v_shadow_profitable,
         captured_profitable_opportunities=v_shadow_captured,missed_profitable_opportunities=v_shadow_missed,
         opportunity_capture_rate=v_capture,evaluation_ready=v_ready,activity_pass=v_activity_pass,
         profitability_pass=v_profitability_pass,win_rate_pass=v_win_pass,capture_pass=v_capture_pass,
         mission_pass=v_mission_pass,mission_revision='6.12.2-MISSION-EPOCH',
         metrics=jsonb_build_object(
           'evaluation_start',v_eval_start,
           'anti_gaming',jsonb_build_object('qualified_opportunities',v_qualified,'required_entries',v_required,
             'actual_entries',v_entries,'participation_floor',cfg.lob_mission_participation_floor,
             'trade_rate_ratio_floor',cfg.lob_mission_min_trade_rate_ratio,
             'turnover_ratio_floor',cfg.lob_mission_min_turnover_ratio),
           'economic_objective',jsonb_build_object('net_pnl_quote',v_net,'mean_net_bps',v_mean_bps,
             'profit_factor',v_pf,'win_rate',v_win_rate,'break_even_win_rate',v_break_even,
             'opportunity_capture_rate',v_capture),
           'capture_basis','V6.12_LOB_SHADOW_MAX_6_MINUTES_ONLY'
         ),captured_at=now()
   where period_type=v_type and exchange=v_exchange and period_start=v_period_start
   returning * into row_out;
  return to_jsonb(row_out);
end;
$$;

revoke all on function public.refresh_trading_mission_scorecard_v6120(text,text,timestamptz)
  from public,anon,authenticated;
revoke all on function public.refresh_trading_mission_scorecard_legacy_v6120(text,text,timestamptz)
  from public,anon,authenticated;

select public.refresh_trading_mission_scorecard_v6120('HOURLY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('HOURLY','binance',now());
select public.refresh_trading_mission_scorecard_v6120('DAILY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('DAILY','binance',now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY','binance',now());