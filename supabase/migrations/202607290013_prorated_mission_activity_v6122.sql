-- v6.12.2 prorated activity governance.
--
-- Daily/weekly activity goals are full-period goals. Applying all 8 daily or 40 weekly trades
-- in the first minutes of a period would itself game the mission by forcing marginal entries.
-- Keep the 20% qualified-opportunity floor live immediately, while prorating the fixed
-- period goal by elapsed mission time.

create or replace function public.normalize_partial_mission_scorecard_v6122()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  v_eval_start timestamptz;
  v_elapsed_fraction numeric := 1;
  v_period_goal integer := 0;
  v_prorated_goal integer := 0;
  v_opportunity_goal integer := 0;
begin
  if new.mission_revision <> '6.12.2-MISSION-EPOCH' then return new; end if;
  select * into cfg from public.trading_settings where id=1;
  if not found then return new; end if;

  v_eval_start := coalesce(
    public.safe_numeric_v6112(null)::timestamptz,
    null
  );
  begin
    v_eval_start := (new.metrics->>'evaluation_start')::timestamptz;
  exception when others then
    v_eval_start := greatest(new.period_start,cfg.lob_mission_epoch_at);
  end;
  v_eval_start := greatest(coalesce(v_eval_start,new.period_start),new.period_start);

  v_period_goal := case new.period_type
    when 'HOURLY' then cfg.lob_mission_hourly_min_trades
    when 'DAILY' then cfg.lob_mission_daily_min_trades
    when 'WEEKLY' then cfg.lob_mission_weekly_min_trades
    else 0 end;

  if new.period_end > v_eval_start then
    v_elapsed_fraction := least(
      1,
      greatest(
        0,
        extract(epoch from (least(coalesce(new.captured_at,now()),new.period_end)-v_eval_start)) /
        extract(epoch from (new.period_end-v_eval_start))
      )
    );
  end if;
  v_prorated_goal := case
    when v_period_goal<=0 or v_elapsed_fraction<=0 then 0
    else ceil(v_period_goal*v_elapsed_fraction)::integer end;
  v_opportunity_goal := case
    when new.qualified_opportunities>=cfg.lob_mission_min_qualified_opportunities
      then ceil(new.qualified_opportunities*cfg.lob_mission_participation_floor)::integer
    else 0 end;

  new.required_entries := least(
    new.qualified_opportunities,
    greatest(v_prorated_goal,v_opportunity_goal)
  );
  new.activity_pass := new.entries>=new.required_entries;
  new.mission_pass := new.evaluation_ready and new.activity_pass and new.profitability_pass
    and new.win_rate_pass and new.capture_pass;
  new.metrics := coalesce(new.metrics,'{}'::jsonb)||jsonb_build_object(
    'activity_proration',jsonb_build_object(
      'elapsed_fraction',v_elapsed_fraction,
      'full_period_goal',v_period_goal,
      'prorated_goal',v_prorated_goal,
      'qualified_opportunity_goal',v_opportunity_goal,
      'required_entries',new.required_entries
    )
  );
  return new;
end;
$$;

drop trigger if exists trading_mission_scorecards_prorate_v6122
  on public.trading_mission_scorecards;
create trigger trading_mission_scorecards_prorate_v6122
before insert or update on public.trading_mission_scorecards
for each row execute function public.normalize_partial_mission_scorecard_v6122();

revoke all on function public.normalize_partial_mission_scorecard_v6122()
  from public,anon,authenticated;

-- Re-run current periods through the normal scorecard path.
select public.refresh_trading_mission_scorecard_v6120('HOURLY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('HOURLY','binance',now());
select public.refresh_trading_mission_scorecard_v6120('DAILY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('DAILY','binance',now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY','binance',now());
