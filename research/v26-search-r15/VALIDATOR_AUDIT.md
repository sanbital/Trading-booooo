# Validator use note

No validator repair was performed in R15. The completed baseline was reused.

- Integrity and candidate regressions: 36/36 pass.
- Replay had explicit verified funding coverage for every required symbol and never substituted zero on failure.
- C39 used only current and prior completed 15m snapshots; missing coverage was UNKNOWN/reject.
- Entry remained on the ordinary next-open trigger path; no delayed or retroactive fill was introduced.
- Exit remained `STRENGTH_LOSS_V1`; `solveQuantity.plan.quantity` and all account protections remained enabled.
