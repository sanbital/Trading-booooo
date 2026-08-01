# supabase/migrations

## This directory is not automatically the truth

The database is the truth. What has actually been applied lives in
`supabase_migrations.schema_migrations`, and on 2026-08-01 five migrations were in there
with no counterpart here — applied straight to the project and never committed.

That gap caused a live incident. A change rebuilt `guard_lob_sell_order_v714` from the
newest definition *in this directory*, which was two generations behind the deployed one,
and silently reverted a deliberate safety fix: planned-stop authority stopped depending on
a diagnostic reason string, and the rebuild put that dependency back. Any stop raised under
another reason — the max-single-loss backstop, an emergency liquidation — lost its
unconditional escape for as long as it took to notice.

**Before regenerating any function that already exists in production, read what is
deployed:**

```sql
-- what has run, newest first
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 30;

-- the exact SQL of one of them
select array_to_string(statements, E'\n;\n\n')
from supabase_migrations.schema_migrations
where version = '<version>';
```

If a version appears there and not here, recover it into this directory before touching
whatever it defines. `pg_get_functiondef()` on the live object works too, and is the
shorter path when you only need the current shape.

## Applying migrations

`main.deploy-supabase` passes `psql` a hand-maintained `--file` list in a single
transaction. It does **not** scan this directory. A new file that is not added to that list
is never applied, and the deploy still reports success — the failure is silent. Check the
list when you add a migration.

Every entry in that list re-runs on every firing, so anything in it must be re-runnable:
`create or replace`, `add column if not exists`, constraints behind an existence check.
A migration carrying a one-time `update` or a fixture-based assertion does not belong there.

## Assertions inside migrations

Some migrations end with a regression check. Keep those checks free of anything an operator
is expected to tune. `20260729232553` pinned an excursion against the thresholds in force
the week it was written; when those thresholds moved, the check began aborting the whole
batch, and the deploy path stayed dead for days. Derive fixtures from the same values the
code under test reads.
