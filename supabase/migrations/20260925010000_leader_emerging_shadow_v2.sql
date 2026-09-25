-- leader-emerging-shadow V2 (LE-SHADOW-2): DISCOVERY + PARITY lanes, ALT GPT V2, WAIT lifecycle,
-- multi-horizon outcomes, lane-aware GPT budget. Everything stays in schema shadow_le.
--
-- No production object is created, altered, granted, revoked or triggered here. The only new
-- production-facing access is NONE: the V2 lanes read the same eight production tables the
-- LE-SHADOW-1 role can already SELECT (gpt_final_entry_reviews, v11_long_regime_positions, ...).
--
-- Separation of real vs hypothetical is enforced by CHECK constraints:
--   * decision_source in (RULE_BASELINE, ALT_GPT, PRODUCTION_GPT, WAIT_RESOLUTION)
--   * actual_trade must be FALSE for every non-production row; PRODUCTION_GPT rows carry NULL
--     (the real trade, if any, is looked up read-only at labeling time and stored on the outcome)
--   * shadow_trade = (decision = 'BUY') for shadow rows, FALSE for PRODUCTION_GPT rows
--   * every row carries is_hypothetical = true

-- ---------------------------------------------------------------- control flags (operator-owned)
alter table shadow_le.control add column if not exists v2_discovery_gpt boolean not null default false;
alter table shadow_le.control add column if not exists v2_parity_enabled boolean not null default false;
alter table shadow_le.control drop constraint if exists control_v2_requires_enabled;
alter table shadow_le.control add constraint control_v2_requires_enabled check (enabled or not (v2_discovery_gpt or v2_parity_enabled));
alter table shadow_le.control_log add column if not exists v2_discovery_gpt boolean;
alter table shadow_le.control_log add column if not exists v2_parity_enabled boolean;
create or replace function shadow_le.log_control() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  insert into shadow_le.control_log(enabled, gpt_enabled, v2_discovery_gpt, v2_parity_enabled, set_by, reason)
  values (new.enabled, new.gpt_enabled, new.v2_discovery_gpt, new.v2_parity_enabled, new.set_by, new.reason);
  return new;
end $$;

-- cycles: V2 run modes
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'shadow_le.cycles'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%mode%' loop
    execute format('alter table shadow_le.cycles drop constraint %I', c);
  end loop;
end $$;
alter table shadow_le.cycles add constraint cycles_mode_check check (mode in ('SCAN','WAIT','OUTCOME','PARITY','V2_WAIT'));

-- ---------------------------------------------------------------- V2 events (one per decision instant)
create table if not exists shadow_le.v2_events (
  event_id bigint generated always as identity primary key,
  lane text not null check (lane in ('DISCOVERY','PARITY')),
  symbol text not null,
  -- DISCOVERY
  cycle_id bigint references shadow_le.cycles(cycle_id),
  candidate_id bigint references shadow_le.candidates(candidate_id),
  scan_lane text check (scan_lane in ('LEADER','EMERGING')),
  -- PARITY (read-only copy of the production FD1 ENTRY snapshot identity; never its answer)
  prod_job_key text,
  prod_signal_id text,
  prod_candidate_id text,
  prod_snapshot_hash text,
  -- time
  candidate_at timestamptz not null,
  snapshot_at timestamptz not null,
  snapshot_offset_ms bigint not null,
  snapshot_source text not null check (snapshot_source in ('SHADOW_LIVE_READ','SHADOW_LIVE_READ_BOOK_REFRESHED','PRODUCTION_PACKET')),
  -- microstructure at the snapshot
  spread_bps double precision,
  bid_depth_25bps_usdt double precision,
  ask_depth_25bps_usdt double precision,
  bid_depth_to_order double precision,
  ask_depth_to_order double precision,
  book_imbalance_25bps double precision,
  max_bid_wall_to_order double precision,
  max_ask_wall_to_order double precision,
  estimated_buy_slippage_bps double precision,
  order_notional_basis_usdt numeric not null,
  micro_complete boolean,
  -- hypothetical entry reference shared by every decision_source of this event
  entry_ref_at timestamptz,
  entry_ref_ask double precision,
  entry_ref_bid double precision,
  entry_ref_mid double precision,
  entry_beyond_ask_bps double precision,
  roundtrip_cost_bps double precision,
  -- evidence
  rank_context jsonb,
  facts jsonb not null,
  axes jsonb not null,
  legacy jsonb,
  hard_safety jsonb not null default '[]'::jsonb,
  prescore jsonb,
  patch text not null,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now(),
  check ((lane = 'DISCOVERY' and candidate_id is not null and cycle_id is not null and scan_lane is not null and prod_job_key is null)
      or (lane = 'PARITY' and prod_job_key is not null and candidate_id is null and snapshot_source = 'PRODUCTION_PACKET')),
  check (snapshot_at >= candidate_at - interval '5 minutes')
);
create unique index if not exists v2_events_parity_uq on shadow_le.v2_events (prod_job_key) where lane = 'PARITY';
create unique index if not exists v2_events_discovery_uq on shadow_le.v2_events (candidate_id) where lane = 'DISCOVERY';
create index if not exists v2_events_time_idx on shadow_le.v2_events (lane, snapshot_at);
create index if not exists v2_events_symbol_idx on shadow_le.v2_events (symbol, snapshot_at);

