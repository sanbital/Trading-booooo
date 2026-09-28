# Capture horizon time-unit incident

At the 2026-09-28 13:00 UTC clock cycle, 15 final GPT ENTRY results passed the
old validator. Four s60 summaries described an hour: CAP and MARSCOIN returned
WAIT; QNT and SOON returned SKIP. Their original input had
`dynamics.horizons.s60.actual_seconds = 60.032`, not 3600 seconds.
The original packet and wire were replayed offline; the baseline reconstructed
request bytes matched the recorded request bytes for all 15 results.

The data was correct. The prompt supplied seconds windows alongside independent
`return_60m` candle facts and a prospective 30–60 minute forecast. It did not
explicitly distinguish these three scopes in the horizon summary schema.
The validator checked shape, citations and decision evidence but accepted
contradictory duration prose. Mixed scopes are a plausible contributor; the
model's internal reason and the decision it would make after correction are
unknown. These four results must not be described as verified market judgments.

ENTRY and RECHECK now explicitly map each capture key to seconds, attach original
recorded boundaries and duration metadata, and describe the duration in every
horizon summary schema. RECHECK metadata refers to CURRENT, not INITIAL.
The RECHECK prompt hash includes the dynamic prompt. No trajectory cell,
timestamp, fact, snapshot hash, sizing policy, TTL, provider budget or strategy
threshold is rewritten.

A narrow validator rejects explicit hour/day or oversized minute interpretations
inside per-horizon summaries with
`FD_DYNAMIC_HORIZON_TIME_UNIT_MISMATCH:s60` (or the affected key).
The existing failure path records an invalid ABSTAIN, preserving the original
wire and creating no new retry or order authority. Correct one-minute s60 and
two-minute s120 phrasing remains valid; long-term structural prose remains
separate. This is not a general semantic correctness guarantee.

Offline replay rejects exactly the four incident responses and retains the
other eleven. No paid API replay or forced trade is required. Focused tests
cover all four originals, BUY and RECHECK, unchanged original evidence, valid
unit equivalents, and the provider-response error path. The normal repository
Node and Deno suites and executor typecheck are release gates.

Deploy only the complete executor import closure after comparing the production
version 150 bundle with baseline commit
`9c82b621316266829f0f7ba5eb96b5907e0663cd`. Generator 44, collector v8 and the
ten-minute clock policy stay in place. Rollback, if necessary, is that complete
executor baseline bundle; it restores the known semantic-validation gap.
