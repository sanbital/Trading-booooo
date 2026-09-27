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
attempts (including intervening WAIT and acquisition attempts), the original trigger deadline (including execution reserve), the existing
daily budget and at least 15 seconds remaining before starting another attempt.

ENTRY recovery runs in the independent review task. waitReady follows only the active
child after the trading lease has been released; an old failed parent cannot clear the
new BUY ticket or write a terminal market rejection. Exhaustion is recorded as a stale
review opportunity, not a GPT SKIP. No historical rejected signal is reopened.

Pre-dispatch RECHECK timeout releases the signal claim. A fresh ordinary lease cycle
runs protection, account, E1 and book reads again. A completed timeout or transient capture delay can receive
a new child within the same IOC sequence. A successful or substantive invalid response
remains single-use. The two-IOC-attempt cap and all exchange/order guards still apply.
The wrapper can start up to three extra cycles while elapsed time is below 45 seconds;
this is an initiation horizon, not a hard cancellation of an already running cycle.
Each ordinary cycle can include its existing observation/follow-up passes. The journal
and original trigger impose the actual per-candidate deadline.

HOLD retries its failed event after five seconds when no usable primary/emergency
answer exists, including a causally timestamped answer that completed too late to apply.
A malformed/future timestamp or fresh valid ABSTAIN retains the existing cooldown.
The routine review cap and generation binding remain; newly changed critical dynamic
events and trajectory recovery intentionally bypass the routine cap/cooldown (existing
policy). The daily API budget and native protection still apply.

## Recovery audit, 2026-09-27

The audit reproduced six failures on the preceding source and added regression cases
for WAIT continuation and RECHECK capture/storage behavior. Corrections:

- A temporarily unavailable retry capture no longer becomes generic preparation failure.
  It remains a bounded, unpaid acquisition attempt. A later child must exceed the maximum
  previously reviewed capture end, even when an intermediate packet has no capture.
- WAIT and timeout share one attempt count. WAIT children no longer inherit the wrong
  timeout parent; every new review must advance the last reviewed capture.
- waitReady continues a WAIT after its five-second observation delay, inside the original
  trigger and attempt budget. It does not strand a timeout recovery at a WAIT result.
- Future/unproven trajectory timestamps are not classified as transport timeouts.
  STALE_OR_FUTURE is timeout-recoverable only with evidence of expiry during inference.
- A lifecycle fallback cannot convert a recoverable technical failure into terminal GPT
  rejection. Existing historical terminal rows remain unchanged.
- Trigger validity is checked again after durable reservation and immediately before a
  model call. RECHECK also persists the snapshot before that call, as ENTRY already did.
- Late HOLD completions remain unapplied, keep standing protection and request a fresh
  review after five seconds. Malformed timestamps do not acquire that exception.
- Slow market collection refreshes the book and BTC sensor even when the capture reader
  caught up by itself and did not need the separate pre-inference acquisition loop.
  Previously this timing could leave the new capture paired with older book/sensor data.

Audit boundaries: recovery never reuses an uncertain RUNNING request or a consumed valid
RECHECK. A process crash, storage outage, continuous provider outage, exhausted budget,
collector outage or expired trigger can still prevent an entry. No finite test suite can
guarantee zero future timeouts. Freshness remains ten seconds, and only a validated FINAL
BUY plus the ordinary dispatch checks can authorize an order.

The authenticated fd1-timeout-probe injects one clearly labeled, unpaid ENTRY timeout
in an isolated DRYRUN coordinator. Its recovery uses live captures and real provider
calls. It cannot claim a trading signal, create an order or change a position.
The fd1-recheck-timeout-probe injects a first FINAL transport timeout and uses the
same resumeReviewTimeouts scheduler as production. Each attempt, including the
failure, appears in its response. Public book data and the capture are read again;
its adverse E1 tape remains an explicitly synthetic fixture. No actual lease or
order is taken by either probe.

Timeout recovery does not manufacture BUY or extend data freshness. Persistent API
outage, trigger expiry or exhausted budget can still prevent an entry; a valid fresh
FINAL BUY is required. Schema/evidence failures such as
FD_EV_SKIP_REQUIRES_BEARISH_FACTS are not silently retried as transport failures.
