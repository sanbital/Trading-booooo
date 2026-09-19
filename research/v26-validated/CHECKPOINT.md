# V26 research checkpoint — validator integrity run 2

Generated: 2026-09-19T08:50:20Z

Scope: research-only. No main merge, production deploy, order, account-setting change, approval change, circuit change, or live-position mutation was performed.

## Starting point

- Baseline research head: `7b6a0c3d9f7b5d835161cbb2ed3273d3fc194c34`
- Integrity branch before this run: `8bcc37f4f3ec1db49814b2241695a81f4c2e9e2e`
- Existing conclusion remains `no_robust_edge_found=true`.
- The stored C12 90d result is already used evidence and is not a new holdout.

## Completed in this run

1. Extended `research/v26-validated/data-source-integrity.mjs` with a fail-closed connector-enriched funding-cache reader.
   - A zero-event funding result is accepted only when an explicit coverage interval spans the requested holding interval.
   - Missing symbol/range coverage throws `FUNDING_CACHE_COVERAGE_MISSING`; it is never converted to zero funding.
2. Added `cutoffCoverageSummary(...)` so `blocked15mCutoffs`, expected/evaluated symbol counts, and coverage can be derived from actual completed-bar availability instead of a hard-coded report value.
3. Added regression tests for:
   - verified zero-event funding-cache coverage versus missing coverage;
   - event filtering inside a covered funding interval;
   - cutoff coverage where one cutoff is blocked and the next is complete.
4. GitHub Actions workflow `V26 validator integrity research` completed successfully on commit `94709ee39c278c0fcd795785aa15ac25f502f0d4`.

Relevant commits:

- `defabea668ca75d88992807696a0b86165121039` — add funding cache and cutoff quality helpers
- `94709ee39c278c0fcd795785aa15ac25f502f0d4` — add regression tests

## Still unresolved / promotion blocked

The production-independent validator source `research/v26-validated/binance-30d-validation.mjs` has not yet been replaced or promoted. At the audited source it still contains all of the following legacy behavior:

- `/fapi/v1/fundingRate` returns an empty array in the offline `get(...)` stub;
- funding collection catches failures and converts them to `[]`;
- 15m Vision retrieval returns all monthly rows when any requested month exists, so a missing month can avoid per-month daily fallback;
- cache hits do not participate in the old streaming `datasetHash` in the same way as downloads;
- report `blocked15mCutoffs` is hard-coded to `0` even though `cutoffState` is computed during recomputation;
- existing exit replay still includes time-based `V17_MAX_HOLD` and `V17_MOMENTUM_STALE`, which must remain only for reproduction of old C0-C12 evidence and must not silently become the user's new strength-loss exit policy.

Because these gaps remain in the actual replay entry point, no new candidate performance was generated or promoted in this run. A CI success is not a strategy pass.

## Data-window discipline

`research/v26-validated/USED_WINDOWS.json` remains authoritative. The reserved 90d block `2025-12-22T15:10:00Z` to `2026-03-22T15:10:00Z` remains untouched and must not be queried for candidate outcomes until the validator is integrated and the next candidate is frozen.

## Next required step

Wire the tested integrity helpers into an isolated replay entry point, require explicit funding-cache coverage for every executed/shadow holding interval, derive cutoff quality from actual data, and rerun only an already-used window first. If the integrated replay differs materially from stored C0-C12 evidence, reclassify affected results before designing C13+. Do not consume the reserved unused holdout during integration debugging.
