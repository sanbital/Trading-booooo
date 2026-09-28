# Clock capture identity across the review journal

NMR's 13:10 clock ENTRY completed BUY at 13:11:17.409Z. The subsequent
review stopped before provider dispatch with `RC_BATCH_CAPTURE_NOT_ADVANCED`.
Its original expiry remained 13:12Z; no order was sent.

The preserved initial capture came from JSONB. Rebuilding the current capture
from the original clock reader through `validateCapture120` produces exactly
the same 24 rows, numbers, timestamps and canonical trajectory hash, but the
object insertion order differs. The old `JSON.stringify` comparison therefore
rejects the identical path. Comparing two saved JSONB packets alone hides this
failure because both have already had their object keys reordered.

`sameClockCapture` now compares every value and array position independent of
object key order, including the full clock window binding. It does not trust
a supplied hash, omit fields, round values, rewrite timestamps or extend expiry.
Current quote and all execution protection checks remain separate.

The original reader and initial packet are retained in the NMR fixture. Offline
tests rebuild the production capture and exercise the actual recheck boundary,
then reject changed values, missing/extra fields, reordered buckets, different
epoch/generation/hash, extended expiry, nonfinite values and rolling captures.
WAIT cannot dispatch; a test BUY still requires a post-answer executable quote;
the original sequence cannot be reused. No provider or exchange request occurs.

Validation: 13 new regressions and 31 combined clock/deadline/unit tests pass.
The first combined run lacked PGLITE_MODULE; the configured rerun passed.

## Coordination and new policy

This work is based on PR255 (`e0c63ba7`) and is not independently deployed.
After diagnosis, the Top20 owner received a new user instruction making the
clock GPT BUY the final strategy authority and prohibiting a full FINAL
RECHECK. That P0 contract change supersedes using the old recheck route as the
desired production behavior. This comparison correction is offered to that
owner as a bounded supporting change, not a reason to restore the old route.
The expired NMR signal must not be reactivated. Offline boundary recovery is
not proof that the historical candidate would have traded.
