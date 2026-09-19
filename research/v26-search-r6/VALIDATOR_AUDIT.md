# Validator use note

No validator repair was performed in R6. The completed validator at `f5ee84bfd5449189d73ccee56aabcbd51a2de53a` was reused.

- Integrity and candidate regression suite: 27/27 pass.
- Binance Vision checksum, cache-stable content hashing, cutoff coverage and per-month fallback remained active.
- Funding coverage was explicit for every opportunity interval; no failure was converted to zero funding.
- C28-C30 consumed completed 1m candles only and entered at the next open; no completed close was retroactively filled inside its own bar.
- New candidates used `STRENGTH_LOSS_V1`; legacy time-only exit was not enabled.
- Quantity remained exclusively `solveQuantity.plan.quantity` and all account protections remained enabled.
