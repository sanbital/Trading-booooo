# Capture only when an entry slot is affordable

The clock watch RPC now uses the same `leader20_batch_capacity()` authority as
paid entry review. A zero available-slot result removes every watch that lacks
`OPEN_POSITION`, including an unheld BTC market sensor. Open/remaining/unsettled
holdings retain the existing watch and exit-management path. With no holdings,
the watch is empty but the collector continues control heartbeats, so deposits
or released margin can be detected without restarting it.

The existing capacity calculation includes available futures quote balance,
pending-order reservations, the slot limit, and fee/rounding headroom. Its current
first-slot threshold is 152.121375 USDT, derived by the existing capacity authority;
this change adds no separate balance threshold. Missing, stale or incomplete
account evidence also pauses entry collection rather than assuming funds exist.

A funded watch during the minute before capture admits that fixed clock window.
Losing capacity clears admission. Recovery during capture waits for the next
preparation window, preserving a complete two-minute path. Clock boundaries and
AI entry-capacity checks are unchanged. The collector consumes watch updates on
its existing 15-second control poll; it closes removed streams on that update.
Already in-flight capture rows may finish ingesting during that transition.

This is a database-only change. It does not alter executor/generator bundles,
collector code, sizing, leverage, provider budgets or native protection. The BTC
sensor is optional context under its existing contract; its absence cannot veto
the held symbol's existing trade evidence or native exit protection.

Verification uses actual PostgreSQL migration bodies and the existing capital
authority: just below/exactly at the minimum, held/unheld BTC, no holdings, funding
loss and recovery, next-window admission, pending capital, stale/unreadable
accounts, unchanged ingest delegation, and anonymous access denial. The complete
fixed-window claim/materialization/expiry suite runs with this migration applied.
