# Partial IOC retry reconciliation

An initial IOC can fill only part of its requested quantity. If the residual retry falls below the gateway's entry minimum, the gateway rejects it before contacting Binance. The existing never-placed recovery requires a flat symbol. Consequently, the legitimate first fill prevents the refused remainder from settling, keeps the account circuit open, and excludes that position from ordinary profit management. Its native protective stop remains active.

`FD1_PARTIAL_RETRY_RECONCILIATION_1` recognizes only this second-attempt, pre-dispatch minimum-margin rejection. Recovery requires a fresh exact-client Binance absence response, complete recent order history containing only the terminal parent order, exact parent trade IDs and totals, and an unchanged owned position matching both the database and a fresh exchange portfolio. Extra fills, other orders, changed exposure, stale evidence, ambiguous errors, or missing evidence leave reconciliation unresolved.

Only the never-accepted retry is settled as rejected. The first fill stays owned and filled. The existing execution lease, compare-and-swap write and account recovery gate remain authoritative. This path cannot place an order, resize exposure, change stops, or directly reopen the account circuit.

Validation: 305 entry, exit and operational regression tests passed locally, including 12 new partial-retry tests. Node syntax checks passed. This is an operational correction, not a demonstrated improvement in trading-policy profitability. It changes no GPT/DeepSeek judgment, entry/exit policy, 150 USDT target margin, 3x leverage or ten-slot limit.

The historical CEC0040 bootstrap workflow is restricted to its historical release branch. Routine executor fixes on main must not rerun its one-time activation or unrelated deployment. Production release must preserve the latest deployed shared AI modules and replace only the executor entrypoint and this new helper; pre-existing repository/deployment drift must be recorded separately. Verify recovery through the natural scheduled executor, without forced database repair or synthetic trading requests.
