# Validator use note

No validator repair was performed in R16. The completed baseline was reused.

- Integrity and candidate regressions: 37/37 pass.
- Missing historical rank observations were UNKNOWN/reject, never inferred from later data.
- No candidate reached an executable holding interval; funding remained fail-closed and was never substituted with zero.
- Entry, structural stop, `STRENGTH_LOSS_V1`, `solveQuantity.plan.quantity` and all account protections remained unchanged.
