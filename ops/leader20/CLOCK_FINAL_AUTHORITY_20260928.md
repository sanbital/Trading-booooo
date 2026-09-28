# Clock FINAL authority incident

## Root cause and scope

The original 22:10 KST NMR signal `99d9bf62-396e-41fc-b4ac-179c5658450d`
had a complete fixed 120-second capture, a valid GPT BUY and two fundable slots.
The batch prompt, engine and execution adapter still classified every campaign
BUY as preliminary and forced a second full FINAL RECHECK. That legacy route
compared JSONB-restored evidence with freshly normalized evidence using JSON
serialization order and returned `RC_BATCH_CAPTURE_NOT_ADVANCED` despite identical
24-row values. The original expiry was 22:12; the expired signal is not replayed live.

This release builds on main `e0c63ba7` and executor 151, preserving the Top20 clock,
funding shutdown, collector v8, horizon-unit fix and generator 44. The strict
key-order-independent identity correction is inherited from commit `401e2830`.

## Contract

`TOP20_CLOCK_GPT_FINAL_3` is the final strategy authority only when the stored
valid BUY, original raw GPT response, packet hash, actual trajectory hash,
event identity, epoch/generation, slot, capture hash and original expiry agree.
The advisory and GPT use the same frozen 24 x 5-second path. The slot expiry is
the clock answer lifetime, replacing the rolling-entry 15-second answer lifetime
for this path only. No expiry is extended. Legacy non-clock reviews are unchanged.

Before: frozen path -> DeepSeek -> GPT BUY -> new capture/full AI recheck -> ABSTAIN.

After: frozen path -> DeepSeek -> GPT FINAL BUY -> deterministic safety -> IOC.

Clock execution and the existing bounded IOC retry read fresh execution quotes,
not another trajectory or directional tape. Neither invokes GPT/DeepSeek again.
Quotes must arrive after the answer, be at most 1 second old, have a valid bid/ask,
and stay within the existing 25 bps catastrophic spread bound. Extreme price
displacement uses the unchanged native-stop distance (currently 2.5%) from the
FINAL book reference; this is an execution abort, not another strategy review.
Ordinary price/flow changes do not force a full recheck.

The coordinator verifies the absolute slot expiry even for retries/superseding
parameters. Expiry is recorded as `CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION`.
Clock tickets are immutable and a local ticket cannot create two execution tokens.
Durable client-order uniqueness, current event authority, lease/fencing, account
capacity, sizing, exchange feasibility, duplicate/exposure guards and native stops
remain on the actual dispatcher path. Clock execution is audited as
`CLOCK_EXECUTION_SAFETY`; it creates no `FD1_FINAL_RECHECK` review row.

## Evidence and verification

The original NMR packet, identity and BUY wire are in
`tests/fixtures/nmr-clock-final-buy-20260928.json`. The offline test retains their
numbers and times, validates the raw wire under the new contract, advances past
the old answer age, and exercises the actual coordinator, safety adapter and IOC
dispatcher against a mock exchange. It checks one FINAL call, zero post-BUY
capture/AI calls, a non-null execution token, one order and duplicate rejection.
Separate cases retain expiry, changed binding, invalid result, stale/missing quote,
catastrophic spread/gap, ordinary price-change acceptance and legacy recheck.
The funded capture and capacity suites retain zero-capacity entry shutdown and
continuous held-position capture/management. No real candidate or order is forced.

## Remaining P1 data issues

At 22:10, AIOT/AZTEC/IMX/LYN/IOTA had incomplete initial order-book synchronization:
14/11/7/7/7 early rows respectively reported book unavailable, plus one partial
seed each. Sequence and causal flags were true; intervals were 4999–5007 ms.
At 22:20 only AIOT and LYN remained blocked (18 READY). Missing books are not
fabricated or treated as valid capture; collector remediation is separate from P0.

At 22:10 SEI's requested advisory reference was `fb37fa787c71ab51`; DeepSeek
returned `fb37fa787c51ab51`. `DATA_VERSION_MISMATCH` correctly refused that typo,
not a DB epoch race. The 22:20 batch had 18 valid advisory responses without that
failure. Version matching is not relaxed by this patch.

Production deployment and first subsequent natural clock slot must be recorded
separately. No BUY in a slot is not evidence that dispatch has been exercised.
