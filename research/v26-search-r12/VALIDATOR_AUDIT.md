# Validator use note

No validator repair was performed in R12. The completed baseline was reused.

- Integrity and candidate regressions: 33/33 pass.
- Replay had explicit verified funding coverage for every required symbol and never substituted zero on failure.
- C36 grouped only already-completed C34-eligible trigger evidence and entered at or after the completed cycle boundary.
- The unchanged entry-drift and structural-stop checks were reapplied at the delayed entry open.
- No later candle, final excursion or result entered auction selection.
- Exit remained `STRENGTH_LOSS_V1`; `solveQuantity.plan.quantity` and all account protections remained enabled.
