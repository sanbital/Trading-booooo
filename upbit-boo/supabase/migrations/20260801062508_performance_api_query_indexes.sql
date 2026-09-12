-- Reconstructed from supabase_migrations.schema_migrations.statements.
-- This migration was applied directly to the database and never committed, which is how
-- v7.3.0 came to rebuild the sell guard from a stale source and silently revert it.
-- Recorded here so the repository matches what actually ran. The filename carries the
-- applied version, so a full ordered replay still ends on the newest definition.


create index if not exists trading_account_snapshots_captured_at_idx
  on public.trading_account_snapshots (captured_at desc, id);

create index if not exists trading_joint_objective_performance_window_idx
  on public.trading_joint_objective_snapshots (captured_at, id)
  where engine_version in (
    '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE',
    '6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION'
  );

create index if not exists trading_orders_requested_at_idx
  on public.trading_orders (requested_at, id);

create index if not exists trading_fills_executed_at_idx
  on public.trading_fills (executed_at, id);

create index if not exists trading_positions_performance_live_idx
  on public.trading_positions (created_at, id)
  where is_paper = false
    and state in ('OPEN','EXITING','CLOSED');
