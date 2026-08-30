# V10 continuation evidence freeze — audit 1

## Repository state

- Audited branch: `v10-continuation-20260830`
- Audited HEAD: `c276484b8db93dbb3ea5812fa28199d9201b18e8`
- Main at audit: `0b178b6967f7224e436d919e56de0055090b114a`
- The handoff SHA `c27648ae66b59913fe1b2e6418b6949188868b49` is not a commit in the repository.
- The branch contains research-only continuation changes. No R4/R5/R6 continuation strategy is integrated into `market-autotrader`.

## Machine-verified evidence corrections

1. R3 selected and confirmed neither RANGE nor BEAR. The artifact’s `preselected` and `confirmed` fields are both null for both lanes.
2. R4 did not confirm a RANGE lane. `R4_RANGE_CYCLE_RESID_MR_0021` passed its basic and LOO checks but failed its parameter-plateau gate. The R4 BEAR preselection failed the 2023 confirmation.
3. R5 three-period output selected neither lane. A later file manually locked the R4 RANGE candidate despite the earlier plateau failure.
4. The actual committed final TEST window is `2025-11-02` through `2026-01-01`, not `2025-10-08` through `2026-01-01`.
5. R5 and R6 both observed the same six trades: 969.273 stress bps, 161.545 mean stress bps/trade, PF 2.7845, OP top asset, and 33.33% maximum asset exposure.
6. R5 accessed the final window first. R6 repeated it and therefore is not independent evidence.
7. Both final runners used a 40% asset-exposure cap. Under the non-negotiable 25% cap, 33.33% fails.
8. R5 enforced `sign_req=true`; R6 omitted that field and did not enforce the sign condition. Identical observed trades do not establish implementation parity.
9. Workflow completion is recorded separately from statistical release. Every historical final result remained unreleased.

## Untouched-window decision

Repository history, workflows, and known artifacts contain no execution of `run_r5_range_2026_supplement.py`. Its historical lock is not release-grade: it ends on 2026-08-01 and uses materially weaker gates, including a 40% asset cap. It must not be run as authoritative evidence. A new append-only superseding lock is required before any 2026 supplemental data access.

## Corrected release decision

- RANGE: not validated for production.
- BEAR: no validated candidate.
- Production continuation release: none.
- Existing BULL behavior and fail-closed CASH routing remain the only defensible production baseline until new evidence passes immutable gates.

Historical files were not rewritten. The provenance ledger, superseding R6 audit, evidence table, exact gate tests, and canonical strategy fingerprints are append-only corrections.
