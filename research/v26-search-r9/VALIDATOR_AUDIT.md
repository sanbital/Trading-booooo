# Validator use note

No validator repair was performed in R9. The completed baseline was reused.

- Integrity and candidate regressions: 30/30 pass.
- The first replay failed closed on missing funding coverage and was not evaluated.
- The completed replay had explicit funding coverage for every opportunity interval and never substituted zero on failure.
- C33 used only completed trigger geometry and pre-fixed costs; next-open price and future MFE were excluded.
- The rolling percentile helper remained causal and saw no later timestamp.
- Entry remained the next open after completed evidence; exit was `STRENGTH_LOSS_V1`.
- `solveQuantity.plan.quantity` and all account protections remained enabled.
