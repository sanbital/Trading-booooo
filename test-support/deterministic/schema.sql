-- Minimal production column contract. No provider tables: SQL dependencies must fail
-- if the new authority accidentally reaches historical model or budget state.
create role anon;create role authenticated;create role service_role bypassrls;
create table leader20_control(singleton boolean primary key,active_strategy text default 'LEADER20_DYNAMIC_1' constraint leader20_control_active_strategy_check check(active_strategy in ('LEGACY','LEADER20_DYNAMIC_1','PAUSED')),epoch_id uuid,generation bigint default 4,updated_at timestamptz default clock_timestamp(),archive_max_bytes bigint default 8589934592);
insert into leader20_control(singleton) values(true);
create table leader20_epochs(id uuid primary key default gen_random_uuid(),scheduled_at timestamptz,observed_at timestamptz,effective_at timestamptz,next_refresh_at timestamptz,snapshot jsonb,source_hash text);
create table leader20_members(epoch_id uuid,symbol text,rank int,price_change_percent numeric,quote_volume numeric,primary key(epoch_id,symbol));
create table v11_long_regime_positions(id uuid primary key default gen_random_uuid(),symbol text,state text,remaining_quantity numeric,metadata jsonb default '{}');
create table v11_long_regime_orders(id uuid primary key default gen_random_uuid(),symbol text,state text,response_payload jsonb default '{}',signal_id uuid,intent text,client_order_id text,requested_quantity numeric,request_payload jsonb default '{}',exchange_order_id text,updated_at timestamptz default clock_timestamp());
create table v11_long_regime_signals(id uuid primary key default gen_random_uuid(),revision text,lane text,symbol text,side text,signal_bar_at timestamptz,entry_bar_at timestamptz,features jsonb,status text,position_id uuid,created_at timestamptz default clock_timestamp(),updated_at timestamptz,unique(revision,lane,symbol,signal_bar_at));
create table leader20_entry_reservations(id uuid primary key default gen_random_uuid(),symbol text,slot_ms bigint,signal_id uuid,expires_at timestamptz,state text default 'RESERVED',reason text,settled_at timestamptz,updated_at timestamptz default clock_timestamp());
create table trading_account_snapshots(exchange text,captured_at timestamptz,positions_complete boolean,available_quote numeric,positions jsonb);
create schema doa_capture;
create table doa_capture.control(id int primary key,enabled boolean,production_enabled boolean,starts_at timestamptz,ends_at timestamptz,protocol_sha256 text,lease_owner text,lease_until timestamptz,heartbeat_at timestamptz,live_requests bigint default 0,live_bytes_ingested bigint default 0,metrics jsonb);
insert into doa_capture.control(id,enabled,production_enabled,starts_at,ends_at,heartbeat_at) values(1,true,true,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp());
create table doa_capture.live_micro(kind text,symbol text,at timestamptz,received_at timestamptz default clock_timestamp(),payload jsonb,primary key(kind,symbol,at));
create table doa_capture.batches(id uuid primary key,created_at timestamptz default clock_timestamp());
create table leader20_micro_archive(symbol text,at timestamptz,received_at timestamptz,payload jsonb,primary key(symbol,at));
create table edge_internal_tokens(name text,token text);
insert into edge_internal_tokens values('v10-lane-executor','fixture-authentication');
create schema net;create table net.requests(id bigserial primary key,body jsonb);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$
declare n bigint;begin insert into net.requests(body) values(body) returning id into n;return n;end $$;

create table v17_execution_lease(singleton boolean primary key,owner uuid,fence bigint,expires_at timestamptz,postmaster_started_at timestamptz);
create function v17_verify_execution_lease(p_owner uuid) returns boolean language sql as $$select exists(select 1 from public.v17_execution_lease where owner=p_owner and expires_at>clock_timestamp()+interval '30 seconds' and postmaster_started_at=pg_postmaster_start_time())$$;
create function v17_account_recovery_state() returns jsonb language sql as $$select '{"ready":true}'::jsonb$$;
