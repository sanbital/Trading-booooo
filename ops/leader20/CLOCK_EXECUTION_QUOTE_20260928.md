# Clock BUY execution quote ordering

The first natural slot after PR #258 (2026-09-28 23:20 KST) created one batch,
completed DeepSeek and all 19 valid GPT FINAL reviews before 23:22, with one BUY,
14 WAIT and four SKIP decisions. All reviews retained TOP20_CLOCK_GPT_FINAL_3,
the same frozen trajectory and requires_final_recheck=false.

NMR's BUY was blocked before an order intent: its quote was 2193 ms old at the
execution safety check, exceeding the unchanged 1000 ms limit. Its spread was
8.6311 bps and displacement 0.0863856%, within the existing 25 bps / 2.5% limits.
Database/lease reads had aged a quote acquired earlier in the executor.

Clock execution now reads its quote after parallel account/ownership reads and,
at the actual IOC boundary, after durable order intent, lease and generation
checks. The last quote is validated against the same immutable BUY authority;
no database await follows it before the gateway send. Its receive/check times,
bid/ask and expiry are recorded with the existing IOC send timestamp. The same
ordering applies to the existing bounded IOC retry. General authority checks
continue to enforce frozen identity and slot expiry while quote safety belongs
to the venue boundary. Legacy entry checks are unchanged.

No strategy, position sizing, budget, freshness/spread/gap limit, capture window,
retry count, exchange lease or deadline is relaxed. PR #258 remains intact.
Expired signals are never replayed.

The named `clockExecutionStep` obtains a new gateway quote; admission/E1 `q`
cannot be passed to it. Each safety boundary refreshes a stale gateway response
once, with a maximum of two refreshes across the execution attempt. Timeout is
bounded by remaining slot TTL. Refreshes never send orders, re-run AI or acquire
another trajectory. Execution metadata is held separately from the frozen ticket.

Wake analysis: NMR's API answer completed at 14:21:14.669 UTC and its durable
journal completed at 14:21:14.820075. The admission quote arrived at 14:21:32.105;
the first safety check ran at 14:21:34.298. The latter 2193ms is directly evidenced.
Historical wake/lease timestamps were not recorded, so the preceding 17.285s
cannot be attributed exactly between resumption, queue work and prerequisites.
There is no fixed 20-second clock-BUY sleep. Code inspection found sequential
review reads and unrelated WAIT/SKIP lifecycle writes before execution. Clock
review reads now have bounded concurrency four, results keep queue order, a
durably validated ready BUY is prioritized by the existing resume mechanism,
and unrelated diagnostics remain attached to the request without blocking it.
Protection/exit scheduling and lease admission remain unchanged.

The additive execution journal records every valid clock BUY plus wake, execution,
quote, intent, actual gateway-send and exchange fill timestamps when known. It
derives GPT-to-wake/quote/order and quote-to-order latency. First execution failure
is preserved independently of later terminal expiry. Existing facts are backfilled;
unknown historical timestamps remain NULL. Journal writes use existing audit/order
transactions or background wake notes, never an await between quote and send.

Regression coverage executes the actual IOC dispatcher with the original NMR
coordinator and a mock exchange: slow durable I/O followed by a fresh quote sends
once without a new capture or AI call. Stale/missing/unavailable quotes,
catastrophic spread/gap, changed frozen snapshot, and expiry during the final
quote request send no order.