-- ---------------------------------------------------------------- V2 decisions (every source, every attempt)
create table if not exists shadow_le.v2_decisions (
  decision_id bigint generated always as identity primary key,
  event_id bigint not null references shadow_le.v2_events(event_id),
  lane text not null check (lane in ('DISCOVERY','PARITY')),
  symbol text not null,
  decision_source text not null check (decision_source in ('RULE_BASELINE','ALT_GPT','PRODUCTION_GPT','WAIT_RESOLUTION')),
  attempt smallint not null default 1 check (attempt in (1,2)),
  parent_decision_id bigint references shadow_le.v2_decisions(decision_id),
  decision text not null check (decision in ('BUY','WAIT','SKIP','ABSTAIN','SKIP_DETERMINISTIC')),
  valid boolean not null,
  actual_trade boolean,
  shadow_trade boolean not null,
  phase text,
  overheat_view text,
  reasons jsonb not null default '[]'::jsonb,
  support jsonb not null default '[]'::jsonb,
  override jsonb,
  legacy_negatives jsonb,
  expected_move_bps double precision,
  wait_reason text,
  recheck_trigger jsonb,
  wait_expires_at timestamptz,
  gate text,
  packet jsonb,
  packet_hash text,
  model text,
  prompt_hash text,
  schema_hash text,
  asked_at timestamptz,
  answered_at timestamptz,
  latency_ms integer,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric,
  request_id text,
  error text,
  note text,
  hyp_entry_at timestamptz,
  hyp_entry_ask double precision,
  hyp_entry_basis text check (hyp_entry_basis in ('EVENT_SNAPSHOT_ASK','WAIT_TRIGGER_ASK')),
  hyp_entry_beyond_ask_bps double precision,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now(),
  check ((decision_source = 'PRODUCTION_GPT' and actual_trade is null and shadow_trade = false and lane = 'PARITY')
      or (decision_source <> 'PRODUCTION_GPT' and actual_trade = false and shadow_trade = (decision = 'BUY'))),
  check (decision <> 'WAIT' or (decision_source = 'ALT_GPT' and attempt = 1 and wait_reason is not null and recheck_trigger is not null and wait_expires_at is not null)),
  check (attempt = 1 or parent_decision_id is not null),
  check (decision_source <> 'WAIT_RESOLUTION' or (parent_decision_id is not null and decision = 'SKIP'))
);
create unique index if not exists v2_decisions_uq on shadow_le.v2_decisions (event_id, decision_source, attempt);
create index if not exists v2_decisions_wait_idx on shadow_le.v2_decisions (wait_expires_at) where decision = 'WAIT';
create index if not exists v2_decisions_event_idx on shadow_le.v2_decisions (event_id);

