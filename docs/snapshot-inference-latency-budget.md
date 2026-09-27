# Snapshot inference latency budget

## Current implementation: acquire a fresh inference window

The v124 six-probe verification showed that rereading could return the same
bucket, and a 20% preliminary allowance routinely timed out DeepSeek. The
implementation now waits before model input is frozen:

- A capture at most 1,500 ms old can proceed immediately.
- Otherwise, wait up to 6,500 ms, bounded by the caller's acquisition deadline,
  for a strictly newer completed, causal, full 24-bucket capture. Same-bucket
  rereads never count as progress. Failure becomes `INFERENCE_CAPTURE_NOT_READY`.
- Read book/BTC sensor again after acquisition, then build facts and hashes.
- The wait happens before the snapshot's model budget. Trigger/consumer deadlines
  and the ten-second absolute capture lifetime still cap the resulting decision.
- Allow up to 3.5 seconds for parallel advice and reserve up to 4.5 seconds for
  FINAL. Both phases retain identical snapshot binding. No preliminary decision
  is promoted to execution authority.
- Encode exact evidence paths as short `P` IDs only in FINAL transport. Restore
  paths before the original validators; save the provider wire separately when
  transformed. The 24 buckets, horizons and facts remain in model input.

The following sections record the preceding v123/v124 investigation, not the
current numerical allocation. External API timeouts remain possible; these
changes do not claim a provider latency guarantee.

A dynamic capture expires ten seconds after its last completed bucket. Previously,
the parallel FIRST/advisory phase could wait up to six seconds and leave only
2.2 seconds for GPT FINAL. A capture that was fresh when collected could expire
while the mandatory final decision was still running.

The coordinator now allocates FINAL's budget before starting the parallel calls:

- Retain the earlier of the caller deadline and capture expiry.
- Reserve up to 250 ms for completion/validation.
- Reserve up to four seconds (80% of usable time on shorter requests) for FINAL.
- Bound both parallel preliminary calls by the remaining shared allowance.
- Keep both providers and FINAL bound to the same frozen snapshot.
- Continue rejecting expired answers. No timestamp rebasing or freshness-limit change.

The existing `dynamic_audit.latency_budget` object records initial capture age,
preparation and phase durations, provider timeout allowances, FINAL's available
time, and whether a fresh input expired during inference. Historical records
without this object remain readable.

Synthetic regression: at an initial capture age of 3,000 ms, a stalled advisor
previously consumed 4,799 ms, leaving 2,200 ms before expiry. It now has 2,749 ms,
leaving 4,000 ms for FINAL and 250 ms of completion margin. A simulated 3,500 ms
FINAL finishes with capture age 9,249 ms. This is a scheduling regression test,
not a measured production latency or a guarantee that every provider finishes.

`tests/dynamic-latency-budget.test.mjs` also covers short lifetimes, inference
overruns, stale input, and a stricter caller deadline. No order is placed by these
tests. Slow/missing advice still follows the existing degraded-confidence rules.

The first deployed probe exposed another source of delay: capture age was already
7,311 ms before inference because candle/OI reads had completed later than the
parallel microstructure read. `readSources` now refreshes capture, book and BTC
sensor together once if the available capture is older than five seconds when
the slow reads finish. Each refresh has a 350 ms limit. Facts and snapshot hashes
are constructed afterwards, before either model starts. Failed refreshes remain
unavailable, and historical replay never makes this live refresh.
