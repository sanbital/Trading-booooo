-- Independent FD1 research journal inside the existing restricted shadow schema.
-- This migration touches no trading control, position, order or production GPT table.
create table if not exists shadow_le.fd1_thesis_reviews (
  job_key text primary key,
  task text not null check (task in ('RECHECK','HOLD')),
  symbol text not null,
  signal_id text,
  production_decision text,
  snapshot_at timestamptz not null,
  input_features jsonb not null,
  version text not null,
  state text not null check (state in ('CLAIMED','DONE')),
  shadow_decision text,
  trend_valid boolean,
  entry_valid boolean,
  micro_only boolean,
  evidence jsonb,
  reason text,
  model text,
  prompt_hash text,
  schema_hash text,
  request_id text,
  latency_ms integer,
  cost_usd numeric,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists fd1_thesis_reviews_time on shadow_le.fd1_thesis_reviews(created_at desc);
revoke all on shadow_le.fd1_thesis_reviews from public, anon, authenticated;
grant select,insert,update on shadow_le.fd1_thesis_reviews to shadow_le_writer;
comment on table shadow_le.fd1_thesis_reviews is
  'Order-free FD1 research: point-in-time RECHECK/HOLD packets and alternative GPT thesis decisions. No production writes.';

create table if not exists shadow_le.fd1_early_snapshots (
  snapshot_id bigint generated always as identity primary key,
  position_id uuid not null,
  signal_id uuid,
  symbol text not null,
  entry_at timestamptz not null,
  window_min integer not null check(window_min in (1,2,3,5)),
  observed_at timestamptz not null,
  last_bar_close_at timestamptz not null,
  entry_price numeric not null,
  current_price numeric not null,
  mfe_lower_bound numeric not null,
  mae_lower_bound numeric not null,
  current_return numeric not null,
  taker_buy_share_2bars numeric,
  completed_bars integer not null,
  structural_signals jsonb not null,
  shadow_label text not null,
  version text not null,
  created_at timestamptz not null default now(),
  unique(position_id,window_min,version)
);
revoke all on shadow_le.fd1_early_snapshots from public, anon, authenticated;
grant select,insert on shadow_le.fd1_early_snapshots to shadow_le_writer;
grant usage on sequence shadow_le.fd1_early_snapshots_snapshot_id_seq to shadow_le_writer;
comment on table shadow_le.fd1_early_snapshots is
  'Only completed 1m candles after actual entry; order-free structural observations at 1/2/3/5m.';

-- Schedule only the existing restricted shadow Edge Function. The credential stays in Vault.
select cron.schedule(
  'leader-emerging-shadow-fd1audit',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/leader-emerging-shadow',
      headers := jsonb_build_object('content-type','application/json',
        'x-shadow-le-credential',
        (select decrypted_secret from vault.decrypted_secrets where name='leader_emerging_shadow_db_password')),
      body := '{"mode":"fd1audit"}'::jsonb,
      timeout_milliseconds := 30000
    )
    where exists (select 1 from shadow_le.control where singleton and enabled);
  $job$
);

select cron.schedule('leader-emerging-shadow-fd1early','* * * * *',$job$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/leader-emerging-shadow',
    headers := jsonb_build_object('content-type','application/json',
      'x-shadow-le-credential',(select decrypted_secret from vault.decrypted_secrets where name='leader_emerging_shadow_db_password')),
    body := '{"mode":"fd1early"}'::jsonb, timeout_milliseconds := 30000)
  where exists(select 1 from shadow_le.control where singleton and enabled);
$job$);
