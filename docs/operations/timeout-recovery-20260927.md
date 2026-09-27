# Fresh review recovery after timeouts

XVG's old ENTRY timed out after consuming 6.27 seconds of a capture before inference,
leaving FINAL 2.70 seconds. Fresh-bucket acquisition in v126 fixes that timing waste.
However, a completed timeout journal was still permanent for its trigger. A future
transient timeout could therefore discard the candidate even with time remaining.

The coordinator now follows durable timeout child keys. The failed row remains intact;
each child has a separate budget reservation and CAS owner and reads new market data.
The previous capture end is passed to acquisition and must strictly advance before
another model request. FIRST, DeepSeek and FINAL are all re-run on that new snapshot.
An existing child is recovered across processes even when there is no time to start a
new attempt. RUNNING requests are never duplicated. Recovery is limited to four total
attempts, the original trigger deadline (including execution reserve), the existing
daily budget and at least 15 seconds remaining before starting another attempt.

ENTRY recovery runs in the independent review task. waitReady follows only the active
child after the trading lease has been released; an old failed parent cannot clear the
new BUY ticket or write a terminal market rejection. Exhaustion is recorded as a stale
review opportunity, not a GPT SKIP. No historical rejected signal is reopened.

Pre-dispatch RECHECK timeout releases the signal claim. A fresh ordinary lease cycle
runs protection, account, E1 and book reads again. Only a completed timeout can receive
a new child within the same IOC sequence. A successful or substantive invalid response
remains single-use. The two-IOC-attempt cap and all exchange/order guards still apply.
The wrapper can resume up to three extra cycles within 45 seconds; the journal and
original trigger impose the actual per-candidate deadline.

HOLD retries its failed event after five seconds when no usable primary/emergency
answer exists. A malformed timestamp or valid ABSTAIN retains the existing cooldown.
Existing review limits, generation binding and native protection remain in force.

The authenticated fd1-timeout-probe injects one clearly labeled, unpaid ENTRY timeout
in an isolated DRYRUN coordinator. Its recovery uses live captures and real provider
calls. It cannot claim a trading signal, create an order or change a position.

Timeout recovery does not manufacture BUY or extend data freshness. Persistent API
outage, trigger expiry or exhausted budget can still prevent an entry; a valid fresh
FINAL BUY is required. Schema/evidence failures such as
FD_EV_SKIP_REQUIRES_BEARISH_FACTS are not silently retried as transport failures.
