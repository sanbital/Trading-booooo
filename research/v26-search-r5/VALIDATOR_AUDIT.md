# Validator use note

No validator repair was performed in this strategy-search iteration. The completed validator at `f5ee84bfd5449189d73ccee56aabcbd51a2de53a` was reused.

- Integrity and candidate regression suite: 26/26 pass.
- Binance Vision checksum, cache-stable content hashing, cutoff coverage and per-month fallback remained active.
- The first replay attempt failed closed on ALLOUSDT missing from the R4 funding cache; no summary from that attempt was produced or evaluated.
- The completed attempt used an explicit Binance USD-M funding cache with full symbol/window coverage; no failure was converted to zero funding.
- C25-C27 entered only at the open after two or three fully completed evidence bars; no completed close was retroactively filled inside its own bar.
- New candidates used `STRENGTH_LOSS_V1`; legacy time-only exit was not enabled.
- Quantity remained exclusively `solveQuantity.plan.quantity` and all account protections remained enabled.
