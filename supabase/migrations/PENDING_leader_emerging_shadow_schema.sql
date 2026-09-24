-- leader-emerging-shadow (LE-SHADOW-1): order-free Top30 Leader/Emerging observation store.
--
-- Everything lives in schema shadow_le. Nothing here is read by the executor, the signal
-- generator or any trading path. No production table gets a column, trigger, policy or
-- constraint: the only production-facing statements are GRANT SELECT on eight tables to the
-- dedicated role below.
--
-- Guarantees enforced by the database (not by the function's good behaviour):
--   * shadow_le_writer may INSERT/SELECT shadow_le data tables, SELECT eight production
--     tables, and EXECUTE the shadow_le functions. It has no UPDATE/DELETE anywhere and no
--     privilege on any other production table.
--   * every data table is append-only (UPDATE/DELETE/TRUNCATE raise), for every role;
--   * the GPT budget ledger can only grow through shadow_le.budget_reserve/budget_settle,
--     which enforce 250 calls/day, 1.00 USD/day and 2 in-flight requests;
--   * hypothetical values carry the hyp_ prefix and rows carry is_hypothetical=true.
create schema if not exists shadow_le;
revoke all on schema shadow_le from public;

-- Dedicated login role. The password is random, never printed, and kept in Vault for the
-- cron job; the function receives it per request and connects AS this role (no service key).
do $$
declare pw text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not exists (select 1 from pg_roles where rolname = 'shadow_le_writer') then
    execute format('create role shadow_le_writer login noinherit nocreatedb nocreaterole noreplication bypassrls connection limit 6 password %L', pw);
    if exists (select 1 from pg_namespace where nspname = 'vault') then
      perform vault.create_secret(pw, 'leader_emerging_shadow_db_password', 'LE-SHADOW-1 shadow_le_writer login (cron header only)');
    end if;
  end if;
end $$;
alter role shadow_le_writer set statement_timeout = '20s';
alter role shadow_le_writer set idle_in_transaction_session_timeout = '30s';
alter role shadow_le_writer set search_path = shadow_le;

-- ---------------------------------------------------------------- append-only guard
create or replace function shadow_le.deny_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'SHADOW_LE_APPEND_ONLY:%:%', tg_table_name, tg_op;
end $$;

-- ---------------------------------------------------------------- control (singleton, operator-owned)
create table if not exists shadow_le.control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null,
  gpt_enabled boolean not null default false,
  set_by text not null,
  reason text not null,
  updated_at timestamptz not null default now(),
  check (enabled or not gpt_enabled)
);
create table if not exists shadow_le.control_log (
  log_id bigint generated always as identity primary key,
  enabled boolean not null,
  gpt_enabled boolean not null,
  set_by text not null,
  reason text not null,
  logged_at timestamptz not null default now()
);
create or replace function shadow_le.log_control() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  insert into shadow_le.control_log(enabled, gpt_enabled, set_by, reason) values (new.enabled, new.gpt_enabled, new.set_by, new.reason);
  return new;
end $$;
create trigger control_log before insert or update on shadow_le.control for each row execute function shadow_le.log_control();
create trigger control_no_delete before delete on shadow_le.control for each row execute function shadow_le.deny_mutation();
create trigger control_no_truncate before truncate on shadow_le.control for each statement execute function shadow_le.deny_mutation();
insert into shadow_le.control(enabled, gpt_enabled, set_by, reason)
values (true, false, 'migration LE-SHADOW-1', 'Stage 1 only: deterministic arms. GPT stays off until the operator confirms credit/auto-recharge and OPENAI_API_KEY_SHADOW.')
on conflict (singleton) do nothing;

-- ---------------------------------------------------------------- data tables
create table if not exists shadow_le.day_anchor (
  kst_day date primary key,
  day_start timestamptz not null,
  anchor_bucket timestamptz not null,
  anchor_observed_at timestamptz not null,
  anchor_lag_ms bigint not null,
  anchor_quality text not null check (anchor_quality in ('ON_TIME','LATE')),
  source text not null check (source in ('OBSERVER_FIRST_AFTER_1500Z','BOOTSTRAP_OBSERVER')),
  prices jsonb not null,
  n_prices integer not null,
  coin_symbols jsonb not null,
  n_coin integer not null,
  excluded jsonb not null,
  exchange_info_at timestamptz not null,
  patch text not null,
  created_at timestamptz not null default now()
);

