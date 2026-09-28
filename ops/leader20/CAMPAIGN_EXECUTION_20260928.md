Production baseline: main c7c1d688fb26432ef238924db91a69221d129200; executor v138;
generator v36; batch audit v11 (closed); working release df34876. The executor and
generator downloads matched this release except the intentionally staged batch v3.

The observer was running once a minute with watch_limit=10. Paid batch execution
and provider ledgers were disabled. The active fallback paced entry reviews globally
at roughly thirty minutes; original execution candidates still expired at 120 seconds.
Provider control was USD3/day and USD95/month, with 100 parent reviews/day.

This release keeps the original candidate TTL and all order/position safety modules.
WATCHING -> ENTRY_CANDIDATE -> GPT -> WAITING/PAUSED or APPROVED -> fresh FINAL
RECHECK -> existing locked ORDERING/FILLED path. WAIT or stale candidates retain
the campaign. The next event receives a new signal ID, timestamps, price and capture
hash. Missing capture acquisition retries for at most 6.5 seconds; the existing
durable recovery permits at most four attempts inside the 120-second deadline.

Periodic batches are keyed to UTC ten-minute slots. Fast and slot-release batches
do not move that clock; a unique partial index and atomic claim prevent duplicates.
Fast batches have a sixty-second cooldown and stop in the minute before a periodic
boundary. The existing one-minute observer owns scheduling; the legacy five-minute
generator yields. No extra periodic cron or manual orders are introduced.

DeepSeek reviews all ten paths and closed-candle 1m/5m momentum. Every READY symbol
reaches independent GPT review, including DeepSeek WAIT/SKIP and invalid advice.
This removes the previously observed recall defect without relaxing data integrity
or pretending that citation integrity proves semantic accuracy. Invalid data and
held symbols remain blocked. GPT always gets a freshly collected execution packet.

Current budget contract (reconfirmed 2026-09-28 04:00 UTC): OpenAI USD100/month and
DeepSeek USD100/month, USD200/month combined. The user explicitly corrected this in
the concurrent operating conversation; the DB was updated at 03:45:36 UTC. Daily
ceilings USD50/100 remain secondary caps, not spending authorizations. The initial
03:35 activation incorrectly extrapolated daily caps into USD1550/3100 monthly caps;
those superseded values must not be restored. Existing unknown reservations remain
charged. Provider requests are reserved before transport and
settled exactly once; parent review count is also bounded at 10000/day. The disabled
legacy USD3 path is not used after both provider ledgers are enabled. Research API
cap was independently verified as zero at baseline.

Validation before deployment: 1465 Node tests; 1055 Deno tests plus 13 steps;
Edge type checks; actual PostgreSQL (PGlite) periodic-clock, single-flight, WAIT,
stale/future candidate, new identity, capacity and provider-budget tests. The real
ONEUSDT FINAL RECHECK failure packet preserves both complete 24-bucket paths and
now uses 115031 bytes versus 177265 originally, below the unchanged 130000-byte cap.
Provider dispatch was tested with an offline transport and no orders.

Production code: beb088bdf23711d60e18a7878494693632b23301 (PRs 228, 231, 232).
Executor v141, artifact f0206ebe493ca211383d3045cafb9695400907062fe79acb509c41154a0fccbc.
Generator v39, artifact 0d103d77606c88016e147afc799b2f39a68f4b2c56bb611dc88281c50c6a314d.
Downloaded sources matched all 81/15 submitted files after newline normalization.
Final Node validation: 1474 passed; Deno: 1055 passed plus 13 steps; the focused
real executor BUY/FINAL/dispatch suite passed 44 tests using offline exchange transport.

Observed periodic slots 03:40 and 03:50 UTC both completed with ten inputs and ten
results. Batch IDs 7d6cfdf1-2b01-461f-91ed-4525ea6da3b6 and
907d7299-8f9c-4929-aa91-88972f61df72. Actual starts were 03:40:10.451316 and
03:50:13.436098: exact 600-second slot spacing, 602.984782-second start spacing.
Fast batches between them did not move the next periodic slot (04:00 UTC).
The 04:00 slot also completed on v39: fcf0f582-8853-4da8-b53b-dab2f72b3479,
requested 04:00:20.287736 UTC, ten inputs and ten results, attempted=true, no error.
Thus three consecutive ten-minute slots were observed in production; provider
request start times have normal cron/acquisition jitter and are not exactly 600s.

ONE signal e7b9d1e8-6b1a-47d4-8597-a71eaef3703d received WAIT, then
SIGNAL_STALE_OR_FUTURE. Its campaign survived and signal
92cc5191-fe5a-4417-9dbd-101493446c66 was generated with a new capture at 03:46.
SOON independently received WAIT at 03:51 and a valid fresh-candidate WAIT at 03:53.

Natural SOON BUY completed at 03:55:27.952191; its fresh FINAL WAIT completed at
03:55:49.408845 on the same signal f28e1f58-d09f-48c1-a5f0-a9414b43a792.
Capture ends advanced from 1790567720038 to 1790567740236; each had 24 complete,
causal buckets. Price changed +0.2863%, bid depth -21.4521%, imbalance -0.11216.
The new independent WAIT blocked an order as intended, not an expired initial BUY.
BTW BUY at 03:58 encountered FINAL API_TIMEOUT, then a bounded fresh recheck
completed valid WAIT at 03:58:59.208488. IRYS also completed FINAL WAIT at 03:59:14.
No production order was forced; no fresh FINAL BUY/fill was observed in this window.

Post-v141 initial monitoring found no new ledger-reservation failures or stranded
reviews. Older RUNNING and uncertain reservations remain audit evidence and are
not silently refunded. Usage-unavailable DeepSeek responses keep conservative
reservations. Collector gaps, genuine stale/noncausal data, provider timeouts and
invalid model evidence can still pause execution without ending watch campaigns.
At 04:00 UTC the provider budget RPC reported OpenAI used USD40.7365/100, DeepSeek
USD2.0943/100, including unresolved amounts. Its backward-looking 31-day estimates
were USD362.18 and USD33.24; these are not invoices or a steady-state forecast.
OpenAI can reach the monthly cap at this cadence: new paid entry reviews will then
stop explicitly. No monthly-cap increase or BUY-rate target is authorized here.
