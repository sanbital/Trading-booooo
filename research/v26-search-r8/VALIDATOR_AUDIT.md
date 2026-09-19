# Validator use note

No validator repair was performed in R8. The completed baseline was reused.

- Integrity and candidate regressions: 29/29 pass.
- The first replay failed closed on missing funding coverage; it was not evaluated.
- The completed replay had explicit funding coverage for every opportunity interval and never substituted zero on failure.
- The rolling percentile helper is causal: each record sees only equal or earlier timestamps.
- Buyer and seller notional inputs use only four completed one-minute bars ending at the trigger.
- Entry remained the next open after completed trigger evidence; exit was `STRENGTH_LOSS_V1`.
- `solveQuantity.plan.quantity` and all account protections remained enabled.
