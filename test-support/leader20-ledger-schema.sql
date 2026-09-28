create role anon;create role authenticated;create role service_role bypassrls;
 create table gpt_final_entry_reviews(job_key text primary key,owner uuid default gen_random_uuid(),state text,record jsonb,purpose text,
 budget_day date,reserved_usd numeric,settled_usd numeric,model text,signal_id text,symbol text,created_at timestamptz default clock_timestamp());
 create table gpt_final_review_control(singleton boolean,mode text,enforce_approved boolean,approval_ref text,budget_effective_day date,daily_spend_offset numeric,daily_call_offset integer,max_calls_per_day integer);
 insert into gpt_final_review_control values(true,'ENFORCE',true,'test',current_date,0,0,100);
 create table gpt_final_review_daily_budget(utc_day date,reserved_usd numeric,calls integer);
 create function ai_monthly_spend_used(date default current_date) returns numeric language sql as 'select 40.13311308::numeric';
 create function leader20_entry_budget_limits() returns jsonb language sql as 'select ''{"protected_usd":0.5}''::jsonb';
 create function gpt_final_review_claim(text,jsonb,numeric,integer,numeric) returns jsonb language sql as 'select ''{"legacy":true}''::jsonb';
 create table leader20_control(singleton boolean,epoch_id uuid,generation bigint,observation_enabled boolean,active_strategy text);
 create table leader20_members(epoch_id uuid,symbol text,rank int);
 create table trading_account_snapshots(exchange text,captured_at timestamptz,positions_complete boolean,available_quote numeric,positions jsonb);
 create table v11_long_regime_positions(symbol text,state text,remaining_quantity numeric,metadata jsonb);
 create table v11_long_regime_orders(id uuid primary key default gen_random_uuid(),symbol text,state text,response_payload jsonb,signal_id uuid,intent text);
 create table v11_long_regime_signals(id uuid primary key,features jsonb);
 create table leader20_review_events(id uuid default gen_random_uuid(),epoch_id uuid,symbol text,generation bigint,requested_at timestamptz,
 snapshot_end_ms bigint,snapshot_hash text,reason text,priority int,state text default 'REQUESTED',result jsonb,signal_id uuid);
 create function leader20_schedule() returns jsonb language sql as 'select ''{"legacy30m":true}''::jsonb';
 create function leader20_entry_authority(uuid) returns jsonb language sql as 'select ''{"allowed":true}''::jsonb';
 create table edge_internal_tokens(name text,token text);
 insert into edge_internal_tokens values('v10-lane-signal-generator','fixture-token');
 create schema net;
 create table net.requests(id bigserial primary key,body jsonb);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$
 declare n bigint;begin insert into net.requests(body) values(body) returning id into n;return n;end $$;
 create function leader20_materialize_event(uuid,jsonb) returns jsonb language sql as 'select ''{"created":false}''::jsonb';