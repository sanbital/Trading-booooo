# Validator use note

No validator repair was performed in this strategy-search iteration. The frozen completed validator at `f5ee84bfd5449189d73ccee56aabcbd51a2de53a` was reused.

- Integrity and candidate regression suite: 22/22 pass.
- Binance Vision checksum, cache-stable content hashing and per-month fallback remained active.
- Funding failed closed on a transient direct-provider timeout. No result was emitted by that attempt.
- The completed attempt used an explicit Binance USD-M funding cache with full symbol/window coverage.
- New candidates used `STRENGTH_LOSS_V1`; legacy time-only exit was not enabled.
- Quantity remained exclusively `solveQuantity.plan.quantity`.
