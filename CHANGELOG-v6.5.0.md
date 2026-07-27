# Trading-booooo v6.5.0-LATENCY

Base: v6.4.0-HEAT. Three changes, plus one repair.

The 2026-07-27 AI department review recommended reverting to PAPER and auditing. That is
not what this release does, and the reasoning matters: every failure this bot has actually
had — the 8h39m ETH hold, the LTC pause, the thirty minutes of zero trades, the calibration
job that was never called — was code that silently did not run. PAPER catches none of that
class, and stopping live orders removes the fill data needed to answer the one question the
review is right to press on. What the review is right about is narrower and is taken here:
the engine was pricing things it had never measured.

Two of its recommendations are declined, with reasons at the end.

---

## 1. Execution latency is measured, and priced

`cost-model.ts` has carried `latencyPenalty: 0.0001` since v5.2 — one basis point, flat,
for every symbol on both exchanges, chosen before a single millisecond was ever recorded.
It is subtracted from the edge of every trade, so it has been deciding which candidates
clear the gate. The LOB path, which has the shortest horizon in the system, did not price
execution delay at all.

`_shared/scalp/latency.ts` (new) stamps five points on the path:

```
book_captured -> quote_received -> decision_made -> order_submitted -> order_acked
```

`book_captured` is the exchange's own orderbook timestamp where the venue publishes one.
Upbit does; Binance's `/api/v3/depth` does not, so the gateway's receipt time is used
instead and the substitution is recorded in a `source` field rather than smoothed over —
it understates true staleness and the reports say so.

Three intervals fall out: **tick-to-decision** (is the signal stale when we act?),
**tick-to-order** (how old is the book we traded on?), and the order round trip.
Percentiles are nearest-rank, not interpolated: at the sample counts of the first few days
an interpolated p99 invents a number that was never observed.

**Latency becomes a cost instead of a constant.** Waiting exposes the fill to whatever the
price does meanwhile, and that exposure grows with the *square root* of delay and scales
with the book's own volatility. The LOB path uses the noise band it already measures:

```
penalty(t) = noiseBandBps * sqrt(t / observationWindow)
```

No normality assumption, no ATR conversion — the same book, the same quantity, rebased to
a different horizon. The flat 1bp was wrong in both directions at once: too large for a
quiet book reached in 300ms, far too small for a hot one reached in four seconds.

- New table `trading_latency_samples`. Nothing is pre-aggregated; the raw distribution
  stays inspectable.
- `scalp-calibration` (hourly) computes p50/p95/p99 over 24h and writes
  `scalp_latency_p95_ms` / `scalp_latency_source = MEASURED`.
- p95 is charged, not the median. The cost of being late is not the typical delay but the
  delay bad enough to matter.
- Measurements are shrunk toward the 1bp prior by `n/(n+60)`; under 20 samples the
  measurement is ignored outright. One slow morning cannot widen every barrier.
- `evaluateLatencySlo` reports a breach when p95 tick-to-order exceeds
  `lob_max_book_age_ms` — acting on a book already older than the freshness the gate
  claims to enforce. **Missing book timestamps are themselves a breach**, via a coverage
  metric: before this release, coverage was zero on every decision in the system.

Nothing here can fail an order. Timing is attached on success only and never inspected in
the order path.

## 2. The decision ledger

Until now a rejected candidate left one INFO event and nothing else, and an accepted one
left an order and a position with no key joining either back to the scan that produced it.
The rejections are the worse half: the reasons trades *do not* happen are the primary
evidence for whether the gates are calibrated, and they were the least durable thing here.

- New table `trading_decisions` — one row per candidate evaluated at order time, entered
  or not. Rejections are first-class rows carrying the same audit an entry does.
- `decision_id` on `trading_orders` and `trading_positions`. The chain
  scan → decision → order → position → exit is now a join rather than a reconstruction.
- `enterCandidate` is a thin wrapper around `enterCandidateInner`. The inner function has
  more than twenty early returns; adding a ledger write to each would guarantee the next
  one added forgets — the same class of mistake as the swallowed catch in v6.3. The
  wrapper records whatever the inner returns, so no rejection can be silent.
- Ledger write failures raise `DECISION_LEDGER_WRITE_FAILED` rather than disappearing.

## 3. Capital rotation

Entry has only ever asked whether a book clears its own cost floor. Capital already
committed never entered the comparison, so with every slot full, a book worth ten times
the worst holding was declined without being compared to it. For a strategy whose scarce
resource is the slot-second, that is the wrong objective.

`_shared/scalp/rotation.ts` (new) values a slot at `expected net bps / expected seconds`
and rotates only when the candidate beats the incumbent *after* paying to close the old
position and open the new one.

