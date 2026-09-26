begin;
-- Additive, isolated research state. No grants to anon/authenticated; no trading-table updates.
create schema if not exists evolution_private;
revoke all on schema evolution_private from public,anon,authenticated;
create table public.evolution_policy_bundles (
 version text primary key, parent_version text references public.evolution_policy_bundles(version), bundle jsonb not null,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), source_manifest jsonb not null,
 created_at timestamptz not null default now(), data_cutoff timestamptz not null, unique(version,sha256));
create table public.evolution_policy_states(version text primary key references public.evolution_policy_bundles(version),
 state text not null check(state in ('BASELINE','PROPOSED','SIMULATING','VALIDATING','HOLDOUT_TEST','QUALIFIED','PROMOTING','ACTIVE_CHAMPION','REJECTED','REJECTED_SCOPE_VIOLATION','DEGRADED','RETIRED')),
 reason text, updated_at timestamptz not null default now());
create table evolution_private.active_policy(singleton boolean primary key default true check(singleton),
 active_version text not null references public.evolution_policy_bundles(version),previous_version text references public.evolution_policy_bundles(version),
 generation bigint not null default 1,promoted_at timestamptz not null default now(),health_deadline timestamptz,health_confirmed_at timestamptz);
create table public.evolution_jobs(id bigint generated always as identity primary key,dedupe_key text unique not null,
 kind text not null check(kind in ('TRADE_REVIEW','PATTERN_REVIEW','MARKET_SCAN','OUTCOMES','SIMULATE','VALIDATE','MONITOR','FULL_REVIEW')),
 state text not null default 'PENDING' check(state in ('PENDING','RUNNING','DONE','RETRY','FAILED')),
 payload jsonb not null default '{}', result jsonb, priority integer not null default 100,attempts integer not null default 0,
 owner uuid,lease_until timestamptz,available_at timestamptz not null default now(),created_at timestamptz not null default now(),completed_at timestamptz,last_error text);
create index evolution_jobs_due on public.evolution_jobs(priority,available_at,id) where state in ('PENDING','RETRY','RUNNING');
create table public.evolution_reviews(trade_id uuid primary key, dataset_hash text not null, dataset jsonb not null, review jsonb not null,
 created_at timestamptz not null default now(),policy_version text,realized_net_usdt numeric,regime text);
create table public.evolution_patterns(pattern_id text primary key,category text not null,regime text not null,conditions jsonb not null,
 sample_count integer not null,hit_rate numeric,estimated_pnl_impact numeric,confidence numeric,
 supporting_trade_ids jsonb not null,contradicting_trade_ids jsonb not null,status text not null check(status in ('ACTIVE','WEAKENING','INVALIDATED')),
 first_seen timestamptz not null default now(),last_seen timestamptz not null default now(),evidence_hash text not null);
create table public.evolution_hypotheses(id text primary key,description text not null,proposal jsonb not null,critique jsonb not null,
 supporting_patterns jsonb not null,policy_version text,state text not null,created_at timestamptz not null default now());
create table public.evolution_evaluations(id text primary key,policy_version text not null references public.evolution_policy_bundles(version),
 champion_version text not null,policy_hash text not null,champion_hash text not null,dataset_hash text not null,report jsonb not null,
 qualified boolean not null default false,created_at timestamptz not null default now());
create table public.evolution_events(id bigint generated always as identity primary key,kind text not null,policy_version text,
 previous_version text,details jsonb not null default '{}',created_at timestamptz not null default now());
create table public.evolution_decisions(decision_id text primary key,trade_id uuid,signal_id text,symbol text not null,stage text not null,
 policy_version text not null,policy_hash text,snapshot_at timestamptz not null,record jsonb not null,created_at timestamptz not null default now());
create index evolution_decisions_symbol_time on public.evolution_decisions(symbol,snapshot_at);
create index evolution_decisions_trade on public.evolution_decisions(trade_id) where trade_id is not null;
create table public.evolution_outcomes(decision_id text primary key references public.evolution_decisions(decision_id),outcome jsonb not null,
 outcome_at timestamptz not null,created_at timestamptz not null default now());
create table public.evolution_position_policies(position_id uuid primary key,entry_policy_version text not null,decision_id text,
 generation text not null,source text not null,created_at timestamptz not null default now());
create table public.evolution_capture(position_id uuid not null,generation text not null,symbol text not null,at timestamptz not null,
 received_at timestamptz not null,payload jsonb not null,primary key(position_id,at));
create index evolution_capture_symbol_time on public.evolution_capture(symbol,at);
create table public.evolution_market_sets(id text primary key,captured_at timestamptz not null,source text not null,manifest jsonb not null,
 roster jsonb not null,scan jsonb not null,coverage numeric not null,dataset_hash text not null);
create table public.evolution_opportunities(id text primary key,market_set_id text references public.evolution_market_sets(id),symbol text not null,
 at_ms bigint not null,received_at_ms bigint not null,packet jsonb not null,context jsonb not null,created_at timestamptz not null default now());
create index evolution_opportunities_time on public.evolution_opportunities(at_ms);
create table public.evolution_market_frames(kind text not null,symbol text not null,at timestamptz not null,received_at timestamptz not null,payload jsonb not null,primary key(kind,symbol,at));
create index evolution_frames_time on public.evolution_market_frames(at);
create index evolution_frames_symbol_received on public.evolution_market_frames(symbol,received_at);
create table public.evolution_portfolios(id text primary key,policy_version text not null,split text not null,arm text not null,state jsonb not null,updated_at timestamptz not null default now());
alter table public.evolution_market_frames enable row level security;
alter table public.evolution_portfolios enable row level security;
revoke all on public.evolution_market_frames,public.evolution_portfolios from public,anon,authenticated;
grant select,insert on public.evolution_market_frames to service_role;
grant select,insert,update on public.evolution_portfolios to service_role;
create table public.evolution_simulations(id text primary key,policy_version text not null,champion_version text not null,
 split text not null,decision_id text not null,as_of_ms bigint not null,champion jsonb not null,challenger jsonb not null,
 result jsonb not null,created_at timestamptz not null default now(),unique(policy_version,split,decision_id));
create table public.evolution_provider_cache(cache_key text primary key,result jsonb not null,created_at timestamptz not null default now());
create table public.evolution_control(singleton boolean primary key default true check(singleton),enabled boolean not null default true,
 worker_version text,heartbeat_at timestamptz,last_full_review timestamptz,last_market_scan timestamptz,last_error text,
 daily_api_cap_usd numeric not null default 10,max_daily_api_calls integer not null default 600,
 capital_manifest jsonb not null,baseline_metrics jsonb not null default '{}',baseline_source jsonb not null);
