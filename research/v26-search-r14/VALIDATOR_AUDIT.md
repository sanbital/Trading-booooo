# Validator use note

No validator repair was performed in R14. The completed baseline was reused.

- Integrity and candidate regressions: 35/35 pass.
- Replay had explicit verified funding coverage for every required symbol and never substituted zero on failure.
- C38 used only completed candles and the existing historical market-participation calculation.
- Entry remained on the ordinary next-open trigger path; no delayed or retroactive fill was introduced.
- No later candle, final excursion or result entered candidate selection.
- Exit remained `STRENGTH_LOSS_V1`; `solveQuantity.plan.quantity` and all account protections remained enabled.
