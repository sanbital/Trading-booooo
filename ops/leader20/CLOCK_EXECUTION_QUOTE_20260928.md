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

Regression coverage executes the actual IOC dispatcher with the original NMR
coordinator and a mock exchange: slow durable I/O followed by a fresh quote sends
once without a new capture or AI call. Stale/missing/unavailable quotes,
catastrophic spread/gap, changed frozen snapshot, and expiry during the final
quote request send no order.