-- ---------------------------------------------------------------- V2 WAIT terminal events
create table if not exists shadow_le.v2_wait_events (
  wait_event_id bigint generated always as identity primary key,
  decision_id bigint not null references shadow_le.v2_decisions(decision_id),
  symbol text not null,
  event text not null check (event in ('TRIGGERED','EXPIRED','INVALIDATED')),
  at timestamptz not null,
  hyp_price double precision,
  detail jsonb not null default '{}'::jsonb,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now()
);
create unique index if not exists v2_wait_events_terminal_uq on shadow_le.v2_wait_events (decision_id);

-- ---------------------------------------------------------------- V2 outcomes
create table if not exists shadow_le.v2_outcomes (
  outcome_id bigint generated always as identity primary key,
  event_id bigint not null references shadow_le.v2_events(event_id),
  decision_id bigint references shadow_le.v2_decisions(decision_id),
  outcome_version text not null,
  entry_basis text not null check (entry_basis in ('EVENT_SNAPSHOT_ASK','WAIT_TRIGGER_ASK')),
  hyp_entry_at timestamptz not null,
  hyp_entry_price double precision not null,
  horizons jsonb not null,
  ret_5m double precision, ret_15m double precision, ret_30m double precision,
  ret_60m double precision, ret_120m double precision, ret_240m double precision,
  mfe_60m double precision, mae_60m double precision, mfe_240m double precision, mae_240m double precision,
  gross_bps_60m double precision, net_bps_60m double precision,
  gross_bps_120m double precision, net_bps_120m double precision,
  gross_bps_240m double precision, net_bps_240m double precision,
  roundtrip_cost_bps double precision,
  cost_basis text not null check (cost_basis in ('NET_ESTIMATED','GROSS_ONLY')),
  cost jsonb not null,
  data_complete boolean not null,
  -- production reality, read-only lookup at labeling time (PARITY: by signal id; DISCOVERY: symbol window)
  prod_reviewed boolean,
  prod_actual_trade boolean,
  prod_position_id uuid,
  prod_position_state text,
  prod_realized_pnl_usdt numeric,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now(),
  check ((decision_id is null and entry_basis = 'EVENT_SNAPSHOT_ASK') or (decision_id is not null and entry_basis = 'WAIT_TRIGGER_ASK'))
);
create unique index if not exists v2_outcomes_event_uq on shadow_le.v2_outcomes (event_id) where decision_id is null;
create unique index if not exists v2_outcomes_decision_uq on shadow_le.v2_outcomes (decision_id) where decision_id is not null;

-- ---------------------------------------------------------------- V2 GPT budget (lane-aware)
create table if not exists shadow_le.v2_budget (
  entry_id bigint generated always as identity primary key,
  utc_day date not null,
  lane text not null check (lane in ('DISCOVERY','PARITY')),
  kind text not null check (kind in ('RESERVE','SETTLE')),
  reservation_id bigint references shadow_le.v2_budget(entry_id),
  calls integer not null check (calls in (0,1)),
  usd numeric not null check (usd >= 0 and usd <= 0.05),
  purpose text,
  created_at timestamptz not null default now(),
  check ((kind = 'RESERVE' and reservation_id is null and calls = 1) or (kind = 'SETTLE' and reservation_id is not null and calls = 0))
);
create unique index if not exists v2_budget_settle_uq on shadow_le.v2_budget (reservation_id) where kind = 'SETTLE';

do $$
declare t text;
begin
  foreach t in array array['v2_events','v2_decisions','v2_wait_events','v2_outcomes','v2_budget'] loop
    execute format('drop trigger if exists %I on shadow_le.%I', t || '_append_only', t);
    execute format('drop trigger if exists %I on shadow_le.%I', t || '_no_truncate', t);
    execute format('create trigger %I before update or delete on shadow_le.%I for each row execute function shadow_le.deny_mutation()', t || '_append_only', t);
    execute format('create trigger %I before truncate on shadow_le.%I for each statement execute function shadow_le.deny_mutation()', t || '_no_truncate', t);
  end loop;
end $$;

