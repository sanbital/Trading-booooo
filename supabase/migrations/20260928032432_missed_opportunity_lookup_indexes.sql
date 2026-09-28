-- The 3,000-signal audit joined each signal to two unindexed child tables.
-- Both regular audit lanes timed out at 120 seconds. Preserve the exact audit
-- function, classifications, schedules and trading state; index lookup keys only.
-- Current production heaps are <1 MB each. Fail fast instead of waiting on
-- trading writes or taking an unbounded build lock.
set local lock_timeout = '500ms';
set local statement_timeout = '3s';

create index gpt_final_entry_reviews_production_signal_created_idx
  on public.gpt_final_entry_reviews (signal_id, created_at, completed_at)
  where purpose = 'PRODUCTION';

create index v11_long_regime_orders_open_signal_created_idx
  on public.v11_long_regime_orders (signal_id, created_at)
  where intent = 'OPEN_LONG';
