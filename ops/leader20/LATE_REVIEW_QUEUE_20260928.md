# Completed reviews joining the current entry queue

An ENTRY BUY can finish while the executor is processing other BUY candidates.
The queue was captured once at the start of the run. If its known candidates
returned FINAL WAIT, the late BUY could be left until the next minute, beyond
its original safe recheck window.

The queue now makes one completed-only read pass after its original candidates.
Only Leader20 candidates already pending in that run are eligible. The durable
coordinator follows existing timeout-child records and validates the original
identity, binding, answer and expiry. Missing or RUNNING records cannot start
capture, claims, reservations or model calls in this read path. IDs are unique
and admission remains sequential in the same execution lease.

The pass is skipped with no original BUY, no capacity, insufficient existing
cycle reserve, or an expired entry-run deadline. Account/risk/dispatch failures
still break the queue before discovery. Discovery time consumes the same cycle
budget; the normal loop rechecks it before each attempt. The 30-second follow-up,
45-second timeout recovery, 40-second entry-run budget, 24-second attempt reserve,
original candidate/answer expiry and mandatory FINAL authority are unchanged.
The outcome audit records `lateCompletedReview` for candidates found this way.

## Original replay and limits

PUMP signal `9893da15-fa72-426e-ac50-3501752ad957` completed its retry BUY at
11:31:41.021954Z. The two queued MARSCOIN/LYN FINALs completed WAIT; the latter
finished at 11:31:53.439380Z. PUMP's original safe recheck boundary was
11:32:14.751Z, but its next recorded evaluation was 11:32:18.304Z.

Offline replay reads the original parent/child journals using the historical
production engine binding, packet and answer. It appends PUMP at the modeled
queue end, permits mandatory recheck only, rejects direct dispatch and rejects
the same answer at the original expiry boundary. Provider calls and claims are
zero. Windows CRLF in function source is normalized to the production LF form
before recomputing the binding; the resulting hash must exactly match the
original record. No answer or stored binding is rewritten.

The actual historical remaining cycle budget and every return value were not
persisted. This proves the queue behavior, not that the past trade would have
completed. The current Top20 clock engine has a different binding and correctly
refuses to inherit that historical BUY. Its approved fixed-window capture
semantics are preserved by merging PR249/250; no rolling-window rollback occurs.

## Validation

- Original PUMP parent/child replay: no API, claims or orders; original TTL and
  direct-dispatch refusal preserved; new-policy binding refuses historical BUY.
- Completed-only coordinator and queue unit tests cover missing/RUNNING results,
  timeout children, identity/age rejection, deduplication, stops and read errors.
- Actual executor queue integration: late completion after two symbol-scoped
  FINAL refusals is considered once; account/cycle-budget stops prohibit reads.
- Integrated Node: 1,564 passed. Deno: 1,055 passed plus 13 steps. Executor type
  check passed. Existing account, order, protection and FINAL regressions pass.
- First full Node run failed because the historical VM harness could not parse
  a new TypeScript generic and recognized only the old loop text. The source now
  uses ordinary Set syntax; the harness imports the actual queue helper and runs
  the new loop. Assertions were retained. The integrated suite above passed.

Deployment is separate from these offline results. The concurrent Top20 release
must finish and its actual bundles must be checked before this executor change
is deployed. No paid validation or manual trade is authorized by this document.
