# Production reconciliation baseline

Observed 2026-09-26: main `5f870b7db892b8d7160809f6cf2d1ca757afa591`; executor v97 ACTIVE, artifact `5b562a53085d27c3f02f0d216e009d551e4494b9510e49299ebfbcc553e8617a`.

Downloaded all 60 executor source files. Compared each normalized source with main. Thirteen existing files differ; three production-only files are assessment.mjs, capture-context.mjs and dual.mjs. The machine-readable comparison is retained in the audit workspace. Production files are restored verbatim; main-only files remain. Main's partial IOC retry reconciliation is already present in v97 and is preserved. PR #188 remains draft and is not a deployable baseline.

Preserved production changes: FD1_DUAL_AI_ENTRY_1, RC2, GPT judgment contracts, V30/B06133 evidence routing, live chase evidence, same-symbol closed-trade memory, trajectory capture, dynamic multi-slot admission, CEC0040, native protection, fencing, account reconciliation, bounded IOC retry and partial-fill management.

Live sizing verified from deployed source and DB: margin 150 USDT, leverage 3, MAX_SLOTS 10. No sizing or activation changes.

Baseline regression: 399 tests passed, zero failures (FD1, SQL journal/accounting, V17 entry and exit). Two outdated test assertions were aligned with already-deployed RC2/chase behavior; production logic was not changed to satisfy old assertions. PGlite 0.3.14 is the repository-pinned SQL test dependency.

Original dirty checkout remains untouched. Reconciliation is isolated in codex/production-gpt-arbitration-20260926. No production deployment occurred during reconciliation.
