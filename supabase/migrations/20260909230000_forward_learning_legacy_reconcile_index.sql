-- forward-learning's checkpoint reconcile was timing out, and had been for weeks.
--
-- pendingForCheckpoint() asks scanner_candidates for BUY rows that carry neither a `lob`
-- nor a `scalp` snapshot -- the shape the legacy scanner wrote. Those two predicates are
-- JSONB expressions with nothing to index, so the planner used
-- scanner_candidates_pending_learning_idx for (decision, created_at, intended_horizon_hours)
-- and then detoasted `snapshot` for every BUY row to evaluate them.
--
-- The table is 840k rows / 610 MB of heap with 12 GB of TOAST -- roughly 14 KB of snapshot
-- per row -- and 43,470 of those rows are BUY. Measured on production: 1,143 BUY rows cost
-- 2.66 s to filter, so the full sweep runs about 100 s. The statement timeout cut it off,
-- PostgREST returned 57014, and the workflow's four checkpoint calls all failed with
-- "forward store 500". Every three hours, since the schedule was added.
--
-- Nothing was ever found: zero of the 43,470 BUY candidates have the legacy shape, and the
-- table has not been written since 2026-08-21. The query scanned 13 GB to return nothing,
-- and because it orders by created_at ascending it restarted from July on every run.
--
-- A partial index on exactly that predicate makes the answer immediate. Building it does
-- not have to detoast the whole table: the AND short-circuits on `decision`, so the 796k
-- non-BUY rows never touch TOAST. The finished index is 8 KB, because it indexes the empty
-- set -- and it will stay correct if legacy-shaped candidates are ever written again.
--
-- Measured after: 0.143 ms, one buffer hit, JSONB filter gone from the plan.
--
-- Read-path only. No trading logic, no scanner behaviour, no data is changed.
create index concurrently if not exists scanner_candidates_legacy_forward_idx
  on public.scanner_candidates (created_at, intended_horizon_hours)
  where decision = 'BUY'
    and (snapshot ->> 'lob') is null
    and (snapshot ->> 'scalp') is null;

comment on index public.scanner_candidates_legacy_forward_idx is
  'Serves forward-learning pendingForCheckpoint(). Empty by design: it indexes legacy-shaped '
  'BUY candidates, of which there are currently none. Without it the reconcile detoasts every '
  'BUY row (~100 s) and dies on the statement timeout.';