create table if not exists shadow_le.cycles (
  cycle_id bigint generated always as identity primary key,
  mode text not null check (mode in ('SCAN','WAIT','OUTCOME')),
  status text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  kst_day date,
  observation_bucket timestamptz,
  observed_at timestamptz,
  source text check (source in ('REGIME_OBSERVER','TICKER')),
  observer_age_ms bigint,
  n_universe integer,
  n_unanchored integer,
  rank_order jsonb,
  top50 jsonb,
  velocity_valid boolean,
  n_leader integer,
  n_emerging integer,
  n_control integer,
  n_shortlist integer,
  arms_active jsonb not null default '[]'::jsonb,
  request_weight integer not null default 0,
  used_weight_max integer,
  binance_status text not null default 'OK',
  gpt_state text,
  gpt_calls integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  patch text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists cycles_scan_bucket_uq on shadow_le.cycles (observation_bucket) where mode = 'SCAN' and status = 'OK';
create index if not exists cycles_mode_time_idx on shadow_le.cycles (mode, started_at desc);
create index if not exists cycles_day_idx on shadow_le.cycles (kst_day, observed_at) where mode = 'SCAN';

create table if not exists shadow_le.candidates (
  candidate_id bigint generated always as identity primary key,
  cycle_id bigint not null references shadow_le.cycles(cycle_id),
  observed_at timestamptz not null,
  kst_day date not null,
  symbol text not null,
  lane text not null check (lane in ('LEADER','EMERGING','CONTROL')),
  rank_now integer not null,
  rank_15m integer,
  rank_30m integer,
  rank_60m integer,
  rank_velocity_15m integer,
  rank_velocity_60m integer,
  velocity_valid boolean not null,
  minutes_since_kst_midnight integer not null,
  first_top3_today boolean not null,
  leader_reentry_60m boolean not null,
  first_top10_today boolean not null,
  first_top10_at timestamptz,
  minutes_in_top10_today integer not null,
  day_return_live double precision not null,
  obs_price double precision not null,
  shortlisted boolean not null,
  selection_reason text not null,
  vr15 double precision,
  v17 jsonb,
  b06133 jsonb,
  v30 jsonb,
  cec_readonly jsonb,
  facts jsonb,
  micro_complete boolean,
  cost jsonb,
  soft_categories jsonb,
  hard_block jsonb,
  alt_score_v1 jsonb,
  alt_score_v2 jsonb,
  read_errors jsonb,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now(),
  unique (cycle_id, symbol)
);
create index if not exists candidates_symbol_time_idx on shadow_le.candidates (symbol, observed_at desc);
create index if not exists candidates_short_idx on shadow_le.candidates (observed_at desc) where shortlisted;

create table if not exists shadow_le.decisions (
  decision_id bigint generated always as identity primary key,
  candidate_id bigint not null references shadow_le.candidates(candidate_id),
  cycle_id bigint not null references shadow_le.cycles(cycle_id),
  symbol text not null,
  arm text not null check (arm in ('RULE_BASELINE','TAKE_ALL','GPT_ALT1','WAIT_MECHANICAL')),
  attempt smallint not null default 1 check (attempt in (1,2)),
  parent_decision_id bigint references shadow_le.decisions(decision_id),
  decision text not null check (decision in ('BUY','WAIT','SKIP','ABSTAIN','SKIP_DETERMINISTIC')),
  valid boolean not null,
  reasons jsonb not null default '[]'::jsonb,
  support jsonb not null default '[]'::jsonb,
  expected_move_bps double precision,
  wait_trigger jsonb,
  wait_expires_at timestamptz,
  packet jsonb,
  packet_hash text,
  model text,
  prompt_hash text,
  schema_hash text,
  snapshot_at timestamptz not null,
  answered_at timestamptz,
  latency_ms integer,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric,
  request_id text,
  error text,
  hyp_entry_at timestamptz,
  hyp_entry_ask double precision,
  hyp_entry_mid double precision,
  hyp_spread_bps double precision,
  hyp_slip_bps_600 double precision,
  hyp_slip_bps_450 double precision,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now(),
  check (decision <> 'WAIT' or (arm = 'GPT_ALT1' and attempt = 1 and wait_trigger is not null and wait_expires_at is not null)),
  check (attempt = 1 or parent_decision_id is not null)
);
create unique index if not exists decisions_arm_uq on shadow_le.decisions (candidate_id, arm, attempt);
create index if not exists decisions_wait_idx on shadow_le.decisions (wait_expires_at) where decision = 'WAIT';

create table if not exists shadow_le.wait_events (
  event_id bigint generated always as identity primary key,
  decision_id bigint not null references shadow_le.decisions(decision_id),
  symbol text not null,
  event text not null check (event in ('TRIGGERED','EXPIRED','INVALIDATED')),
  at timestamptz not null,
  hyp_price double precision,
  detail jsonb not null default '{}'::jsonb,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now()
);
-- one terminal event per WAIT
create unique index if not exists wait_events_terminal_uq on shadow_le.wait_events (decision_id);

create table if not exists shadow_le.outcomes (
  outcome_id bigint generated always as identity primary key,
  candidate_id bigint not null references shadow_le.candidates(candidate_id),
  decision_id bigint references shadow_le.decisions(decision_id),
  outcome_version text not null,
  entry_ref text not null check (entry_ref in ('ASK_AT_DECISION','ASK_AFTER_ANSWER','ASK_AT_WAIT_TRIGGER','OBSERVER_PRICE')),
  hyp_entry_at timestamptz not null,
  hyp_entry_price double precision not null,
  hyp_fwd_5m double precision,
  hyp_fwd_15m double precision,
  hyp_fwd_30m double precision,
  hyp_fwd_60m double precision,
  hyp_fwd_120m double precision,
  hyp_fwd_240m double precision,
  hyp_mfe_60 double precision,
  hyp_mae_60 double precision,
  hyp_mfe_240 double precision,
  hyp_mae_240 double precision,
  hyp_sim_exit_reason text,
  hyp_sim_hold_min double precision,
  hyp_sim_gross_bps double precision,
  hyp_sim_net_bps_real double precision,
  hyp_sim_net_bps_stress44 double precision,
  hyp_net_bps_real_60m double precision,
  hyp_net_bps_real_120m double precision,
  hyp_net_bps_stress44_60m double precision,
  hyp_net_bps_stress44_120m double precision,
  hyp_net_usdt_600 double precision,
  hyp_cost_bps_real double precision,
  hyp_cost_bps_real_450 double precision,
  cost jsonb not null default '{}'::jsonb,
  sim jsonb,
  data_complete boolean not null,
  is_hypothetical boolean not null default true check (is_hypothetical),
  created_at timestamptz not null default now()
);
create unique index if not exists outcomes_candidate_ref_uq on shadow_le.outcomes (candidate_id, entry_ref) where decision_id is null;
create unique index if not exists outcomes_decision_uq on shadow_le.outcomes (decision_id) where decision_id is not null;

create table if not exists shadow_le.production_link (
  link_id bigint generated always as identity primary key,
  candidate_id bigint not null references shadow_le.candidates(candidate_id),
  link_stage text not null check (link_stage in ('WINDOW','FINAL')),
  symbol text not null,
  observed_at timestamptz not null,
  window_from timestamptz not null,
  window_to timestamptz not null,
  prod_signal_ids jsonb not null default '[]'::jsonb,
  prod_signal_status jsonb not null default '[]'::jsonb,
  prod_reject_reasons jsonb not null default '[]'::jsonb,
  prod_setup_states jsonb not null default '[]'::jsonb,
  prod_v30_admitted boolean,
  prod_gpt_decisions jsonb not null default '[]'::jsonb,
  prod_gpt_buy boolean not null,
  prod_order_ids jsonb not null default '[]'::jsonb,
  prod_position_id uuid,
  prod_entered boolean not null,
  prod_position_state text,
  prod_entry_price numeric,
  prod_realized_pnl_usdt numeric,
  linked_at timestamptz not null default now(),
  unique (candidate_id, link_stage)
);

create table if not exists shadow_le.budget (
  entry_id bigint generated always as identity primary key,
  utc_day date not null,
  kind text not null check (kind in ('RESERVE','SETTLE')),
  reservation_id bigint references shadow_le.budget(entry_id),
  calls integer not null check (calls in (0,1)),
  usd numeric not null check (usd >= 0 and usd <= 0.05),
  purpose text,
  created_at timestamptz not null default now(),
  check ((kind = 'RESERVE' and reservation_id is null and calls = 1) or (kind = 'SETTLE' and reservation_id is not null and calls = 0))
);
create unique index if not exists budget_settle_uq on shadow_le.budget (reservation_id) where kind = 'SETTLE';

do $$
declare t text;
begin
  foreach t in array array['day_anchor','cycles','candidates','decisions','wait_events','outcomes','production_link','budget','control_log'] loop
    execute format('create trigger %I before update or delete on shadow_le.%I for each row execute function shadow_le.deny_mutation()', t || '_append_only', t);
    execute format('create trigger %I before truncate on shadow_le.%I for each statement execute function shadow_le.deny_mutation()', t || '_no_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- GPT budget (definer functions only)
create or replace function shadow_le.budget_state(p_day date default (now() at time zone 'utc')::date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('utc_day', p_day,
    'calls', count(*),
    'spend_usd', coalesce(sum(coalesce(s.usd, r.usd)), 0),
    'inflight', count(*) filter (where s.entry_id is null and r.created_at > now() - interval '20 seconds'))
  from shadow_le.budget r left join shadow_le.budget s on s.kind = 'SETTLE' and s.reservation_id = r.entry_id
  where r.kind = 'RESERVE' and r.utc_day = p_day
$$;

create or replace function shadow_le.budget_reserve(p_usd numeric, p_purpose text,
  p_cap_calls integer default 250, p_cap_usd numeric default 1.00, p_max_inflight integer default 2)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d date := (now() at time zone 'utc')::date; st jsonb; rid bigint;
begin
  if p_usd is null or p_usd <= 0 or p_usd > 0.05 then raise exception 'SHADOW_BUDGET_RESERVE_INVALID'; end if;
  -- the pre-registered caps are ceilings: a caller may ask for less, never more
  if p_cap_calls is null or p_cap_calls < 0 or p_cap_calls > 250 or p_cap_usd is null or p_cap_usd < 0 or p_cap_usd > 1.00
     or p_max_inflight is null or p_max_inflight < 0 or p_max_inflight > 2 then
    raise exception 'SHADOW_BUDGET_CAP_ABOVE_REGISTERED';
  end if;
  perform pg_advisory_xact_lock(hashtext('shadow_le.budget'));
  st := shadow_le.budget_state(d);
  if (st->>'calls')::int + 1 > p_cap_calls then return st || jsonb_build_object('ok', false, 'reason', 'SHADOW_BUDGET_CALLS'); end if;
  if (st->>'spend_usd')::numeric + p_usd > p_cap_usd then return st || jsonb_build_object('ok', false, 'reason', 'SHADOW_BUDGET_USD'); end if;
  if (st->>'inflight')::int >= p_max_inflight then return st || jsonb_build_object('ok', false, 'reason', 'SHADOW_BUDGET_INFLIGHT'); end if;
  insert into shadow_le.budget(utc_day, kind, calls, usd, purpose) values (d, 'RESERVE', 1, p_usd, left(p_purpose, 80)) returning entry_id into rid;
  return shadow_le.budget_state(d) || jsonb_build_object('ok', true, 'reservation_id', rid);
end $$;

create or replace function shadow_le.budget_settle(p_reservation_id bigint, p_usd numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r shadow_le.budget;
begin
  select * into r from shadow_le.budget where entry_id = p_reservation_id and kind = 'RESERVE';
  if not found then raise exception 'SHADOW_BUDGET_UNKNOWN_RESERVATION'; end if;
  insert into shadow_le.budget(utc_day, kind, reservation_id, calls, usd, purpose)
  values (r.utc_day, 'SETTLE', r.entry_id, 0, greatest(0, least(coalesce(p_usd, r.usd), 0.05)), 'settle')
  on conflict do nothing;
  return shadow_le.budget_state(r.utc_day);
end $$;

-- ---------------------------------------------------------------- production stand-down (read only)
-- GPT stand-down evidence: production FD1 errors/quota in the last 60 minutes and today's
-- production ledger calls. Invoker rights: runs with the caller's SELECT grants.
create or replace function shadow_le.production_gpt_health()
returns jsonb language sql stable set search_path = '' as $$
  with r as (
    select error, valid, attempted, record->'result'->'error_detail'->>'code' code, record->'result'->>'http_status' http
    from public.gpt_final_entry_reviews
    where purpose = 'PRODUCTION' and created_at > now() - interval '60 minutes')
  select jsonb_build_object(
    'n_60m', (select count(*) from r where attempted is not false),
    'n_err_60m', (select count(*) from r where error is not null and error ~ '^(HTTP_|API_TIMEOUT|FD_API)'),
    'n_quota_60m', (select count(*) from r where error ~ '^HTTP_429' or http = '429' or code in ('insufficient_quota','rate_limit_exceeded')),
    'ledger_calls_today', coalesce((select calls from public.gpt_final_review_daily_budget where utc_day = (now() at time zone 'utc')::date), 0))
$$;

-- ---------------------------------------------------------------- observer labels (weight 0)
-- Every top30 candidate not labeled precisely gets forward returns from the regime observer's
-- 5-minute prices (nearest snapshot within 150 s of each horizon). Invoker rights.
create or replace function shadow_le.label_observer_outcomes(p_cycles integer default 8)
returns integer language plpgsql set search_path = '' as $$
declare n integer;
begin
  with cyc as (
    select c.cycle_id, c.observed_at from shadow_le.cycles c
    where c.mode = 'SCAN' and c.status = 'OK' and c.observed_at < now() - interval '245 minutes'
      and exists (select 1 from shadow_le.candidates k where k.cycle_id = c.cycle_id
        and not exists (select 1 from shadow_le.outcomes o where o.candidate_id = k.candidate_id and o.entry_ref = 'OBSERVER_PRICE'))
    order by c.observed_at limit greatest(1, least(p_cycles, 24))),
  cand as (
    select k.candidate_id, k.cycle_id, k.symbol, k.obs_price, k.observed_at
    from shadow_le.candidates k join cyc on cyc.cycle_id = k.cycle_id
    where not exists (select 1 from shadow_le.outcomes o where o.candidate_id = k.candidate_id and o.entry_ref = 'OBSERVER_PRICE')),
  snaps as materialized (
    select cyc.cycle_id, extract(epoch from o.observed_at - cyc.observed_at) / 60.0 as m, o.liquid_prices
    from cyc join public.market_regime_observations o
      on o.model_revision = 'MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
     and o.observed_at > cyc.observed_at and o.observed_at <= cyc.observed_at + interval '242.5 minutes'),
  px as materialized (
    select cand.candidate_id, s.m, (s.liquid_prices ->> ('BF:' || cand.symbol))::float8 p
    from cand join snaps s on s.cycle_id = cand.cycle_id),
  h as (
    select cand.candidate_id, x.hz,
      (select q.p from px q where q.candidate_id = cand.candidate_id and abs(q.m - x.hz) <= 2.5 and q.p > 0 order by abs(q.m - x.hz) limit 1) p
    from cand cross join unnest(array[5,15,30,60,120,240]) x(hz)),
  agg as (
    select cand.candidate_id, cand.observed_at, cand.obs_price,
      max(case when h.hz = 5 then h.p end) / cand.obs_price - 1 f5,
      max(case when h.hz = 15 then h.p end) / cand.obs_price - 1 f15,
      max(case when h.hz = 30 then h.p end) / cand.obs_price - 1 f30,
      max(case when h.hz = 60 then h.p end) / cand.obs_price - 1 f60,
      max(case when h.hz = 120 then h.p end) / cand.obs_price - 1 f120,
      max(case when h.hz = 240 then h.p end) / cand.obs_price - 1 f240,
      count(h.p) n_h
    from cand left join h on h.candidate_id = cand.candidate_id group by cand.candidate_id, cand.observed_at, cand.obs_price),
  ext as (
    select px.candidate_id,
      max(px.p) filter (where px.m <= 62.5) mx60, min(px.p) filter (where px.m <= 62.5) mn60, max(px.p) mx240, min(px.p) mn240
    from px where px.p > 0 group by px.candidate_id),
  ins as (
    insert into shadow_le.outcomes(candidate_id, outcome_version, entry_ref, hyp_entry_at, hyp_entry_price,
      hyp_fwd_5m, hyp_fwd_15m, hyp_fwd_30m, hyp_fwd_60m, hyp_fwd_120m, hyp_fwd_240m,
      hyp_mfe_60, hyp_mae_60, hyp_mfe_240, hyp_mae_240,
      hyp_net_bps_real_60m, hyp_net_bps_real_120m, hyp_net_bps_stress44_60m, hyp_net_bps_stress44_120m,
      hyp_cost_bps_real, cost, data_complete)
    select a.candidate_id, 'LE_OBSERVER_LABEL_1', 'OBSERVER_PRICE', a.observed_at, a.obs_price,
      a.f5, a.f15, a.f30, a.f60, a.f120, a.f240,
      e.mx60 / a.obs_price - 1, e.mn60 / a.obs_price - 1, e.mx240 / a.obs_price - 1, e.mn240 / a.obs_price - 1,
      a.f60 * 1e4 - 20, a.f120 * 1e4 - 20, a.f60 * 1e4 - 44, a.f120 * 1e4 - 44, 20,
      jsonb_build_object('basis', 'observer 5m price, no book: fees 5+5, assumed entry slip 5, exit slip 5', 'fee_bps', 10, 'entry_slip_bps', 5, 'exit_slip_bps', 5, 'stress_bps', 44),
      a.n_h = 6
    from agg a left join ext e on e.candidate_id = a.candidate_id
    on conflict do nothing
    returning 1)
  select count(*) into n from ins;
  return n;
end $$;

-- ---------------------------------------------------------------- production link (read only on production)
-- For every candidate older than 45 minutes: what production did with the same symbol in
-- [observed_at - 15m, observed_at + 30m]. FINAL once no production position from that window
-- is still open; WINDOW (snapshot) while one is. Invoker rights.
create or replace function shadow_le.link_production(p_limit integer default 1500)
returns integer language plpgsql set search_path = '' as $$
declare n integer;
begin
  with c as (
    select k.candidate_id, k.symbol, k.observed_at, k.observed_at - interval '15 minutes' wf, k.observed_at + interval '30 minutes' wt
    from shadow_le.candidates k
    where k.observed_at < now() - interval '45 minutes'
      and not exists (select 1 from shadow_le.production_link l where l.candidate_id = k.candidate_id and l.link_stage = 'FINAL')
    order by k.observed_at limit greatest(1, least(p_limit, 5000))),
  j as (
    select c.*,
      (select coalesce(jsonb_agg(s.id order by s.created_at), '[]') from public.v11_long_regime_signals s where s.symbol = c.symbol and s.created_at between c.wf and c.wt) sig_ids,
      (select coalesce(jsonb_agg(s.status order by s.created_at), '[]') from public.v11_long_regime_signals s where s.symbol = c.symbol and s.created_at between c.wf and c.wt) sig_status,
      (select coalesce(jsonb_agg(s.reject_reason order by s.created_at) filter (where s.reject_reason is not null), '[]') from public.v11_long_regime_signals s where s.symbol = c.symbol and s.created_at between c.wf and c.wt) sig_rej,
      (select coalesce(jsonb_agg(s.features->'v17Setup'->>'state' order by s.created_at) filter (where s.features ? 'v17Setup'), '[]') from public.v11_long_regime_signals s where s.symbol = c.symbol and s.created_at between c.wf and c.wt) setup,
      (select bool_or((s.features->'v30Front'->>'admitted')::boolean) from public.v11_long_regime_signals s where s.symbol = c.symbol and s.created_at between c.wf and c.wt and jsonb_typeof(s.features->'v30Front') = 'object') v30,
      (select coalesce(jsonb_agg(r.decision order by r.created_at), '[]') from public.gpt_final_entry_reviews r where r.purpose = 'PRODUCTION' and r.symbol = c.symbol and r.created_at between c.wf and c.wt) gpt,
      (select coalesce(bool_or(r.decision = 'BUY'), false) from public.gpt_final_entry_reviews r where r.purpose = 'PRODUCTION' and r.symbol = c.symbol and r.created_at between c.wf and c.wt) gpt_buy,
      (select coalesce(jsonb_agg(o.id order by o.created_at), '[]') from public.v11_long_regime_orders o where o.symbol = c.symbol and o.intent = 'OPEN_LONG' and o.created_at between c.wf and c.wt) ord,
      (select to_jsonb(p) from (select p.id, p.state, p.entry_price, p.realized_pnl_usdt from public.v11_long_regime_positions p
         where p.symbol = c.symbol and p.entry_at between c.wf and c.wt order by p.entry_at limit 1) p) pos
    from c),
  ins as (
    insert into shadow_le.production_link(candidate_id, link_stage, symbol, observed_at, window_from, window_to,
      prod_signal_ids, prod_signal_status, prod_reject_reasons, prod_setup_states, prod_v30_admitted,
      prod_gpt_decisions, prod_gpt_buy, prod_order_ids, prod_position_id, prod_entered, prod_position_state,
      prod_entry_price, prod_realized_pnl_usdt)
    select j.candidate_id, case when j.pos is not null and j.pos->>'state' <> 'CLOSED' then 'WINDOW' else 'FINAL' end,
      j.symbol, j.observed_at, j.wf, j.wt, j.sig_ids, j.sig_status, j.sig_rej, j.setup, j.v30, j.gpt, j.gpt_buy, j.ord,
      (j.pos->>'id')::uuid, j.pos is not null, j.pos->>'state', (j.pos->>'entry_price')::numeric,
      case when j.pos->>'state' = 'CLOSED' then (j.pos->>'realized_pnl_usdt')::numeric end
    from j
    on conflict (candidate_id, link_stage) do nothing
    returning 1)
  select count(*) into n from ins;
  return n;
end $$;

-- ---------------------------------------------------------------- comparison view (5 groups)
create or replace view shadow_le.v_arm_final as
with d as (
  select d.*, row_number() over (partition by d.candidate_id, d.arm order by d.attempt desc, d.decision_id desc) rn
  from shadow_le.decisions d)
select candidate_id, arm, decision_id, attempt,
  case when decision = 'SKIP_DETERMINISTIC' then 'SKIP' else decision end as final_decision, decision as raw_decision
from d where rn = 1;

create or replace view shadow_le.v_compare as
with arms as (
  select c.cycle_id, a.arm from shadow_le.cycles c cross join lateral jsonb_array_elements_text(c.arms_active) a(arm) where c.mode = 'SCAN'),
base as (
  select k.candidate_id, k.cycle_id, k.observed_at, k.kst_day, k.symbol, k.lane, k.rank_now, k.shortlisted, a.arm,
    case when not k.shortlisted then 'NOT_SHORTLISTED' else coalesce(f.final_decision, 'NONE') end alt_decision,
    f.decision_id alt_decision_id,
    l.link_stage, coalesce(l.prod_gpt_buy, false) or coalesce(l.prod_entered, false) current_buy, l.prod_realized_pnl_usdt
  from shadow_le.candidates k join arms a on a.cycle_id = k.cycle_id
  left join shadow_le.v_arm_final f on f.candidate_id = k.candidate_id and f.arm = a.arm
  left join lateral (select * from shadow_le.production_link l where l.candidate_id = k.candidate_id order by (l.link_stage = 'FINAL') desc limit 1) l on true)
select b.*,
  case when b.link_stage is null then '0_NOT_LINKED_YET'
       when b.current_buy and b.alt_decision = 'BUY' then '1_CURRENT_BUY_ALT_BUY'
       when b.current_buy then '2_CURRENT_BUY_ALT_SKIP_WAIT'
       when b.alt_decision = 'BUY' then '3_CURRENT_SKIP_OR_NOT_SEEN_ALT_BUY'
       when b.alt_decision = 'WAIT' then '4_CURRENT_SKIP_OR_NOT_SEEN_ALT_WAIT'
       else '5_BOTH_EXCLUDED' end as grp,
  o.entry_ref, o.hyp_entry_price, o.hyp_fwd_60m, o.hyp_fwd_120m, o.hyp_mfe_60, o.hyp_mae_60, o.hyp_mfe_240, o.hyp_mae_240,
  o.hyp_net_bps_real_60m, o.hyp_net_bps_real_120m, o.hyp_net_bps_stress44_60m, o.hyp_net_bps_stress44_120m,
  o.hyp_sim_net_bps_real, o.hyp_sim_net_bps_stress44, o.hyp_sim_exit_reason, o.data_complete
from base b
left join lateral (
  select o.* from shadow_le.outcomes o
  where (o.decision_id = b.alt_decision_id) or (o.candidate_id = b.candidate_id and o.decision_id is null)
  order by case when o.decision_id = b.alt_decision_id then 0 when o.entry_ref = 'ASK_AT_DECISION' then 1 else 2 end
  limit 1) o on true;

-- 1-slot capacity portfolio: BUYs of one arm taken in time order only when the single slot is
-- free (the previous simulated trade has exited). Read-only.
create or replace function shadow_le.portfolio_1slot(p_arm text, p_from timestamptz, p_to timestamptz default now())
returns table(decision_id bigint, symbol text, entry_at timestamptz, exit_at timestamptz, net_bps_real double precision,
  net_bps_stress44 double precision, taken boolean)
language plpgsql stable set search_path = '' as $$
declare r record; busy_until timestamptz := '-infinity';
begin
  for r in
    select f.decision_id, d.symbol, o.hyp_entry_at, o.hyp_entry_at + make_interval(secs => coalesce(o.hyp_sim_hold_min, 240) * 60) ex,
      o.hyp_sim_net_bps_real, o.hyp_sim_net_bps_stress44
    from shadow_le.v_arm_final f join shadow_le.decisions d on d.decision_id = f.decision_id
    join lateral (select o.* from shadow_le.outcomes o where o.decision_id = f.decision_id or (o.candidate_id = f.candidate_id and o.decision_id is null and o.entry_ref = 'ASK_AT_DECISION')
      order by (o.decision_id is not null) desc limit 1) o on true
    where f.arm = p_arm and f.final_decision = 'BUY' and o.hyp_entry_at between p_from and p_to and o.hyp_sim_net_bps_real is not null
    order by o.hyp_entry_at
  loop
    decision_id := r.decision_id; symbol := r.symbol; entry_at := r.hyp_entry_at; exit_at := r.ex;
    net_bps_real := r.hyp_sim_net_bps_real; net_bps_stress44 := r.hyp_sim_net_bps_stress44;
    taken := r.hyp_entry_at >= busy_until;
    if taken then busy_until := r.ex; end if;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on all tables in schema shadow_le from public;
revoke all on all functions in schema shadow_le from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema shadow_le from anon, authenticated';
    execute 'revoke all on all tables in schema shadow_le from anon, authenticated';
    execute 'revoke all on all functions in schema shadow_le from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on all tables in schema shadow_le from service_role';
    execute 'revoke all on all functions in schema shadow_le from service_role';
  end if;
end $$;
alter table shadow_le.control enable row level security;
alter table shadow_le.control_log enable row level security;
alter table shadow_le.day_anchor enable row level security;
alter table shadow_le.cycles enable row level security;
alter table shadow_le.candidates enable row level security;
alter table shadow_le.decisions enable row level security;
alter table shadow_le.wait_events enable row level security;
alter table shadow_le.outcomes enable row level security;
alter table shadow_le.production_link enable row level security;
alter table shadow_le.budget enable row level security;

grant usage on schema shadow_le to shadow_le_writer;
grant usage on schema public to shadow_le_writer;
grant select, insert on shadow_le.day_anchor, shadow_le.cycles, shadow_le.candidates, shadow_le.decisions,
  shadow_le.wait_events, shadow_le.outcomes, shadow_le.production_link to shadow_le_writer;
grant select on shadow_le.control, shadow_le.budget, shadow_le.v_arm_final, shadow_le.v_compare to shadow_le_writer;
grant execute on function shadow_le.budget_state(date), shadow_le.budget_reserve(numeric, text, integer, numeric, integer),
  shadow_le.budget_settle(bigint, numeric), shadow_le.production_gpt_health(),
  shadow_le.label_observer_outcomes(integer), shadow_le.link_production(integer) to shadow_le_writer;
-- read-only production inputs (the role has no other privilege on production objects)
grant select on public.market_regime_observations, public.v17_market_scan_runs, public.v11_cec0040_state,
  public.v11_long_regime_signals, public.v11_long_regime_orders, public.v11_long_regime_positions,
  public.gpt_final_entry_reviews, public.gpt_final_review_daily_budget to shadow_le_writer;
