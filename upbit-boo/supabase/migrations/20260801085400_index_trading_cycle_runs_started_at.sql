-- Keep autotrader status reads from sorting the full cycle history.
-- Production was created with CREATE INDEX CONCURRENTLY to avoid blocking live writes.
CREATE INDEX IF NOT EXISTS trading_cycle_runs_started_at_idx
ON public.trading_cycle_runs (started_at DESC);
