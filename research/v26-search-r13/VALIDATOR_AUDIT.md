# Validator use note

No validator repair was performed in R13. The completed baseline was reused.

- Integrity and candidate regressions: 34/34 pass.
- Replay had explicit verified funding coverage for every required symbol and never substituted zero on failure.
- C37 reservation used exactly sixty bars completed before each setup timestamp.
- Reserved setups used the ordinary immediate trigger path; no post-trigger delay or retroactive price was introduced.
- No later candle, final excursion or result entered reservation selection.
- Exit remained `STRENGTH_LOSS_V1`; `solveQuantity.plan.quantity` and all account protections remained enabled.
