# Independent sampled-book paper accounts

This corrects a validation gap, not a proven profitability improvement. The previous
observer compared exits using a real position's state and could not simulate changed
cash, slots or subsequent opportunities. `paper-accounts.mjs` instead starts every
frozen variant flat with its own hypothetical 100 USDT wallet, positions, losses,
pending entry reservations, partial exits, peak and ratcheted stop.

The protocol was frozen at 2026-09-11 12:01:23 UTC, before collecting new input. It
keeps the current 40 USDT / 3x / 10-slot envelope and does not change real risk settings.
Partial IOC fills can use less margin. Each variant's loss counter uses only its own
closed paper trades; no real-account profit or loss history is imported.

## Inputs and timing

The existing order-free observer now also reads public all-symbol bookTicker and
exchangeInfo. It stores L1 bid/ask/visible quantities/timestamps for every valid USDT
book, plus the top-10 symbols' contemporaneous LOT_SIZE, PRICE_FILTER and MIN_NOTIONAL
rules. De-ranking does not delete a held paper position's price observations.
Only the existing private analytics table is written. No schema change is required.

Use the market snapshot's reception time, after all inputs arrive, as the frame clock.
Signal freshness is checked again at that time. Future, stale or missing quotes never
become fills. Old observer rows have no L1 data: the CLI reports/excludes them instead
of fabricating prices from candle closes. Observation gaps invalidate complete-drawdown
reporting; known-snapshot drawdown is explicitly named as such.

For every frame, manage existing positions first, settle due hypothetical intents,
then examine the historical scanner candidates in their recorded order. Pending
entries reserve cash and a slot. The same signal is consumed only after a dispatch or
a candidate rejection; temporary cash/slot blockage can be reconsidered while fresh.
The executor's one-dispatched-order-per-cycle behavior is retained.

An IOC never fills above its original limit; its quantity is capped by recorded ask
size. An exit fills at observed bid less the explicit stress impact, not at an ideal
stop price. Insufficient visible bid size leaves a residual and a pending exit. A
repeated unchanged book does not replenish already-used liquidity. Once an exit is
triggered, a later rebound cannot erase that pending intent. Fees debit the wallet
once, including on entry; open positions and occupied margin remain in valuations.

## What this still cannot prove

L1 snapshots are not actual fills or a depth/queue simulation. Native stop crossing
between samples, liquidation, funding cash flows, exchange latency, precise IOC
rounding at the gateway and the production scheduler's exact order are not fully
reproduced. The flat virtual starting account is not the live account. Manual holdings
are not imported. `livePromotion` and `fundingVerified` remain false.

Current-state exit comparisons still stored by the observer are a separate diagnostic;
only the offline account engine advances independent candidate positions. The cron
collects replay inputs, not independently persisted paper portfolios.

## Verification and use

The new tests cover freed-slot replacement opportunities, fee/MTM/cash conservation,
partial entry/exit, unchanged depth, latency and persistent exit intent, reservations,
duplicate signals, deferred cash opportunities, missing-quote isolation, future/stale
quotes, restart replay, conflicting/reversed frames, gaps and independent loss counters.
Run the full existing regression with the pinned PGlite module as before.

Export `policy_version,slot_at,observed_at,payload` from `v18_strategy_shadow_runs` in
chronological order. Record pagination completeness for longer observation intervals.
Then run:

```sh
node research/20260911_trade_audit/replay-paper.mjs observations.json results.json
```

Normal, fee/impact stress and fee/impact/60-second-delay scenarios are compared from
the same immutable input. Inspect trade counts and unfilled IOC outcomes: a stress
scenario with no trades is not a successful strategy.

The observer remains `V18_STRATEGY_SHADOW_1` for the frozen candidate policy, while
`collectorVersion=V18_MARKET_OBSERVER_2` and market schema `V18_PAPER_MARKET_1` identify
the new input. Compare the deployed source to the tested SHA and verify stored books,
rules and three scheduled observations. Existing cron job and authentication remain.
No trading function is deployed with this change.

Rollback: selectively redeploy the old observer's five source files at commit
`1a844601d23cb7c36a1bc9956a538b6114f84f6a`; retain collected rows. To stop only this
observer, unschedule `v18-strategy-shadow-observe`. Neither action modifies live
orders, controls or positions.

Official API references checked for the new public reads:
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
- https://supabase.com/docs/guides/functions/deploy

Binance documents bookTicker's weight header as inaccurate; the host does not use that
header as the limit guard. Other endpoints retain the existing weight guard. Regional
or rate-limit denials are not retried through alternate hosts.