create or replace function shadow_le.v2_budget_state(p_lane text, p_day date default (now() at time zone 'utc')::date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('utc_day', p_day, 'lane', p_lane,
    'calls', count(*),
    'spend_usd', coalesce(sum(coalesce(s.usd, r.usd)), 0),
    'inflight', count(*) filter (where s.entry_id is null and r.created_at > now() - interval '20 seconds'))
  from shadow_le.v2_budget r left join shadow_le.v2_budget s on s.kind = 'SETTLE' and s.reservation_id = r.entry_id
  where r.kind = 'RESERVE' and r.utc_day = p_day and r.lane = p_lane
$$;

-- Caps are ceilings fixed here: DISCOVERY 300 calls / 1.50 USD per UTC day, PARITY 200 / 1.00,
-- 3 in flight across both lanes. Exhaustion returns ok=false; the caller records
-- SHADOW_BUDGET_EXHAUSTED and makes no request. Production's own ledger is never touched.
create or replace function shadow_le.v2_budget_reserve(p_lane text, p_usd numeric, p_purpose text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d date := (now() at time zone 'utc')::date; st jsonb; rid bigint; cap_calls int; cap_usd numeric; inflight int;
begin
  if p_lane = 'DISCOVERY' then cap_calls := 300; cap_usd := 1.50;
  elsif p_lane = 'PARITY' then cap_calls := 200; cap_usd := 1.00;
  else raise exception 'SHADOW_V2_BUDGET_LANE'; end if;
  if p_usd is null or p_usd <= 0 or p_usd > 0.05 then raise exception 'SHADOW_V2_BUDGET_RESERVE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtext('shadow_le.v2_budget'));
  st := shadow_le.v2_budget_state(p_lane, d);
  select count(*) into inflight from shadow_le.v2_budget r
   where r.kind = 'RESERVE' and r.created_at > now() - interval '20 seconds'
     and not exists (select 1 from shadow_le.v2_budget s where s.kind = 'SETTLE' and s.reservation_id = r.entry_id);
  if (st->>'calls')::int + 1 > cap_calls then return st || jsonb_build_object('ok', false, 'reason', 'SHADOW_BUDGET_CALLS'); end if;
  if (st->>'spend_usd')::numeric + p_usd > cap_usd then return st || jsonb_build_object('ok', false, 'reason', 'SHADOW_BUDGET_USD'); end if;
  if inflight >= 3 then return st || jsonb_build_object('ok', false, 'reason', 'SHADOW_BUDGET_INFLIGHT'); end if;
  insert into shadow_le.v2_budget(utc_day, lane, kind, calls, usd, purpose) values (d, p_lane, 'RESERVE', 1, p_usd, left(p_purpose, 80)) returning entry_id into rid;
  return shadow_le.v2_budget_state(p_lane, d) || jsonb_build_object('ok', true, 'reservation_id', rid);
end $$;

create or replace function shadow_le.v2_budget_settle(p_reservation_id bigint, p_usd numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r shadow_le.v2_budget;
begin
  select * into r from shadow_le.v2_budget where entry_id = p_reservation_id and kind = 'RESERVE';
  if not found then raise exception 'SHADOW_V2_BUDGET_UNKNOWN_RESERVATION'; end if;
  insert into shadow_le.v2_budget(utc_day, lane, kind, reservation_id, calls, usd, purpose)
  values (r.utc_day, r.lane, 'SETTLE', r.entry_id, 0, greatest(0, least(coalesce(p_usd, r.usd), 0.05)), 'settle')
  on conflict do nothing;
  return shadow_le.v2_budget_state(r.lane, r.utc_day);
end $$;

-- ---------------------------------------------------------------- API usage (shadow vs production), read only
create or replace view shadow_le.v2_api_usage as
with days as (
  select distinct utc_day from shadow_le.v2_budget
  union select distinct utc_day from shadow_le.budget
  union select distinct (created_at at time zone 'utc')::date from public.gpt_final_entry_reviews
   where purpose = 'PRODUCTION' and created_at > now() - interval '14 days')
select d.utc_day,
  (select count(*) from shadow_le.v2_budget b where b.utc_day = d.utc_day and b.kind = 'RESERVE' and b.lane = 'DISCOVERY') discovery_gpt_calls,
  (select count(*) from shadow_le.v2_budget b where b.utc_day = d.utc_day and b.kind = 'RESERVE' and b.lane = 'PARITY') parity_gpt_calls,
  (select count(*) from shadow_le.budget b where b.utc_day = d.utc_day and b.kind = 'RESERVE') shadow_v1_gpt_calls,
  (select count(*) from public.gpt_final_entry_reviews r where r.purpose = 'PRODUCTION' and (r.created_at at time zone 'utc')::date = d.utc_day and r.attempted is not false) production_gpt_calls,
  coalesce((select sum(coalesce(s.usd, r.usd)) from shadow_le.v2_budget r left join shadow_le.v2_budget s on s.kind = 'SETTLE' and s.reservation_id = r.entry_id
    where r.kind = 'RESERVE' and r.utc_day = d.utc_day), 0)
  + coalesce((select sum(coalesce(s.usd, r.usd)) from shadow_le.budget r left join shadow_le.budget s on s.kind = 'SETTLE' and s.reservation_id = r.entry_id
    where r.kind = 'RESERVE' and r.utc_day = d.utc_day), 0) shadow_api_cost,
  coalesce((select sum(r.api_cost_usd) from public.gpt_final_entry_reviews r where r.purpose = 'PRODUCTION' and (r.created_at at time zone 'utc')::date = d.utc_day), 0) production_api_cost
from days d;

-- ---------------------------------------------------------------- comparison
-- Final ALT decision per event: a WAIT is replaced by its terminal resolution (re-ask or
-- deterministic SKIP); a still-open WAIT stays WAIT_OPEN. Entry for a WAIT->BUY is the trigger ask.
create or replace view shadow_le.v2_final as
with alt1 as (select * from shadow_le.v2_decisions where decision_source = 'ALT_GPT' and attempt = 1),
res as (
  select distinct on (d.parent_decision_id) d.parent_decision_id, d.decision_id, d.decision, d.decision_source
  from shadow_le.v2_decisions d where d.parent_decision_id is not null
  order by d.parent_decision_id, d.decision_id)
select e.event_id, e.lane, e.symbol, e.scan_lane, e.candidate_at, e.snapshot_at, e.prod_signal_id,
  p.decision prod_decision,
  rb.decision rule_decision,
  a.decision_id alt_decision_id, a.decision alt_initial, a.phase alt_phase, a.overheat_view alt_overheat_view, a.valid alt_valid, a.error alt_error, a.gate alt_gate,
  case when a.decision is null then null
       when a.decision <> 'WAIT' then a.decision
       when r.decision is null then 'WAIT_OPEN'
       else r.decision end alt_final,
  r.decision_id alt_resolution_decision_id, r.decision_source alt_resolution_source,
  a.wait_reason, a.recheck_trigger, a.wait_expires_at, w.event wait_terminal_event
from shadow_le.v2_events e
left join shadow_le.v2_decisions p on p.event_id = e.event_id and p.decision_source = 'PRODUCTION_GPT'
left join shadow_le.v2_decisions rb on rb.event_id = e.event_id and rb.decision_source = 'RULE_BASELINE'
left join alt1 a on a.event_id = e.event_id
left join res r on r.parent_decision_id = a.decision_id
left join shadow_le.v2_wait_events w on w.decision_id = a.decision_id;

-- Groups 1-10 of the SHADOW V2 specification. DISCOVERY "production seen" = any production FD1
-- review of the same symbol within [snapshot - 15m, snapshot + 30m] (read only).
create or replace view shadow_le.v2_compare as
select f.*,
  case
    when f.lane = 'PARITY' then
      case when f.prod_decision in ('ABSTAIN') or f.alt_final = 'ABSTAIN' then '7_ABSTAIN_RELATED'
           when f.alt_final is null then '0_ALT_NOT_ASKED'
           when f.alt_final = 'WAIT_OPEN' then '0_WAIT_OPEN'
           when f.prod_decision = 'BUY' and f.alt_final = 'BUY' then '1_CURRENT_BUY_ALT_BUY'
           when f.prod_decision = 'BUY' and f.alt_initial = 'WAIT' then '2_CURRENT_BUY_ALT_WAIT'
           when f.prod_decision = 'BUY' then '3_CURRENT_BUY_ALT_SKIP'
           when f.alt_final = 'BUY' and f.alt_initial <> 'WAIT' then '4_CURRENT_SKIP_ALT_BUY'
           when f.alt_initial = 'WAIT' then '5_CURRENT_SKIP_ALT_WAIT'
           else '6_CURRENT_SKIP_ALT_SKIP' end
    else
      case when seen.prod_seen then 'D_PRODUCTION_SEEN'
           when f.alt_final is null then 'D0_ALT_NOT_ASKED'
           when f.alt_final = 'WAIT_OPEN' then 'D0_WAIT_OPEN'
           when f.alt_initial = 'WAIT' then '9_PRODUCTION_NOT_SEEN_ALT_WAIT'
           when f.alt_final = 'BUY' then '8_PRODUCTION_NOT_SEEN_ALT_BUY'
           when f.alt_final = 'ABSTAIN' then 'D7_PRODUCTION_NOT_SEEN_ALT_ABSTAIN'
           else '10_PRODUCTION_NOT_SEEN_ALT_SKIP' end
  end grp,
  seen.prod_seen,
  o.ret_60m, o.ret_120m, o.mfe_60m, o.mae_60m, o.mfe_240m, o.mae_240m,
  o.gross_bps_60m, o.net_bps_60m, o.gross_bps_120m, o.net_bps_120m, o.gross_bps_240m, o.net_bps_240m, o.cost_basis, o.data_complete,
  o.prod_actual_trade, o.prod_realized_pnl_usdt,
  ow.hyp_entry_price wait_entry_price, o.hyp_entry_price event_entry_price,
  ow.net_bps_60m wait_net_bps_60m, ow.net_bps_120m wait_net_bps_120m
from shadow_le.v2_final f
left join lateral (select exists (select 1 from public.gpt_final_entry_reviews r where r.purpose = 'PRODUCTION' and r.symbol = f.symbol
    and r.created_at between f.snapshot_at - interval '15 minutes' and f.snapshot_at + interval '30 minutes') prod_seen) seen on f.lane = 'DISCOVERY'
left join shadow_le.v2_outcomes o on o.event_id = f.event_id and o.decision_id is null
left join shadow_le.v2_outcomes ow on ow.decision_id = f.alt_resolution_decision_id;

-- Group statistics. Horizon 60 or 120 minutes. The outcome of a group is the hypothetical
-- position the ALT decision implies: event-snapshot ask for an immediate BUY, the trigger ask for
-- WAIT->BUY; for non-BUY groups the same numbers describe what was avoided/missed.
-- large winner / loser: gross 120m return >= +300 bps / <= -300 bps at the event snapshot.
create or replace function shadow_le.v2_group_stats(p_from timestamptz default '-infinity', p_to timestamptz default 'infinity', p_horizon integer default 60)
returns table(lane text, grp text, n bigint, n_labeled bigint, win_rate numeric, avg_gross_bps numeric, avg_net_bps numeric, median_net_bps numeric,
  avg_return_bps numeric, median_return_bps numeric, avg_mfe_bps numeric, avg_mae_bps numeric, profit_factor numeric,
  large_winners bigint, large_losers bigint, n_actual_trades bigint)
language sql stable set search_path = '' as $$
  with x as (
    select c.lane, c.grp,
      case when c.alt_final = 'BUY' and c.alt_initial = 'WAIT' then case when p_horizon = 120 then c.wait_net_bps_120m else c.wait_net_bps_60m end
           else case when p_horizon = 120 then c.net_bps_120m else c.net_bps_60m end end net,
      case when p_horizon = 120 then c.gross_bps_120m else c.gross_bps_60m end gross,
      case when p_horizon = 120 then c.ret_120m else c.ret_60m end ret,
      c.mfe_240m, c.mae_240m, c.mfe_60m, c.mae_60m, c.gross_bps_120m g120, c.prod_actual_trade
    from shadow_le.v2_compare c where c.snapshot_at >= p_from and c.snapshot_at < p_to)
  select x.lane, x.grp, count(*), count(x.net),
    round(avg((x.net > 0)::int) filter (where x.net is not null), 3),
    round(avg(x.gross)::numeric, 1), round(avg(x.net)::numeric, 1),
    round((percentile_cont(.5) within group (order by x.net))::numeric, 1),
    round((avg(x.ret) * 1e4)::numeric, 1), round((percentile_cont(.5) within group (order by x.ret) * 1e4)::numeric, 1),
    round((avg(case when p_horizon = 120 then x.mfe_240m else x.mfe_60m end) * 1e4)::numeric, 1),
    round((avg(case when p_horizon = 120 then x.mae_240m else x.mae_60m end) * 1e4)::numeric, 1),
    round((sum(greatest(x.net, 0)) / nullif(sum(greatest(-x.net, 0)), 0))::numeric, 2),
    count(*) filter (where x.g120 >= 300), count(*) filter (where x.g120 <= -300),
    count(*) filter (where x.prod_actual_trade)
  from x group by x.lane, x.grp order by x.lane, x.grp
$$;

-- ---------------------------------------------------------------- privileges (shadow_le only)
alter table shadow_le.v2_events enable row level security;
alter table shadow_le.v2_decisions enable row level security;
alter table shadow_le.v2_wait_events enable row level security;
alter table shadow_le.v2_outcomes enable row level security;
alter table shadow_le.v2_budget enable row level security;
revoke all on shadow_le.v2_events, shadow_le.v2_decisions, shadow_le.v2_wait_events, shadow_le.v2_outcomes, shadow_le.v2_budget,
  shadow_le.v2_api_usage, shadow_le.v2_final, shadow_le.v2_compare from public;
revoke all on function shadow_le.v2_budget_state(text, date), shadow_le.v2_budget_reserve(text, numeric, text),
  shadow_le.v2_budget_settle(bigint, numeric), shadow_le.v2_group_stats(timestamptz, timestamptz, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on shadow_le.v2_events, shadow_le.v2_decisions, shadow_le.v2_wait_events, shadow_le.v2_outcomes, shadow_le.v2_budget, shadow_le.v2_api_usage, shadow_le.v2_final, shadow_le.v2_compare from anon, authenticated';
    execute 'revoke all on function shadow_le.v2_budget_state(text, date), shadow_le.v2_budget_reserve(text, numeric, text), shadow_le.v2_budget_settle(bigint, numeric), shadow_le.v2_group_stats(timestamptz, timestamptz, integer) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on shadow_le.v2_events, shadow_le.v2_decisions, shadow_le.v2_wait_events, shadow_le.v2_outcomes, shadow_le.v2_budget, shadow_le.v2_api_usage, shadow_le.v2_final, shadow_le.v2_compare from service_role';
    execute 'revoke all on function shadow_le.v2_budget_state(text, date), shadow_le.v2_budget_reserve(text, numeric, text), shadow_le.v2_budget_settle(bigint, numeric), shadow_le.v2_group_stats(timestamptz, timestamptz, integer) from service_role';
  end if;
end $$;
grant select, insert on shadow_le.v2_events, shadow_le.v2_decisions, shadow_le.v2_wait_events, shadow_le.v2_outcomes to shadow_le_writer;
grant select on shadow_le.v2_budget, shadow_le.v2_final, shadow_le.v2_compare, shadow_le.v2_api_usage to shadow_le_writer;
grant execute on function shadow_le.v2_budget_state(text, date), shadow_le.v2_budget_reserve(text, numeric, text),
  shadow_le.v2_budget_settle(bigint, numeric), shadow_le.v2_group_stats(timestamptz, timestamptz, integer) to shadow_le_writer;
