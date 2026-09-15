-- v6.13.1 SEARCH-HEALTH SOURCE FIX
--
-- Since v6.13 the scanner can correctly return NO_BUY without creating a trading_decisions row.
-- The old mission health function treated that as zero search attempts, so adaptive breadth
-- stayed at 12 books even after hours of NO_BUY scans. Use the actual scanner ledger as the
-- authoritative search-attempt source. Economic entry gates remain unchanged.

create or replace function public.rebalance_lob_mission_activity_v6120()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  v_since timestamptz := now() - interval '1 hour';
  v_attempts integer := 0;
  v_qualified integer := 0;
  v_entries integer := 0;
  v_required integer := 0;
  v_scans integer := 0;
  v_no_buy_scans integer := 0;
  v_latest_scan timestamptz;
  v_activity_deficit boolean := false;
  v_search_failure boolean := false;
  v_prior_activity boolean := false;
  v_prior_search boolean := false;
begin
  perform pg_advisory_xact_lock(6131);
  select * into cfg from public.trading_settings where id=1 for update;
  if not found or not cfg.lob_mission_enabled then
    return jsonb_build_object('changed',false,'reason','MISSION_DISABLED');
  end if;
  if cfg.lob_mission_last_rebalanced_at is not null
     and cfg.lob_mission_last_rebalanced_at > now()-interval '5 minutes' then
    return jsonb_build_object('changed',false,'reason','REBALANCE_COOLDOWN');
  end if;

  select count(*),
         count(*) filter(where coalesce((audit->>'mission_qualified_opportunity')::boolean,false))
    into v_attempts,v_qualified
    from public.trading_decisions
   where upper(coalesce(strategy,audit->>'mission_strategy',audit->>'strategy',''))='LOB_SCALP'
     and created_at>=v_since;

  select count(*),
         count(*) filter(where status='NO_BUY'),
         max(created_at)
    into v_scans,v_no_buy_scans,v_latest_scan
    from public.scanner_scan_runs
   where created_at>=v_since
     and engine_version like '6.13.%';

  select count(*) into v_entries
    from public.trading_positions
   where is_paper=false
     and coalesce(opened_at,created_at)>=v_since
     and state not in ('CANCELLED','ERROR');

  if v_qualified>0 then
    v_required:=greatest(1,least(v_qualified,ceil(v_qualified*cfg.lob_mission_participation_floor)::integer));
  end if;
  v_activity_deficit:=v_qualified>0 and v_entries<v_required;
  v_search_failure:=v_qualified=0 and (
    v_attempts>=cfg.lob_search_min_attempts_hourly
    or (
      v_scans>=cfg.lob_search_min_attempts_hourly
      and v_no_buy_scans=v_scans
      and v_latest_scan>=now()-interval '5 minutes'
    )
  );

  v_prior_activity:=cfg.lob_mission_activity_deficit;
  v_prior_search:=cfg.lob_search_failure;

  update public.trading_settings
     set lob_mission_activity_deficit=v_activity_deficit,
         lob_mission_activity_deficit_streak=case when v_activity_deficit
           then lob_mission_activity_deficit_streak+1 else 0 end,
         lob_search_failure=v_search_failure,
         lob_search_failure_streak=case when v_search_failure
           then lob_search_failure_streak+1 else 0 end,
         lob_search_last_evaluated_at=now(),
         lob_mission_last_rebalanced_at=now(),
         updated_at=now()
   where id=1;

  return jsonb_build_object(
    'changed',v_prior_activity is distinct from v_activity_deficit
      or v_prior_search is distinct from v_search_failure,
    'mission_revision','6.13.1-SEARCH-HEALTH-SOURCE-FIX',
    'decision_attempts_1h',v_attempts,
    'scanner_runs_1h',v_scans,
    'scanner_no_buy_runs_1h',v_no_buy_scans,
    'qualified_opportunities_1h',v_qualified,
    'entries_1h',v_entries,
    'required_entries_1h',v_required,
    'activity_deficit',v_activity_deficit,
    'search_failure',v_search_failure,
    'thresholds_relaxed',false
  );
end;
$$;

create or replace function public.on_scanner_search_health_v6131()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.engine_version like '6.13.%' then
    perform public.rebalance_lob_mission_activity_v6120();
  end if;
  return new;
end;
$$;

drop trigger if exists scanner_scan_runs_search_health_v6131
  on public.scanner_scan_runs;
create trigger scanner_scan_runs_search_health_v6131
after insert on public.scanner_scan_runs
for each row execute function public.on_scanner_search_health_v6131();

revoke all on function public.rebalance_lob_mission_activity_v6120()
  from public,anon,authenticated;
revoke all on function public.on_scanner_search_health_v6131()
  from public,anon,authenticated;

comment on function public.rebalance_lob_mission_activity_v6120() is
  'Search health uses actual scanner runs when NO_BUY produces no decision rows. Never relaxes economic entry gates.';

-- Force one immediate evaluation so the next scanner cycle can widen its observation set.
update public.trading_settings
   set lob_mission_last_rebalanced_at=null,
       updated_at=now()
 where id=1;
select public.rebalance_lob_mission_activity_v6120();
