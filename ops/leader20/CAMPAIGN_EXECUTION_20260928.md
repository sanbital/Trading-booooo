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

Activation uses the user's current authorization: OpenAI USD50/day, DeepSeek
USD100/day; corresponding 31-day aggregate ceilings USD1550/3100. Existing unknown
reservations remain charged. Provider requests are reserved before transport and
settled exactly once; parent review count is also bounded at 10000/day. The disabled
legacy USD3 path is not used after both provider ledgers are enabled. Research API
cap was independently verified as zero at baseline.

Validation before deployment: 1465 Node tests; 1055 Deno tests plus 13 steps;
Edge type checks; actual PostgreSQL (PGlite) periodic-clock, single-flight, WAIT,
stale/future candidate, new identity, capacity and provider-budget tests. The real
ONEUSDT FINAL RECHECK failure packet preserves both complete 24-bucket paths and
now uses 115031 bytes versus 177265 originally, below the unchanged 130000-byte cap.
Provider dispatch was tested with an offline transport and no orders.

Production activation, version/hash parity, heartbeat and natural review evidence
will be appended only after observed, not inferred from these tests.
