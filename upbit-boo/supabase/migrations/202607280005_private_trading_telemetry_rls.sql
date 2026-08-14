-- Keep the decision ledger and latency telemetry private to trusted backend roles.
--
-- Both tables are written/read by Edge Functions with the service-role key. They do not
-- contain a user ownership column and are not part of the public dashboard API, so an
-- anon/authenticated policy would only widen the attack surface.

alter table if exists public.trading_decisions
  enable row level security;

alter table if exists public.trading_latency_samples
  enable row level security;

-- Defense in depth: RLS with no policies makes every row invisible to public API roles,
-- while revoking table privileges prevents those roles from attempting direct access.
revoke all privileges on table public.trading_decisions
  from public, anon, authenticated;

revoke all privileges on table public.trading_latency_samples
  from public, anon, authenticated;

-- The latency table uses a bigserial key. Public roles do not need sequence access either.
revoke all privileges on sequence public.trading_latency_samples_id_seq
  from public, anon, authenticated;
