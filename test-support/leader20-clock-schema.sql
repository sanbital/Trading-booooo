alter table leader20_control add column watch_limit integer default 20,add column archive_state text default 'READY',
 add column cold_archive_state text default 'READY',add column archive_max_bytes bigint default 10000,
 add column archive_last_verified_at timestamptz default now(),add column last_scheduler_at timestamptz,add column updated_at timestamptz;
create table leader20_epochs(id uuid primary key default gen_random_uuid(),next_refresh_at timestamptz,
 scheduled_at timestamptz unique,observed_at timestamptz,effective_at timestamptz default clock_timestamp(),snapshot jsonb,source_hash text);
alter table leader20_members add column price_change_percent numeric,add column quote_volume numeric;
create table leader20_campaigns(symbol text primary key,epoch_id uuid,state text default 'WATCHING',reason text,
 bucket_count integer,last_bucket_at timestamptz,last_decision text,last_requested_at timestamptz,
 next_review_conditions jsonb,updated_at timestamptz);
alter table leader20_review_events add column expires_at timestamptz;
create unique index campaign_single_flight on leader20_review_events(symbol) where state in ('REQUESTED','REVIEWING');
alter table v11_long_regime_positions add column id uuid,add column closed_at timestamptz;
alter table v11_long_regime_signals alter column id set default gen_random_uuid(),add column revision text,
 add column lane text,add column symbol text,add column side text,add column signal_bar_at timestamptz,
 add column entry_bar_at timestamptz,add column status text,add column reject_reason text,add column updated_at timestamptz;
alter table gpt_final_review_control add column daily_cap_usd numeric default 3 constraint gpt_final_review_control_daily_cap_usd_check check(daily_cap_usd<=3),
 add column monthly_cap_usd numeric default 95 constraint gpt_final_review_control_monthly_cap_usd_check check(monthly_cap_usd<=95),
 add constraint gpt_final_review_control_max_calls_per_day_check check(max_calls_per_day<=100);
create schema doa_capture;
create table doa_capture.live_micro(kind text,symbol text,at timestamptz,received_at timestamptz,payload jsonb,primary key(symbol,at));
create table doa_capture.control(id integer,enabled boolean,gpt_context_enabled boolean,production_enabled boolean,ends_at timestamptz,heartbeat_at timestamptz);
create function doa_context_for_role_v1(text,timestamptz,text,uuid) returns jsonb language sql as 'select jsonb_build_object(''delegated_role'',$3,''position_id'',$4)';
create function doa_capture_rpc(text,jsonb default '{}') returns jsonb language sql as 'select jsonb_build_object(''enabled'',true,''watch'',
 ''[{"symbol":"C0USDT","roles":["SCANNER_LEADER"]},{"symbol":"HELDUSDT","roles":["OPEN_POSITION"]},{"symbol":"BTCUSDT","roles":["MARKET_SENSOR"]}]''::jsonb)';
