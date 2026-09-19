# Validator use note

No validator repair was performed in R11. The completed baseline was reused.

- Integrity and candidate regressions: 32/32 pass.
- Replay had explicit verified funding coverage for every required symbol and never substituted zero on failure.
- C35 applied the unchanged causal C34 percentile gate, then selected from identical completed trigger timestamps only.
- Selection used pre-entry score and deterministic lexical id tie-breaking; no later candle or outcome was visible.
- Entry remained the next open after completed evidence; exit was `STRENGTH_LOSS_V1`.
- `solveQuantity.plan.quantity` and all account protections remained enabled.