- Evaluated **only** when a candidate was turned away for lack of capital. A free slot is
  always better, because filling it costs nothing.
- Held-position value uses the **remaining** barriers, not the entry ones. A position
  halfway to its target has different geometry, and entry-time numbers would
  systematically overvalue winners and undervalue losers.
- The claimed entry edge decays by half-life; the geometric term does not. A signal past
  several half-lives contributes nothing, which is correct — at that point the position is
  a coin flip paying a spread.
- Hysteresis defaults to 40%, not 1%. Both rates are estimates; rotating on any positive
  difference is a machine for converting estimation error into fees.
- The **worst** slot is displaced, not the first that qualifies.
- Positions under 60s old are protected. Ceiling of 6 rotations/hour, bounded in the
  schema as well as in code.
- The scan cycle **does not sell**. It marks the position and the monitor closes it
  through the ordinary exit path — cancelling the resting TP, booking the fill,
  reconciling. A second liquidation path is exactly the divergence that produced the
  8h39m hold.
- Declined rotations are logged too (`SLOT_ROTATION_DECLINED`). The near-miss distribution
  is the only evidence for whether the hysteresis is set anywhere near right.
- Failing to read the event log returns "budget spent", not "budget free". Failing closed
  on a throughput feature costs a cycle; failing open costs money in churn.

## 4. Repair: seven tests that never ran

`market-autotrader/core.test.ts` used `assertEquals` twenty-one times and never imported
or defined it. Every call sits inside the seven reconciliation tests v6.4.0 added — the
guards for `DUST_ALIGN`, for the bot's own resting sell being mistaken for a manual lock,
and for "unreadable open orders blame nobody". Those are the tests for the two incidents
that caused the 8h39m ETH hold and the LTC pause.

They have never executed. The file throws `ReferenceError` on the first one, and
`deno task test` — which CI runs before every deploy — has been unrunnable in the
packaging environment since deno.land became unreachable. Defined locally now; all seven
pass.

`lob_observation_window_ms` was likewise read by the engine and never created as a column
— the same class of gap that broke the v5.5 deploy on `scalp_resting_tp`. The v6.4
migration guard caught it during this release; it now exists.

---

## Declined, with reasons

**"Remove the 58% target win rate from the order gate."** Correct in principle, but it is
not in the active gate. `scalp_target_win_rate` drives barrier splitting in the legacy
`SCALP` path; the running strategy is `LOB_SCALP`, where the split comes from the book's
own movement estimate and `neutralWinRate` is derived arithmetic. The real version of this
criticism is that the LOB movement constants (`6 + confidence*62 + activity*26 + ...`) have
never been measured either. That needs realized-excursion data to fix properly and is
deferred rather than guessed at.

**"Revert to PAPER pending audit."** Declined. See the opening paragraph.

---

## Files

New:
- `supabase/functions/_shared/scalp/latency.ts` + `latency.test.ts` (16 tests)
- `supabase/functions/_shared/scalp/rotation.ts` + `rotation.test.ts` (15 tests)
- `supabase/migrations/202607270015_latency_ledger_and_rotation.sql`

Modified:
- `market-autotrader/index.ts` — trace wiring, ledger wrapper, rotation, version
- `scalp-calibration/index.ts` — latency aggregation and write-back
- `_shared/lob/entry.ts`, `_shared/lob/types.ts` — latency charged on both cost legs
- `gateway/server.mjs` — timing on quote and create_order, version
- `market-scanner/engine.ts`, `docs/index.html` — version
- `market-autotrader/core.test.ts` — the repair above

## Verification

**deno.land is unreachable from the packaging environment, so `deno test` was not run.**
Instead the test files were transpiled with esbuild and **executed** under Node against a
shimmed assert module, with `Deno.readTextFile` / `readDir` wired to the real filesystem so
the repo's own deploy guards run for real:

- **304 tests executed, 304 pass** (was 297 pass / 7 fail before the `assertEquals` repair)
- version guard, migration-ordering guard, settings-column guard, constraint-repush guard
  and scheduling guard all pass
- strict `tsc` on `_shared/**` clean; `tsc` on all three modified edge functions clean
- all five edge functions bundle; `node --check` clean on the gateway

CI still runs the real `deno task check` / `deno task test` on push. This is a stand-in for
that, not a replacement.

## Switches

Everything defaults on, with `lob_rotation_enabled = false` as the single off switch for
rotation. Latency measurement writes back under `scalp_auto_tune_latency` (default true);
set it false to measure and report without charging.

No new keys, no new deploy targets, no new schedules.
