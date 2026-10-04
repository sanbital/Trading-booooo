Futures reads use one authenticated user data stream and two multiplexed public
streams on the dedicated Binance gateway. The 5s deterministic scheduler and the
120s/24 bucket capture collector keep their existing contracts.

The user stream covers ACCOUNT_UPDATE, ORDER_TRADE_UPDATE, ALGO_UPDATE and
ACCOUNT_CONFIG_UPDATE. A complete REST account/ordinary-order/algo-order snapshot
is taken after connection, after any private change, after a local venue mutation,
and at a 15 minute integrity boundary. Concurrent callers share that snapshot
acquisition. An event during acquisition discards the ambiguous snapshot, with at
most two attempts. No events are merged across an ambiguous REST boundary. This
cache never becomes an order ledger or a source of order ownership.

A matching private ping/pong within 2.5s proves live transport. Account observations
retain their REST snapshot identity/times and carry a separate stream generation,
revision, pong time and validation time. Missing pongs, disconnects, malformed or
out-of-order events and local mutations invalidate them. FINAL reads the current
stream observation, and the signed order boundary requires that exact account
generation/revision/snapshot within the unchanged 3s account window. A change is a
PRE_SEND data refusal; it is not an uncertain exchange result. Existing writer
owner/fence, submission 3s, capture 10s and lease remaining >30s checks still apply.
DB restart and incident recovery explicitly request independent REST observations.

With positions held, fresh 1s mark streams can only reduce available spending from
the authenticated snapshot for adverse PnL or increased initial margin. Favorable
PnL cannot invent capacity. Missing marks or unsupported positions require bounded
REST recovery. A disconnected user stream permits at most one ordinary fallback
account/order acquisition per 10s, sharing the original response for 1s. OPEN cannot
use that fallback as stream submission authority; reduce-only safety paths retain
REST recovery. Global REQUEST_WEIGHT and 429/418 cooldown admission still apply.

Execution books reuse the collector's single committed Book implementation:
REST depth bootstrap, U/u/pu continuity, bounded buffers, finite snapshot coverage,
gap invalidation and bounded resync. Quotes use actual exchange/receipt times and
the unchanged 1.5s book window. Quotes never trigger per-candidate REST fallback.
The two combined sockets subscribe incrementally, so continuing Top20 membership
does not reset a book on an epoch replacement. Recovery is limited to two concurrent
snapshots, 500 bootstrap weight in the first minute, then 100 weight/min. The market
capture collector and strategy gates are unchanged.

Reference reads keep their original timestamps: exchange filters 15min, fees 5min,
explicit authenticated position mode 2.5s (still checked within the existing 5s
consumer window). Position mode has no equivalent complete passive stream proof,
so this small REST read is retained and shared. Account config events invalidate
mode/fee caches. Order create, exact-ID finality and unresolved fill/fee recovery
remain REST. No write, authority, order result, quote or signed payload enters the
reference cache.

Sources verified 2026-10-04:
https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams
https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect
