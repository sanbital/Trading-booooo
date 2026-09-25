-- REVIEW DRAFT ONLY. Not a Supabase migration and NOT applied to production.
-- Approval + collector implementation/security tests precede creating a CLI migration.
-- Private schema is not to be added to PostgREST exposed schemas.
begin;
create schema doa_research;
revoke all on schema doa_research from public,anon,authenticated;
create role doa_capture_writer nologin;
create role doa_label_writer nologin;
grant usage on schema doa_research to doa_capture_writer,doa_label_writer;

create table doa_research.runs (
 id uuid primary key, protocol_sha256 text not null check(length(protocol_sha256)=64),
 enabled boolean not null default false, starts_at timestamptz not null, ends_at timestamptz not null,
 max_candidates integer not null default 2000 check(max_candidates between 1 and 2000),
 max_symbols integer not null default 32 check(max_symbols between 1 and 32),
 max_serialized_bytes bigint not null default 500000000 check(max_serialized_bytes between 1 and 500000000),
 budget_usd numeric not null default 25 check(budget_usd between 0 and 25),
 reserved_bytes bigint not null default 0 check(reserved_bytes>=0),
 reserved_usd numeric not null default 0 check(reserved_usd>=0),
 candidates_reserved integer not null default 0 check(candidates_reserved>=0),
 check(ends_at>starts_at and ends_at<=starts_at+interval '14 days'),
 check(reserved_bytes<=max_serialized_bytes and reserved_usd<=budget_usd and candidates_reserved<=max_candidates)
);
create table doa_research.candidates (
 run_id uuid not null references doa_research.runs(id), signal_id uuid not null,
 symbol text not null, detected_at timestamptz not null, decision_at timestamptz not null,
 position_id uuid, fill_at timestamptz, executor_patch text, policy_hash text not null,
 split text not null check(split in ('DEV','VALIDATION','TEST')),
 coverage_status text not null check(coverage_status in ('PENDING','COMPLETE','GAP','UNWATCHED','CAP_REACHED')),
 source_hash text not null, primary key(run_id,signal_id)
);
create table doa_research.micro_buckets (
 run_id uuid not null references doa_research.runs(id), symbol text not null, bucket_at timestamptz not null,
 exchange_at timestamptz, received_at timestamptz not null, available_at timestamptz not null,
 first_update_id bigint, last_update_id bigint, sequence_contiguous boolean not null,
 best_bid numeric, best_ask numeric, bid_qty numeric, ask_qty numeric,
 spread_bps numeric, bid_25_usdt numeric, ask_25_usdt numeric, bid_50_usdt numeric, ask_50_usdt numeric,
 coverage_25 boolean not null, coverage_50 boolean not null,
 buy_quote_5s numeric, sell_quote_5s numeric, sell_quote_max_1s numeric,
 displayed_ask_added_5s numeric, displayed_ask_removed_5s numeric,
 observed_liquidation_usdt numeric, liquidation_complete boolean not null default false,
 btc_return_1m numeric, sector_return_1m numeric, sector_map_version text,
 maker_fee_bps numeric, taker_fee_bps numeric, fee_observed_at timestamptz,
 metrics jsonb not null default '{}' check(octet_length(metrics::text)<=8192),
 quality jsonb not null check(octet_length(quality::text)<=4096), raw_hash text not null,
 primary key(run_id,symbol,bucket_at),
 check(best_bid is null or best_bid>0),check(best_ask is null or best_ask>0),
 check(best_bid is null or best_ask is null or best_ask>=best_bid),
 check(available_at>=received_at)
);
create table doa_research.candles_1m (
 run_id uuid not null references doa_research.runs(id),symbol text not null,open_at timestamptz not null,
 available_at timestamptz not null,open numeric not null,high numeric not null,low numeric not null,close numeric not null,
 quote_volume numeric not null,taker_buy_quote numeric,source text not null,complete boolean not null,raw_hash text not null,
 primary key(run_id,symbol,open_at),check(low>0 and high>=low and open between low and high and close between low and high)
);
create table doa_research.labels (
 run_id uuid not null,signal_id uuid not null,horizon_minutes integer not null check(horizon_minutes in (5,15,60)),
 anchor_kind text not null check(anchor_kind in ('DECISION_ASK','ACTUAL_FILL','MAKER_PROXY')),
 anchor_at timestamptz not null,anchor_price numeric not null check(anchor_price>0),
 evaluated_at timestamptz not null,mfe numeric,mae numeric,net_pnl numeric,entry_fee numeric,exit_fee numeric,funding_cashflow numeric,
 doa boolean,winner_3pct boolean,coverage_complete boolean not null,label_version text not null,source_hash text not null,
 primary key(run_id,signal_id,horizon_minutes,anchor_kind),
 foreign key(run_id,signal_id) references doa_research.candidates(run_id,signal_id),
 check(evaluated_at>=anchor_at+make_interval(mins=>horizon_minutes))
);
create table doa_research.shadow_decisions (
 run_id uuid not null,signal_id uuid not null,arm text not null,task text not null check(task in ('ENTRY','HOLD_2M','HOLD_5M')),
 packet_hash text not null,prompt_hash text not null,model_version text not null,
 input_available_at timestamptz not null,started_at timestamptz not null,completed_at timestamptz,
 deadline_at timestamptz not null,valid boolean not null,answer jsonb,usage jsonb,
 authority jsonb not null default '[]' check(authority='[]'::jsonb),
 primary key(run_id,signal_id,arm,task),
 foreign key(run_id,signal_id) references doa_research.candidates(run_id,signal_id),
 check(started_at>=input_available_at),check(completed_at is null or completed_at>=started_at)
);
create index candidates_symbol_time on doa_research.candidates(symbol,decision_at);
create index micro_retention on doa_research.micro_buckets(bucket_at);
create index candle_retention on doa_research.candles_1m(open_at);

alter table doa_research.runs enable row level security;
alter table doa_research.candidates enable row level security;
alter table doa_research.micro_buckets enable row level security;
alter table doa_research.candles_1m enable row level security;
alter table doa_research.labels enable row level security;
alter table doa_research.shadow_decisions enable row level security;
revoke all on all tables in schema doa_research from public,anon,authenticated;
-- Collector cannot read future labels or modify control budgets. No service-role runtime grant.
grant select on doa_research.runs to doa_capture_writer;
grant select,insert on doa_research.candidates,doa_research.micro_buckets,doa_research.candles_1m to doa_capture_writer;
create policy capture_run_read on doa_research.runs for select to doa_capture_writer using(true);
create policy capture_candidates on doa_research.candidates to doa_capture_writer using(true) with check(true);
create policy capture_micro on doa_research.micro_buckets to doa_capture_writer using(true) with check(true);
create policy capture_candles on doa_research.candles_1m to doa_capture_writer using(true) with check(true);
grant select on doa_research.candidates,doa_research.micro_buckets,doa_research.candles_1m to doa_label_writer;
grant select,insert on doa_research.labels to doa_label_writer;
create policy label_candidates on doa_research.candidates for select to doa_label_writer using(true);
create policy label_micro on doa_research.micro_buckets for select to doa_label_writer using(true);
create policy label_candles on doa_research.candles_1m for select to doa_label_writer using(true);
create policy label_write on doa_research.labels to doa_label_writer using(true) with check(true);
-- No shadow caller role/grants yet: capture stage performs zero LLM calls.
-- Before deployment implement atomic budget reservation + authenticated bounded ingestion;
-- these row checks alone do NOT enforce global insertion/storage/spend caps.
-- No login passwords, business table grants, cron, triggers, executable RPC or run seed here.
commit;
