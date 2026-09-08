# V17 exit tests

From `Trading_Boo_V17_Exit_Review_20260908.zip`. The package shipped these tests
pointing at its own `source_after/` copies; the imports here were repointed at the
repository's real sources under `supabase/functions/` and `gateway/`, which is what
makes them an integration check rather than a self-test — the repo's
`leader-momentum-v17.mjs` is not byte-identical to the package's copy of it.

```bash
node --test test-support/v17-exit/*.test.mjs
```

`evidence/` keeps only the three fixtures the tests read (`positions.json`,
`decisions.json`, `orders.json`). The package's replay tapes and 1m bars are not
here; they are only needed by `scripts/replay_r4.mjs`, which is not part of this
repository.

Note that most of these tests cover the R3/R4 review modules, which no live code
imports. See `UPDATE_V17_EXIT_RELIABILITY_20260908.md` for what is actually wired
into the production exit path.