create table evolution_private.budget(day date primary key,reserved numeric not null default 0,calls integer not null default 0);
do $body$ declare t text;begin
 foreach t in array array['evolution_policy_bundles','evolution_policy_states','evolution_jobs','evolution_reviews','evolution_patterns','evolution_hypotheses','evolution_evaluations','evolution_events','evolution_decisions','evolution_outcomes','evolution_position_policies','evolution_capture','evolution_market_sets','evolution_opportunities','evolution_simulations','evolution_provider_cache','evolution_control'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update on public.%I to service_role',t);
 end loop;
end $body$;
grant usage,select on sequence public.evolution_jobs_id_seq,public.evolution_events_id_seq to service_role;
revoke update,delete on public.evolution_policy_bundles,public.evolution_reviews,public.evolution_evaluations,public.evolution_events,public.evolution_decisions,public.evolution_outcomes,public.evolution_market_sets,public.evolution_opportunities,public.evolution_simulations from service_role;
revoke update on public.evolution_control from service_role;
create function evolution_private.immutable_row() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'IMMUTABLE_EVOLUTION_HISTORY';end $$;
create trigger evolution_bundle_immutable before update or delete on public.evolution_policy_bundles for each row execute function evolution_private.immutable_row();
create trigger evolution_evaluation_immutable before update or delete on public.evolution_evaluations for each row execute function evolution_private.immutable_row();
create function public.evolution_scope_valid(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare s jsonb; c jsonb; k text;begin
 if jsonb_typeof(p) is distinct from 'object' or (select array_agg(x order by x) from jsonb_object_keys(p)x) is distinct from array['calibration','data_cutoff_ms','models','parent_version','policy_version','schema_version','stages'] then return false;end if;
 if p->>'data_cutoff_ms' is null or p->>'policy_version' is null or p->>'schema_version' is distinct from 'SELF_EVOLUTION_1' or p->>'policy_version' !~ '^POLICY_[A-Za-z0-9_-]{1,70}$' or (p->>'data_cutoff_ms')::bigint<0 then return false;end if;
 if p->'parent_version'<>'null'::jsonb and p->>'parent_version' !~ '^POLICY_[A-Za-z0-9_-]{1,70}$' then return false;end if;
 if p->'models' is distinct from jsonb_build_object('gpt','gpt-5.4-mini-2026-03-17','deepseek','deepseek-flash') then return false;end if;
 if (select array_agg(x order by x) from jsonb_object_keys(p->'stages')x) is distinct from array['ENTRY','EXIT','HOLD','RECHECK'] then return false;end if;
 for s in select value from jsonb_each(p->'stages') loop
  if (select array_agg(x order by x) from jsonb_object_keys(s)x) is distinct from array['calibration_strength','deepseek_rubric','feature_weights','gpt_rubric'] then return false;end if;
  if s->>'calibration_strength' is null or (s->>'calibration_strength')::numeric not between 0 and 1 then return false;end if;
  foreach k in array array['gpt_rubric','deepseek_rubric'] loop
   if jsonb_typeof(s->k) is distinct from 'array' or jsonb_array_length(s->k)>6 then return false;end if;
   if exists(select 1 from jsonb_array_elements(s->k)v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>600 or (v#>>'{}') ~* '(margin|leverage|position[_ -]?siz|order[_ -]?siz|max[_ -]?slot|capital[_ -]?allocation|withdraw|transfer|api[_ -]?(key|secret|permission)|credential|execution[_ -]?safety|risk[_ -]?limit|hard[_ -]?(stop|floor)|account[_ -]?setting|https?:|<script|증거금|레버리지|출금)') then return false;end if;
  end loop;
  if jsonb_typeof(s->'feature_weights') is distinct from 'array' or jsonb_array_length(s->'feature_weights')>17 then return false;end if;
  if (select count(*)<>count(distinct v->>'feature') from jsonb_array_elements(s->'feature_weights')v) then return false;end if;
  for c in select value from jsonb_array_elements(s->'feature_weights') loop
   if (select array_agg(x order by x) from jsonb_object_keys(c)x) is distinct from array['feature','weight'] or jsonb_typeof(c->'weight') is distinct from 'number' or c->>'feature' is null or (c->>'weight')::numeric not between 0 and 2 or c->>'feature'<>all(array['price_trajectory','acceleration','high_renewal','drawdown_recovery','taker_flow','buy_share','bid_replenishment','ask_pressure','spread_depth','executable_impact','open_interest','funding_premium','btc_regime','thesis_validity','winner_retention','loser_recognition','counterevidence']) then return false;end if;
  end loop;
 end loop;
 if jsonb_typeof(p->'calibration') is distinct from 'array' or jsonb_array_length(p->'calibration')>144 or octet_length(p::text)>40000 then return false;end if;
 for c in select value from jsonb_array_elements(p->'calibration') loop
  if (select array_agg(x order by x) from jsonb_object_keys(c)x) is distinct from array['accuracy','as_of_ms','correct','lower','metric','n','provider','regime','stage','upper'] then return false;end if;
  if exists(select 1 from jsonb_each(c) x where x.value='null'::jsonb) or c->>'stage' not in ('ENTRY','RECHECK','HOLD','EXIT') or c->>'regime' not in ('STRONG_TREND','WEAK_TREND','BREAKOUT','POST_BREAKOUT','PULLBACK','REVERSAL','HIGH_VOL','LOW_VOL','HIGH_LIQUIDITY','LOW_LIQUIDITY','VOLUME_EXPANSION','VOLUME_EXHAUSTION','MARKET_RISK_ON','MARKET_RISK_OFF','MARKET_WIDE_SELLOFF','ALT_RALLY','ISOLATED_PUMP','UNKNOWN') or (c->>'as_of_ms')::bigint<0 or (c->>'as_of_ms')::bigint>(p->>'data_cutoff_ms')::bigint or (c->>'n')::integer<0 or (c->>'correct')::integer not between 0 and (c->>'n')::integer or c->>'metric'<>'NET_DIRECTION_60S' or c->>'provider' not in ('gpt','deepseek') then return false;end if;
  if (c->>'accuracy')::numeric not between 0 and 1 or (c->>'lower')::numeric not between 0 and (c->>'accuracy')::numeric or (c->>'upper')::numeric not between (c->>'accuracy')::numeric and 1 then return false;end if;
 end loop;
 return true;
exception when others then return false;end $$;
alter table public.evolution_policy_bundles add constraint evolution_bundle_scope check(public.evolution_scope_valid(bundle));
create function public.evolution_active_policy() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('bundle',b.bundle,'hash',b.sha256,'generation',a.generation,'state',s.state)
 from evolution_private.active_policy a join public.evolution_policy_bundles b on b.version=a.active_version join public.evolution_policy_states s on s.version=b.version where a.singleton;
$$;
create function public.evolution_claim_job() returns jsonb language plpgsql set search_path='' as $$
declare j public.evolution_jobs%rowtype;begin
 if not exists(select 1 from public.evolution_control where enabled) then return null;end if;
 select * into j from public.evolution_jobs where available_at<=now() and (state in ('PENDING','RETRY') or state='RUNNING' and lease_until<now()) order by priority,available_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update public.evolution_jobs set state='RUNNING',owner=gen_random_uuid(),lease_until=now()+interval '150 seconds',attempts=attempts+1 where id=j.id returning * into j;return to_jsonb(j);
end $$;
create function public.evolution_finish_job(p_id bigint,p_owner uuid,p_result jsonb,p_error text default null) returns boolean language plpgsql security definer set search_path='' as $$
declare k text;begin
 update public.evolution_jobs set state=case when p_error is null then 'DONE' when attempts>=8 then 'FAILED' else 'RETRY' end,
 result=p_result,last_error=left(p_error,300),completed_at=case when p_error is null then now() else null end,
 available_at=now()+make_interval(secs=>least(21600,(power(2,least(attempts,10))*30)::integer)),lease_until=null
 where id=p_id and owner=p_owner and state='RUNNING' and lease_until>now() returning kind into k;
 if not found then return false;end if;
 if p_error is null then update public.evolution_control set last_full_review=case when k='FULL_REVIEW' then now() else last_full_review end,last_market_scan=case when k='MARKET_SCAN' then now() else last_market_scan end where singleton;end if;return true;
end $$;
create function public.evolution_reserve_api(p_calls integer,p_usd numeric) returns boolean language plpgsql security definer set search_path='' as $$
declare c public.evolution_control%rowtype;b evolution_private.budget%rowtype;begin
 if p_calls not between 1 and 12 or p_usd not between .01 and 1 then return false;end if;
 select * into c from public.evolution_control where singleton; if not c.enabled then return false;end if;
 insert into evolution_private.budget(day)values(current_date)on conflict do nothing;
 select * into b from evolution_private.budget where day=current_date for update;
 if b.calls+p_calls>c.max_daily_api_calls or b.reserved+p_usd>c.daily_api_cap_usd then return false;end if;
 update evolution_private.budget set calls=calls+p_calls,reserved=reserved+p_usd where day=current_date;return true;
end $$;
-- Observe journal asynchronously from the separate worker; no trigger added to realtime writes.
create function public.evolution_ingest() returns jsonb language plpgsql security definer set search_path='' set lock_timeout='250ms' as $$
declare n integer;cap integer;begin
 if not pg_try_advisory_xact_lock(731091827) then return jsonb_build_object('busy',true);end if;
 insert into public.evolution_decisions(decision_id,trade_id,signal_id,symbol,stage,policy_version,policy_hash,snapshot_at,record)
 select r.job_key,case when r.record->'identity'->>'position_id' ~ '^[0-9a-f-]{36}$' then (r.record->'identity'->>'position_id')::uuid else null end,
 r.record->'identity'->>'signal_id',coalesce(r.symbol,r.record->'identity'->>'symbol'),coalesce(r.record->'packet'->>'task','ENTRY'),
 coalesce(r.record->'result'->'arbitration'->>'policy_version','LEGACY_UNVERSIONED'),r.record->'result'->'arbitration'->>'policy_hash',
 coalesce(to_timestamp((r.record->>'snapshot_at_ms')::numeric/1000),r.snapshot_at,r.created_at),r.record
 from public.gpt_final_entry_reviews r where purpose='PRODUCTION' and state='DONE' and created_at>now()-interval '30 days'
 and r.record->'packet' is not null and coalesce(r.symbol,r.record->'identity'->>'symbol') is not null
 and not exists(select 1 from public.evolution_decisions d where d.decision_id=r.job_key) order by r.created_at limit 200 on conflict do nothing;
 get diagnostics n=row_count;
 insert into public.evolution_market_frames(kind,symbol,at,received_at,payload)
 select kind,symbol,at,received_at,payload from doa_capture.live_micro where kind='micro' and at>now()-interval '3 minutes' on conflict do nothing;
 insert into public.evolution_position_policies(position_id,entry_policy_version,decision_id,generation,source)
 select p.id,coalesce(d.policy_version,'LEGACY_UNVERSIONED'),d.decision_id,p.id::text||':'||p.entry_at::text,
 case when d.decision_id is null then 'LEGACY_UNKNOWN_POLICY' else 'ENTRY_JOURNAL' end
 from public.v11_long_regime_positions p left join lateral(select x.* from public.evolution_decisions x where x.signal_id=p.signal_id::text and x.stage in ('ENTRY','RECHECK') and x.snapshot_at<=p.entry_at and x.record->'result'->>'decision'='BUY' and x.record->'result'->>'valid'='true' order by x.snapshot_at desc limit 1)d on true
 where p.entry_at>now()-interval '30 days' on conflict do nothing;
 insert into public.evolution_capture(position_id,generation,symbol,at,received_at,payload)
 select p.id,p.id::text||':'||p.entry_at::text,m.symbol,m.at,m.received_at,m.payload from doa_capture.live_micro m join public.v11_long_regime_positions p on p.symbol=m.symbol
 and m.at>=p.entry_at-interval '120 seconds' and (p.state='OPEN' or m.at<=p.closed_at+interval '10 minutes')
 where m.kind='micro' and m.at>now()-interval '3 minutes' and (p.state='OPEN' or p.closed_at>now()-interval '13 minutes') on conflict do nothing;
 get diagnostics cap=row_count;
 insert into public.evolution_jobs(dedupe_key,kind,payload,priority)
 select 'trade:'||p.id,'TRADE_REVIEW',jsonb_build_object('trade_id',p.id),case when p.closed_at>now()-interval '2 hours' then 10 when p.closed_at>now()-interval '3 days' then 20 else 200 end
 from public.v11_long_regime_positions p where state='CLOSED' and closed_at<now()-interval '10 minutes' and closed_at>now()-interval '30 days'
 order by closed_at desc limit 500 on conflict do nothing;
 return jsonb_build_object('decisions',n,'capture',cap);
end $$;
create function public.evolution_worker_heartbeat(p_version text,p_error text default null) returns void language sql security definer set search_path='' as $$
 update public.evolution_control set heartbeat_at=now(),worker_version=left(p_version,80),last_error=left(p_error,300) where singleton;
$$;
create function public.evolution_report() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('active',(select to_jsonb(a) from evolution_private.active_policy a),'control',(select to_jsonb(c) from public.evolution_control c),
 'jobs',(select jsonb_agg(j) from (select kind,state,count(*) n from public.evolution_jobs group by kind,state)j),
 'policies',(select jsonb_agg(s) from public.evolution_policy_states s),'last_events',(select jsonb_agg(e) from (select * from public.evolution_events order by id desc limit 15)e),
 'last_self_review',(select max(created_at) from public.evolution_reviews),'last_simulation',(select max(created_at) from public.evolution_simulations),
 'calibration',(select b.bundle->'calibration' from public.evolution_policy_bundles b join evolution_private.active_policy a on a.active_version=b.version),
 'disagreement',(select jsonb_agg(d) from (select decision_id,symbol,stage,outcome from public.evolution_outcomes o join public.evolution_decisions using(decision_id) where outcome->>'agreement'='DISAGREE' order by o.created_at desc limit 10)d),
 'reviews',(select count(*) from public.evolution_reviews),'patterns',(select count(*) from public.evolution_patterns),'hypotheses',(select count(*) from public.evolution_hypotheses),
 'decisions',(select count(*) from public.evolution_decisions),'outcomes',(select count(*) from public.evolution_outcomes),'simulations',(select count(*) from public.evolution_simulations),
 'budget',(select to_jsonb(b) from evolution_private.budget b where day=current_date));
$$;
create function public.evolution_bootstrap(p_version text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_version<>'POLICY_BASELINE_V104' or not exists(select 1 from public.evolution_policy_bundles where version=p_version and parent_version is null and public.evolution_scope_valid(bundle)) then return false;end if;
 insert into evolution_private.active_policy(singleton,active_version,health_confirmed_at) values(true,p_version,now()) on conflict do nothing;
 if not found then return false;end if;
 insert into public.evolution_policy_states(version,state,reason)values(p_version,'ACTIVE_CHAMPION','AUDITED_PRODUCTION_BASELINE') on conflict(version)do update set state='ACTIVE_CHAMPION';
 insert into public.evolution_events(kind,policy_version,details)values('BASELINE_FROZEN',p_version,jsonb_build_object('source','v104-main193','promotion','NOT_A_NEW_STRATEGY'));return true;
end $$;
create function public.evolution_promote(p_evaluation_id text,p_expected_version text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a evolution_private.active_policy%rowtype;e public.evolution_evaluations%rowtype;b public.evolution_policy_bundles%rowtype;r jsonb;s jsonb;label text;begin
 select * into a from evolution_private.active_policy where singleton for update;
 if a.active_version<>p_expected_version then raise exception 'PROMOTION_CAS';end if;
 if exists(select 1 from public.evolution_events where kind in ('ATOMIC_POLICY_SWITCH','AUTO_ROLLBACK') and created_at>now()-interval '7 days') then raise exception 'PROMOTION_COOLDOWN';end if;
 if exists(select 1 from public.evolution_policy_states where state='PROMOTING') then raise exception 'PROMOTION_IN_PROGRESS';end if;
 select * into e from public.evolution_evaluations where id=p_evaluation_id;
 select * into b from public.evolution_policy_bundles where version=e.policy_version;r:=e.report;
 if e.id is null or b.version is null or e.champion_version<>a.active_version or b.parent_version<>a.active_version or b.sha256<>e.policy_hash or
  e.champion_hash<>(select sha256 from public.evolution_policy_bundles where version=a.active_version) or not public.evolution_scope_valid(b.bundle) then raise exception 'PROMOTION_INTEGRITY';end if;
 if e.qualified is distinct from true or not (r @> '{"scope_valid":true,"integrity_valid":true,"execution_parity":true,"counterfactual_costs":true,"market_wide":true,"future_leakage":false,"split_overlap":false,"holdout_complete":true,"actual_trade_replay":true}'::jsonb) or r->>'scope_valid'<>'true' or r->>'integrity_valid'<>'true' or r->>'execution_parity'<>'true' or r->>'counterfactual_costs'<>'true'
  or r->>'market_wide'<>'true' or r->>'future_leakage'<>'false' or r->>'split_overlap'<>'false' then raise exception 'PROMOTION_QUALIFICATION';end if;
 if coalesce((r->>'universe_coverage')::numeric,0)<.95 or coalesce((r->>'complete_lifecycle_coverage')::numeric,0)<.95
  or coalesce((r->>'days')::integer,0)<14 or coalesce((r->>'symbols')::integer,0)<20 or coalesce((r->>'regimes')::integer,0)<3
  or coalesce((r->>'holdout_uses')::integer,0)<>1 or ((r->>'discovery_end')::bigint<(r->>'validation_start')::bigint and (r->>'validation_end')::bigint<(r->>'holdout_start')::bigint) is not true
  or (extract(epoch from b.created_at)*1000)::bigint>(r->>'validation_start')::bigint then raise exception 'PROMOTION_DATA_COVERAGE';end if;
 foreach label in array array['validation','holdout'] loop
  s:=r->label;
  if s is null or exists(select 1 from (values('net_usdt'),('max_drawdown'),('worst_loss'),('tail_loss'),('n'),('expectancy'))k(name) where jsonb_typeof(s->'challenger'->k.name) is distinct from 'number' or jsonb_typeof(s->'champion'->k.name) is distinct from 'number') then raise exception 'PROMOTION_METRIC_MISSING';end if;
  if coalesce((s->'challenger'->>'n')::integer,0)<(case when label='validation' then 100 else 50 end) or coalesce((s->'champion'->>'n')::integer,0)<(case when label='validation' then 100 else 50 end)
   or coalesce((s->'bootstrap'->>'lower')::numeric,0)<=0 or coalesce((s->'challenger'->>'expectancy')::numeric-(s->'champion'->>'expectancy')::numeric,0)<.05
   or (s->'challenger'->>'net_usdt')::numeric<=(s->'champion'->>'net_usdt')::numeric
   or (s->'challenger'->>'max_drawdown')::numeric>greatest(.5,(s->'champion'->>'max_drawdown')::numeric*1.05)
   or (s->'challenger'->>'worst_loss')::numeric<least(-.5,(s->'champion'->>'worst_loss')::numeric*1.05)
   or (s->'challenger'->>'tail_loss')::numeric<least(-.5,(s->'champion'->>'tail_loss')::numeric*1.05)
   or (s->'challenger'->>'n')::numeric/nullif((s->'champion'->>'n')::numeric,0) not between .7 and 1.3
   or coalesce((s->>'max_symbol_profit_share')::numeric,1)>.25 or coalesce((s->>'max_day_profit_share')::numeric,1)>.25
   or coalesce((s->>'positive_regime_fraction')::numeric,0)<.67 or coalesce((s->>'winner_retention_ratio')::numeric,0)<.9 then raise exception 'PROMOTION_QUANT_GATE_%',label;end if;
 end loop;
 if (select count(*) from public.evolution_portfolios where policy_version=b.version and split in ('VALIDATION','HOLDOUT') and jsonb_array_length(state->'trades')>=case when split='VALIDATION' then 100 else 50 end)<4 then raise exception 'PROMOTION_EVIDENCE_MISSING';end if;
 if (select count(*) from public.evolution_portfolios where policy_version=b.version and split in ('ACTUAL_VALIDATION','ACTUAL_HOLDOUT') and jsonb_array_length(state->'trades')>=5)<4 then raise exception 'PROMOTION_ACTUAL_REPLAY_MISSING';end if;
 update evolution_private.active_policy set previous_version=active_version,active_version=b.version,generation=generation+1,promoted_at=now(),health_confirmed_at=null,health_deadline=now()+interval '30 minutes' where singleton;
 update public.evolution_policy_states set state='PROMOTING',updated_at=now() where version=b.version;
 insert into public.evolution_events(kind,policy_version,previous_version,details)values('ATOMIC_POLICY_SWITCH',b.version,a.active_version,jsonb_build_object('evaluation_id',e.id,'generation',a.generation+1));
 update public.evolution_control set baseline_metrics=r->'holdout'->'champion' where singleton;
 return jsonb_build_object('state','PROMOTING','version',b.version,'generation',a.generation+1);
end $$;
create function public.evolution_policy_health() returns jsonb language plpgsql security definer set search_path='' as $$
declare a evolution_private.active_policy%rowtype;n integer;begin
 select * into a from evolution_private.active_policy where singleton for update;
 if a.health_confirmed_at is not null then return jsonb_build_object('state','ACTIVE_CHAMPION');end if;
 select count(*) into n from public.evolution_decisions d join public.evolution_policy_bundles b on b.version=d.policy_version
 where d.policy_version=a.active_version and d.policy_hash=b.sha256 and d.created_at>=a.promoted_at
 and d.record->'result'->>'valid'='true' and d.record->'result'->'arbitration'->>'authority'='GPT_FINAL_ONLY'
 and d.record->'result'->'arbitration'->>'refresh_error' is null;
 if n>=3 then
  update evolution_private.active_policy set health_confirmed_at=now(),health_deadline=null where singleton;
  update public.evolution_policy_states set state='ACTIVE_CHAMPION',updated_at=now() where version=a.active_version;
  insert into public.evolution_events(kind,policy_version,details)values('PRODUCTION_HEALTH_CONFIRMED',a.active_version,jsonb_build_object('realtime_decisions',n));
  return jsonb_build_object('state','ACTIVE_CHAMPION','proofs',n);
 end if;
 return jsonb_build_object('state','PROMOTING','proofs',n,'expired',now()>a.health_deadline);
end $$;
create function public.evolution_rollback(p_expected_version text,p_reason text,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a evolution_private.active_policy%rowtype;begin
 if p_reason not in ('POLICY_INTEGRITY','DECISION_FAILURE_SURGE','LOSS_TAIL_SURGE','EXPECTANCY_DRAWDOWN_DIVERGENCE','PROMOTION_HEALTH_TIMEOUT') then raise exception 'ROLLBACK_REASON';end if;
 select * into a from evolution_private.active_policy where singleton for update;
 if a.active_version<>p_expected_version then raise exception 'ROLLBACK_CAS';end if;
 if a.previous_version is null then return jsonb_build_object('rolled_back',false,'reason','BASELINE_HAS_NO_PREDECESSOR');end if;
 if not exists(select 1 from public.evolution_policy_bundles b where version=a.previous_version and public.evolution_scope_valid(bundle)) then raise exception 'KNOWN_GOOD_UNAVAILABLE';end if;
 update public.evolution_policy_states set state='RETIRED',reason=p_reason,updated_at=now() where version=a.active_version;
 update public.evolution_policy_states set state='ACTIVE_CHAMPION',updated_at=now() where version=a.previous_version;
 update evolution_private.active_policy set active_version=a.previous_version,previous_version=null,generation=generation+1,health_confirmed_at=now(),health_deadline=null where singleton;
 insert into public.evolution_events(kind,policy_version,previous_version,details) values('AUTO_ROLLBACK',a.previous_version,a.active_version,jsonb_build_object('reason',p_reason,'evidence',p_evidence));
 insert into public.evolution_jobs(dedupe_key,kind,payload,priority)values('rollback:'||a.active_version||':'||a.generation,'FULL_REVIEW',jsonb_build_object('failed_policy',a.active_version,'reason',p_reason),5)on conflict do nothing;
 return jsonb_build_object('rolled_back',true,'active',a.previous_version);
end $$;
CREATE OR REPLACE FUNCTION public.evolution_capture_context(p_symbol text, p_as_of timestamp with time zone, p_position_id uuid DEFAULT null)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with ctl as (
  select true enabled,true gpt_context_enabled,true production_enabled,p_as_of+interval '1 day' ends_at,p_as_of heartbeat_at
),
raw as (
 select o.at,o.received_at,o.payload,row_number() over(order by o.at desc) rn
 from public.evolution_market_frames o
 where o.kind='micro' and o.symbol=upper(btrim(p_symbol))
 and o.at<=p_as_of and o.at>p_as_of-interval '155 seconds'
),
last25 as (select * from raw where rn<=25),
ordered as (
  select at,received_at,payload,rn,
    lag(at) over(order by at) as previous_at,
    lag((payload->>'interval_end')::timestamptz) over(order by at) as previous_end,
    lag((payload->>'mid')::numeric) over(order by at) as prev_mid,
    lag((payload->>'spread_bps')::numeric) over(order by at) as prev_spread,
    lag((payload->>'ask_25_usdt')::numeric) over(order by at) as prev_ask25,
    lag((payload->>'bid_25_usdt')::numeric) over(order by at) as prev_bid25,
    lag(case when coalesce((payload->>'buy_quote_5s')::numeric,0)+coalesce((payload->>'sell_quote_5s')::numeric,0)>0
      then (payload->>'buy_quote_5s')::numeric /
        ((payload->>'buy_quote_5s')::numeric+(payload->>'sell_quote_5s')::numeric) end) over(order by at) as prev_buy_share,
    lag(coalesce((payload->>'buy_quote_5s')::numeric,0)-coalesce((payload->>'sell_quote_5s')::numeric,0)) over(order by at) as prev_net_flow,
    lag(case when (payload->>'mid')::numeric>0 and (payload->>'buy_vwap_450')::numeric>0
      then ((payload->>'buy_vwap_450')::numeric/(payload->>'mid')::numeric-1)*10000 end) over(order by at) as prev_buy_impact,
    lag(case when (payload->>'mid')::numeric>0 and (payload->>'sell_vwap_450')::numeric>0
      then (1-(payload->>'sell_vwap_450')::numeric/(payload->>'mid')::numeric)*10000 end) over(order by at) as prev_sell_impact
  from last25
),
stats as (
  select count(*) as n,min(at) as min_at,max(at) as max_at,
    min((payload->>'interval_start')::timestamptz) as window_start,
    max((payload->>'interval_end')::timestamptz) as window_end,
    max(received_at) as newest_received,
    bool_and(previous_at is null or at-previous_at=interval '5 seconds') as contiguous,
    bool_and(previous_end is null or abs(extract(epoch from ((payload->>'interval_start')::timestamptz-previous_end)))<=0.001) as intervals_contiguous
  from ordered where rn<=24
),
validity as (
 select bool_and(
  received_at<=p_as_of and at<=p_as_of and
  (payload->>'interval_end')::timestamptz<=p_as_of and
  abs(extract(epoch from ((payload->>'interval_end')::timestamptz-at)))<1 and
  extract(epoch from ((payload->>'interval_end')::timestamptz-(payload->>'interval_start')::timestamptz))*1000=(payload->>'interval_ms')::integer and
  (payload->>'interval_ms')::integer between 4000 and 6500 and
  coalesce((payload->>'bucket_complete')::boolean,false) and
  coalesce((payload->>'book_complete')::boolean,false) and
  coalesce((payload->>'trade_sequence_complete')::boolean,false) and
  coalesce((payload->>'coverage_25')::boolean,false) and
  coalesce((payload->>'flow_causal')::boolean,false) and
  (payload->>'trade_count')::integer>=0 and
  ((payload->>'trade_count')::integer=0 or (
    payload->>'trade_event_at' is not null and payload->>'trade_received_at' is not null and
    (payload->>'trade_event_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz>(payload->>'interval_start')::timestamptz
  )) and
  (payload->>'mid')::numeric>0 and
  payload ? 'exchange_at' and payload ? 'received_at' and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000) is not null and (extract(epoch from (payload->>'received_at')::timestamptz)*1000) is not null and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)-1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)-(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=10000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=extract(epoch from at)*1000-10000
 ) as valid from ordered
),
points as (
 select jsonb_agg(
   jsonb_build_object(
     'flow_event_ms',floor(extract(epoch from (payload->>'trade_event_at')::timestamptz)*1000),
     'flow_received_at_ms',floor(extract(epoch from (payload->>'trade_received_at')::timestamptz)*1000),
     'bucket_ms',floor(extract(epoch from at)*1000),
     'start_ms',floor(extract(epoch from (payload->>'interval_start')::timestamptz)*1000),
     'received_at_ms',floor(extract(epoch from received_at)*1000),
     'exchange_event_ms',(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000),
     'book_received_at_ms',(extract(epoch from (payload->>'received_at')::timestamptz)*1000),
     'mid',(payload->>'mid')::numeric,
     'start_mid',case when previous_at=at-interval '5 seconds' then prev_mid end,
     'aggressive_buy',(payload->>'buy_quote_5s')::numeric,
     'aggressive_sell',(payload->>'sell_quote_5s')::numeric,
     'end_ms',floor(extract(epoch from (payload->>'interval_end')::timestamptz)*1000),
     'd_mid_bps',case when prev_mid>0 then (((payload->>'mid')::numeric/prev_mid)-1)*10000 end,
     'd_spread_bps',case when prev_spread is not null then (payload->>'spread_bps')::numeric-prev_spread end,
     'd_ask_depth_25_pct',case when prev_ask25>0 then ((payload->>'ask_25_usdt')::numeric/prev_ask25)-1 end,
     'd_bid_depth_25_pct',case when prev_bid25>0 then ((payload->>'bid_25_usdt')::numeric/prev_bid25)-1 end,
     'buy_share_5s',case when coalesce((payload->>'buy_quote_5s')::numeric,0)+coalesce((payload->>'sell_quote_5s')::numeric,0)>0
       then (payload->>'buy_quote_5s')::numeric /
         ((payload->>'buy_quote_5s')::numeric+(payload->>'sell_quote_5s')::numeric) end,
     'd_buy_share',case when prev_buy_share is not null then
       ((payload->>'buy_quote_5s')::numeric /
        nullif((payload->>'buy_quote_5s')::numeric+(payload->>'sell_quote_5s')::numeric,0))-prev_buy_share end,
     'net_taker_quote_5s',coalesce((payload->>'buy_quote_5s')::numeric,0)-coalesce((payload->>'sell_quote_5s')::numeric,0),
     'd_net_taker_quote',case when prev_net_flow is not null then
       (coalesce((payload->>'buy_quote_5s')::numeric,0)-coalesce((payload->>'sell_quote_5s')::numeric,0))-prev_net_flow end,
     'trade_count',nullif(payload->>'trade_count','')::numeric,
     'arrival_rate',nullif(payload->>'trade_count','')::numeric / nullif((payload->>'interval_ms')::numeric/1000,0),
     'aggressive_notional',coalesce((payload->>'buy_quote_5s')::numeric,0)+coalesce((payload->>'sell_quote_5s')::numeric,0),
     'bid_book_net_5s',case when payload ? 'displayed_bid_added_5s' and payload ? 'displayed_bid_removed_5s'
       then (payload->>'displayed_bid_added_5s')::numeric-(payload->>'displayed_bid_removed_5s')::numeric end,
     'spread_bps',(payload->>'spread_bps')::numeric,
     'bid_depth_25_usdt',(payload->>'bid_25_usdt')::numeric,
     'ask_depth_25_usdt',(payload->>'ask_25_usdt')::numeric,
     'imbalance',((payload->>'bid_25_usdt')::numeric-(payload->>'ask_25_usdt')::numeric)/
       nullif((payload->>'bid_25_usdt')::numeric+(payload->>'ask_25_usdt')::numeric,0),
     'btc_return_1m',(payload->>'btc_return_1m')::numeric,
     'ask_book_net_5s',coalesce((payload->>'displayed_ask_added_5s')::numeric,0)-coalesce((payload->>'displayed_ask_removed_5s')::numeric,0),
     'buy_impact_450_bps',case when (payload->>'mid')::numeric>0 and (payload->>'buy_vwap_450')::numeric>0
       then ((payload->>'buy_vwap_450')::numeric/(payload->>'mid')::numeric-1)*10000 end,
     'd_buy_impact_bps',case when prev_buy_impact is not null then
       (((payload->>'buy_vwap_450')::numeric/(payload->>'mid')::numeric-1)*10000)-prev_buy_impact end,
     'sell_impact_450_bps',case when (payload->>'mid')::numeric>0 and (payload->>'sell_vwap_450')::numeric>0
       then (1-(payload->>'sell_vwap_450')::numeric/(payload->>'mid')::numeric)*10000 end,
     'd_sell_impact_bps',case when prev_sell_impact is not null then
       ((1-(payload->>'sell_vwap_450')::numeric/(payload->>'mid')::numeric)*10000)-prev_sell_impact end
   ) order by at
 ) as trajectory
 from ordered where rn<=24
)
select case
 when not exists(select 1 from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','UNWATCHED')
 when not (select enabled and gpt_context_enabled and (production_enabled or now()<ends_at) from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
 when (select heartbeat_at from ctl)>clock_timestamp()+interval '1 second' or (select heartbeat_at from ctl)<clock_timestamp()-interval '25 seconds'
   then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when upper(btrim(p_symbol)) !~ '^[A-Z0-9]{1,24}USDT$' then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_SYMBOL')
 when p_position_id is not null and not exists(select 1 from public.v11_long_regime_positions p where p.id=p_position_id and p.symbol=upper(btrim(p_symbol)) and p.state='OPEN')
   then jsonb_build_object('status','UNAVAILABLE','reason','POSITION_NOT_OPEN_OR_MISMATCH')
 when exists(select 1 from public.evolution_market_frames o where o.symbol=upper(btrim(p_symbol)) and o.at>p_as_of and o.at<=p_as_of+interval '10 seconds' and o.received_at<=p_as_of)
   then jsonb_build_object('status','UNAVAILABLE','reason','FUTURE_BUCKET')
 when (select n from stats)<>24 then jsonb_build_object('status','UNAVAILABLE','reason','INCOMPLETE_TRAJECTORY')
 when (select valid from validity) is distinct from true then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_OR_NONCAUSAL_BUCKET')
 when not (select contiguous and intervals_contiguous from stats) then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 when (select window_end from stats)<p_as_of-interval '25 seconds' then jsonb_build_object('status','UNAVAILABLE','reason','STALE_BUCKET')
 when extract(epoch from ((select max_at from stats)-(select min_at from stats))) <>115
   then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 else jsonb_build_object(
   'version','CAPTURE-CONTEXT-3-TRAJECTORY-120S',
   'status','AVAILABLE',
   'buckets',24,'coverage_policy','ALL_24_REQUIRED','position_id',p_position_id,
   'start_ms',floor(extract(epoch from (select window_start from stats))*1000),
   'end_ms',floor(extract(epoch from (select window_end from stats))*1000),
   'ingested_at_ms',floor(extract(epoch from (select newest_received from stats))*1000),
   'trajectory',(select trajectory from points)
 )
end
$function$
;



-- Definer functions are narrow data services, revoked from PUBLIC and end-user roles.
CREATE OR REPLACE FUNCTION public.evolution_market_sensor(p_symbol text, p_as_of timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with ctl as (select true enabled,true gpt_context_enabled,true production_enabled,p_as_of+interval '1 day' ends_at,p_as_of heartbeat_at),
raw as (
 select o.at,o.received_at,o.payload,row_number() over(order by o.at desc) rn
 from public.evolution_market_frames o
 where o.kind='micro' and o.symbol=upper(btrim(p_symbol))
 and o.at<=p_as_of and o.at>p_as_of-interval '155 seconds'
),
last25 as (select * from raw where rn<=25),
ordered as (
  select at,received_at,payload,rn,
    lag(at) over(order by at) as previous_at,
    lag((payload->>'interval_end')::timestamptz) over(order by at) as previous_end,
    lag((payload->>'mid')::numeric) over(order by at) as prev_mid
  from last25
),
stats as (
  select count(*) as n,min(at) as min_at,max(at) as max_at,
    min((payload->>'interval_start')::timestamptz) as window_start,
    max((payload->>'interval_end')::timestamptz) as window_end,
    max(received_at) as newest_received,
    bool_and(previous_at is null or at-previous_at=interval '5 seconds') as contiguous,
    bool_and(previous_end is null or abs(extract(epoch from ((payload->>'interval_start')::timestamptz-previous_end)))<=0.001) as intervals_contiguous
  from ordered where rn<=24
),
validity as (
 select bool_and(coalesce(
  received_at>= (payload->>'interval_end')::timestamptz and received_at<=p_as_of and at<=p_as_of and
  (payload->>'interval_end')::timestamptz<=p_as_of and
  abs(extract(epoch from ((payload->>'interval_end')::timestamptz-at)))<1 and
  extract(epoch from ((payload->>'interval_end')::timestamptz-(payload->>'interval_start')::timestamptz))*1000=(payload->>'interval_ms')::integer and
  (payload->>'interval_ms')::integer between 4000 and 6500 and
  coalesce((payload->>'bucket_complete')::boolean,false) and
  coalesce((payload->>'book_complete')::boolean,false) and
  coalesce((payload->>'trade_sequence_complete')::boolean,false) and
  coalesce((payload->>'btc_candle_complete')::boolean,false) and
  (payload->>'btc_return_1m')::numeric is not null and
  (payload->>'btc_candle_end_ms')::bigint <= extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  extract(epoch from (payload->>'interval_end')::timestamptz)*1000-(payload->>'btc_candle_end_ms')::bigint between 0 and 65000 and
  (payload->>'btc_candle_end_ms')::bigint-extract(epoch from (payload->>'btc_candle_at')::timestamptz)*1000=60000 and
  (payload->>'btc_candle_exchange_ms')::bigint >= (payload->>'btc_candle_end_ms')::bigint-1 and
  (payload->>'btc_candle_exchange_ms')::bigint <= extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (payload->>'btc_candle_received_ms')::bigint <= extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (payload->>'btc_candle_received_ms')::bigint-(payload->>'btc_candle_exchange_ms')::bigint between -1000 and 10000 and
  (payload->>'best_bid')::numeric>0 and (payload->>'best_ask')::numeric>=(payload->>'best_bid')::numeric and
  (payload->>'observed_bid_depth_usdt')::numeric>=0 and (payload->>'observed_ask_depth_usdt')::numeric>=0 and
  (payload->>'depth_bid_coverage_bps')::numeric between 0 and 25 and (payload->>'depth_ask_coverage_bps')::numeric between 0 and 25 and
  (payload->>'depth_coverage_complete')::boolean is not null and
  (not (payload->>'depth_coverage_complete')::boolean or least((payload->>'depth_bid_coverage_bps')::numeric,(payload->>'depth_ask_coverage_bps')::numeric)=25) and
  (payload->>'buy_quote_5s')::numeric>=0 and (payload->>'sell_quote_5s')::numeric>=0 and
  (payload->>'depth_bid_boundary')::numeric>0 and (payload->>'depth_ask_boundary')::numeric>0 and
  coalesce((payload->>'flow_causal')::boolean,false) and
  (payload->>'trade_count')::integer>=0 and
  ((payload->>'trade_count')::integer=0 or (
    payload->>'trade_event_at' is not null and payload->>'trade_received_at' is not null and
    (payload->>'trade_event_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz<=(payload->>'interval_end')::timestamptz and
    (payload->>'trade_received_at')::timestamptz>(payload->>'interval_start')::timestamptz and
    extract(epoch from ((payload->>'trade_received_at')::timestamptz-(payload->>'trade_event_at')::timestamptz))*1000 between -1000 and 10000
  )) and
  (payload->>'mid')::numeric>0 and
  payload ? 'exchange_at' and payload ? 'received_at' and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000) is not null and (extract(epoch from (payload->>'received_at')::timestamptz)*1000) is not null and
  (extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)<=extract(epoch from (payload->>'interval_end')::timestamptz)*1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)-1000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)-(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000)<=10000 and
  (extract(epoch from (payload->>'received_at')::timestamptz)*1000)>=extract(epoch from at)*1000-10000
 ,false)) as valid from ordered
),
points as (select jsonb_agg(jsonb_build_object(
'bucket_ms',floor(extract(epoch from at)*1000),
'start_ms',floor(extract(epoch from (payload->>'interval_start')::timestamptz)*1000),
'end_ms',floor(extract(epoch from (payload->>'interval_end')::timestamptz)*1000),
'received_at_ms',floor(extract(epoch from received_at)*1000),
'exchange_event_ms',floor(extract(epoch from (payload->>'exchange_at')::timestamptz)*1000),
'book_received_at_ms',floor(extract(epoch from (payload->>'received_at')::timestamptz)*1000),
'flow_event_ms',floor(extract(epoch from (payload->>'trade_event_at')::timestamptz)*1000),
'flow_received_at_ms',floor(extract(epoch from (payload->>'trade_received_at')::timestamptz)*1000),
'start_mid',prev_mid,
'd_mid_bps',case when prev_mid>0 then ((payload->>'mid')::numeric/prev_mid-1)*10000 end,
'taker_buy_quote_5s',(payload->>'buy_quote_5s')::numeric,
'taker_sell_quote_5s',(payload->>'sell_quote_5s')::numeric,
'arrival_rate',(payload->>'trade_count')::numeric/nullif((payload->>'interval_ms')::numeric/1000,0),
'observed_imbalance',((payload->>'observed_bid_depth_usdt')::numeric-(payload->>'observed_ask_depth_usdt')::numeric)/nullif((payload->>'observed_bid_depth_usdt')::numeric+(payload->>'observed_ask_depth_usdt')::numeric,0),
'mid',(payload->>'mid')::numeric,
'best_bid',(payload->>'best_bid')::numeric,
'best_ask',(payload->>'best_ask')::numeric,
'spread_bps',(payload->>'spread_bps')::numeric,
'trade_count',(payload->>'trade_count')::numeric,
'btc_return_1m',(payload->>'btc_return_1m')::numeric,
'btc_candle_end_ms',(payload->>'btc_candle_end_ms')::numeric,
'btc_candle_exchange_ms',(payload->>'btc_candle_exchange_ms')::numeric,
'btc_candle_received_ms',(payload->>'btc_candle_received_ms')::numeric,
'observed_bid_depth_usdt',(payload->>'observed_bid_depth_usdt')::numeric,
'observed_ask_depth_usdt',(payload->>'observed_ask_depth_usdt')::numeric,
'depth_bid_coverage_bps',(payload->>'depth_bid_coverage_bps')::numeric,
'depth_ask_coverage_bps',(payload->>'depth_ask_coverage_bps')::numeric,
'depth_bid_boundary',(payload->>'depth_bid_boundary')::numeric,
'depth_ask_boundary',(payload->>'depth_ask_boundary')::numeric,
'bucket_complete',(payload->>'bucket_complete')::boolean,
'book_complete',(payload->>'book_complete')::boolean,
'trade_sequence_complete',(payload->>'trade_sequence_complete')::boolean,
'flow_causal',(payload->>'flow_causal')::boolean,
'btc_candle_complete',(payload->>'btc_candle_complete')::boolean,
'depth_coverage_complete',(payload->>'depth_coverage_complete')::boolean
) order by at) trajectory from ordered where rn<=24)
select case
 when not exists(select 1 from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','UNWATCHED')
 when not (select enabled and gpt_context_enabled and (production_enabled or now()<ends_at) from ctl) then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
 when (select heartbeat_at from ctl)>clock_timestamp()+interval '1 second' or (select heartbeat_at from ctl)<clock_timestamp()-interval '25 seconds'
   then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when upper(btrim(p_symbol)) <> 'BTCUSDT' or p_symbol is null then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_SYMBOL')
 when p_as_of>clock_timestamp() or p_as_of is null then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 when exists(select 1 from public.evolution_market_frames o where o.symbol=upper(btrim(p_symbol)) and o.at>p_as_of and o.at<=p_as_of+interval '10 seconds' and o.received_at<=p_as_of)
   then jsonb_build_object('status','UNAVAILABLE','reason','FUTURE_BUCKET')
 when (select count(*) from last25)<>25 or (select n from stats)<>24 then jsonb_build_object('status','UNAVAILABLE','reason','INCOMPLETE_TRAJECTORY')
 when (select valid from validity) is distinct from true then jsonb_build_object('status','UNAVAILABLE','reason','INVALID_OR_NONCAUSAL_BUCKET')
 when not (select contiguous and intervals_contiguous from stats) then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 when (select window_end from stats)<p_as_of-interval '25 seconds' then jsonb_build_object('status','UNAVAILABLE','reason','STALE_BUCKET')
 when extract(epoch from ((select max_at from stats)-(select min_at from stats))) <>115
   then jsonb_build_object('status','UNAVAILABLE','reason','NONCONTIGUOUS_TRAJECTORY')
 else jsonb_build_object(
   'version','MARKET_SENSOR_CONTEXT_V1','contract','MARKET_SENSOR_CONTEXT_V1','symbol','BTCUSDT','role','MARKET_SENSOR','as_of_ms',floor(extract(epoch from p_as_of)*1000),
   'status','AVAILABLE',
   'buckets',24,'coverage_policy','ALL_24_REQUIRED','depth_semantics','OBSERVED_WITHIN_SNAPSHOT_AND_25BP_INTERSECTION_NO_EXTRAPOLATION',
   'start_ms',floor(extract(epoch from (select window_start from stats))*1000),
   'end_ms',floor(extract(epoch from (select window_end from stats))*1000),
   'ingested_at_ms',floor(extract(epoch from (select newest_received from stats))*1000),
   'market_sensor_trajectory',(select trajectory from points)
 )
end
$function$;

do $body$ declare r record;begin
 for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'evolution_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',r.f);
  execute format('grant execute on function %s to service_role',r.f);
 end loop;
end $body$;
commit;
