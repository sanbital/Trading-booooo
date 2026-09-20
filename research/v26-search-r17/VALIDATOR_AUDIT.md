# Validator use note

No validator repair was performed in R17. The completed baseline was reused.

- Integrity and candidate regressions: 38/38 pass.
- C41 used only completed 15m feature snapshots and contemporaneous eligible peers.
- A missing funding span stopped the first replay before evaluation. The final replay used explicit verified coverage for every required symbol and never substituted zero.
- Entry, structural stop, `STRENGTH_LOSS_V1`, `solveQuantity.plan.quantity` and all account protections remained unchanged.
- Dataset quality passed with 0 blocked cutoffs out of 2,880.
