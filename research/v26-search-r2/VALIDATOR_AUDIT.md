# Validator use note

No validator repair was performed in this strategy-search iteration. The completed validator at `f5ee84bfd5449189d73ccee56aabcbd51a2de53a` was reused.

- Integrity and candidate regression suite: 23/23 pass.
- Binance Vision checksum, cache-stable content hashing, cutoff coverage and per-month fallback remained active.
- Direct sequential funding lookup was stopped when it became slow before any summary was produced. No incomplete result was evaluated.
- The completed attempt used an explicit Binance USD-M funding cache with full symbol/window coverage; no failure was converted to zero funding.
- New candidates used `STRENGTH_LOSS_V1`; legacy time-only exit was not enabled.
- Quantity remained exclusively `solveQuantity.plan.quantity`.
- Account-level results retained min-notional, margin, one-slot, consecutive-loss and daily/weekly protections.
