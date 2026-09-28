# Multi-slot entry continuity, and why 00:50 / 01:00 / 01:20 KST lost their whole slot

Migration: `supabase/migrations/20260928161500_leader20_multi_slot_entry_continuity.sql`
Tests: `tests/leader20-multi-slot-entry.test.mjs` (28 checks, real PostgreSQL bodies)

## The recorded failure

| slot (KST) | status | reason | ready | blocked | retry | available_slots | epoch published |
|---|---|---|---|---|---|---|---|
| 00:40 | DONE | CREATED | 19 | 1 | 0 | 2 | T-165s |
| **00:50** | EXPIRED | DECISION_WINDOW_INSUFFICIENT | **0** | **20** | 13 | 1 | **T-130s** |
| **01:00** | EXPIRED | DECISION_WINDOW_INSUFFICIENT | **0** | **20** | 5 | 1 | **T-130s** |
| 01:10 | EXPIRED | CREATED | 19 | 1 | 0 | 2 | T-164s |
| **01:20** | EXPIRED | DECISION_WINDOW_INSUFFICIENT | **0** | **20** | 3 | 2 | **T-132s** |
| 01:30 | DONE | CREATED | 17 | 3 | 0 | 2 | T-166s |

`leader20_micro_archive` for the 01:20 window holds **one** symbol, BTCUSDT, 14 rows. The
healthy 01:10, 01:30 and 01:40 windows each hold 21 symbols and 504 rows. 01:20 had **no open
position at all** and `available_slots = 2`, so a held position was never the cause.

The one thing the three lost slots share is the last column.

## Root cause

`doa_capture_rpc('watch')` read the entry slot from the **epoch snapshot**:

```sql
select (snapshot->>'capture_slot_ms')::bigint into slot_ms
from public.leader20_epochs where id=c.epoch_id;
```

`leader20_control.epoch_id` only advances when the Top20 epoch for the next slot is published,
scheduled for T-180s. When publication slipped to T-130s:

1. From T-180s to T-130s the RPC reported the **previous, already-closed** slot. The collector's
   `captureDisposition()` computes `connect = now>=slot-180000 && now<slot+1000` from that value,
   so every candidate stream was `connect:false` and was closed — leaving only the roles that are
   never clock-gated: `OPEN_POSITION` and `MARKET_SENSOR`. Hence BTCUSDT alone in the archive.
2. `entry_capture_slot_ms` could only ever be armed inside `[T-180s, T-120s)`. The epoch landed at
   T-130s, leaving a 10-second arming window — narrower than the collector's own 15-second control
   poll, so in practice no poll fell inside it and the slot was never armed.
3. Once past T-120s the latch could not be armed for that slot at all, and any zero-capacity read
   — including a merely *uncertain* one (stale or unreadable account snapshot) — cleared it
   outright. There was no path back inside the same window.

Two further defects made the same window fragile for other reasons:

4. `leader20_batch_capacity()` returned `available := case when pending>0 then 0 else slots end`,
   although the same function had **already** reserved a full slot cost and a full slot for each
   unresolved order. One entry going PLANNED therefore closed the entire account: entry capture,
   `ai_call_reserve` ENTRY/RECHECK admission, batch claim/finish and materialization all read zero,
   and `leader20_batch_note_full()` / `leader20_batch_slot_wake()` retired every in-flight review
   event. A fill ended the batch instead of consuming one slot.
5. Nothing counted concurrent BUY candidates. `leader20_materialize_event` checked
   `available >= 1` once per candidate, non-atomically, so N simultaneous BUYs against 2 slots
   could all materialize.

## What changed

**The entry slot is derived from the clock, not from epoch publication.**
`slot_ms := floor((at_ms+180000)/600000)*600000` — the same slot the shared clock module derives
(`preparationSlot` / `slotFloor(at + CAPTURE_MS + PREWARM_MS)`). The preparation window now starts
at T-180s whatever the epoch does. Until the epoch flips, the watch carries the outgoing Top20
membership, which between consecutive ten-minute rolling-24h epochs is nearly identical; members
whose rank actually changed get the shorter lead instead of every member getting none.
`entry_capture.epoch_published` and `leader20_clock_slot_report.epoch_publish_lag_ms` keep the
publication lag visible — it is now a quality signal, not an outage.

**`entry_capture_slot_ms` is derived, re-armable state, not a single-shot latch.**
Arming (and re-arming) is allowed at any point while a complete 120s/24-bucket path is still
reachable, i.e. up to `T - 120s - leader20_control.entry_capture_arm_lead_ms` (default 25 000 ms =
the collector's 15s control-poll period plus 10s to open both sockets and take twenty depth
snapshots; `completeCaptureInterval()` requires `started<=T-120s` and `book.syncAt<=T-120s`).
So `capacity 1 → 0 → 1` inside the window recovers automatically; only a window that can no
longer complete is deferred to `NEXT_WINDOW`. No manual reset exists or is needed.

**Uncertain is not zero.** A missing, stale or unreadable account snapshot returns
`certain:false`. That state **holds** an already-armed capture (`CAPACITY_UNCERTAIN`) and never
creates one — and it never admits an order: `leader20_reserve_entry_slot` refuses on
`certain:false`, as `leader20_batch_claim` and `leader20_materialize_event` already did.

**Slots are an entry ceiling, not a scan stop.** Capacity now reports two bounds:

| field | meaning | gates |
|---|---|---|
| `available` | slots the **account** can fund, counting open positions and unresolved entry orders | Top20 entry capture, paid ENTRY/RECHECK admission, batch claim/finish |
| `available_for_new_entry` | `min(available_by_margin, max_slots − open − reservations)` — how many **more** positions may be opened | slot reservation, i.e. every order |

`reason` keeps exactly the strings deployed callers compare against (`NO_ENTRY_CAPACITY`,
`ACCOUNT_SNAPSHOT_*`, `null` when funded); the finer cause travels separately as
`capacity_detail` (`ENTRY_CAPACITY_AVAILABLE` / `ENTRY_SLOTS_RESERVED` / `MAX_SLOTS_REACHED` /
`PENDING_CAPITAL_RESERVED` / `INSUFFICIENT_MARGIN`), so no existing comparison changes behaviour.

Soft reservations are deliberately **not** subtracted from `available`: a reserved candidate must
be able to pay for its own FINAL RECHECK, and tearing the capture down mid-window cannot be undone.
Only `available == 0` stops new entry capture; open-position capture, protection, HOLD/EXIT and
hard stops are never gated on it, and the BTCUSDT market sensor their exit evidence cites is
retained whenever anything is held.

**Atomic slot reservation.** `leader20_entry_reservations`
(`RESERVED → ORDER_PENDING → FILLED` / `RELEASED` / `EXPIRED`) with a unique partial index on
`symbol` for the live states (one symbol = one open position; no pyramiding).
`leader20_reserve_entry_slot()` takes the existing account lock `(20260928,52)`, so concurrent
candidates serialize: with two slots, the third BUY gets `NO_ENTRY_CAPACITY` and never reaches an
order. `leader20_materialize_event` reserves per candidate and releases on refusal.
Reservations carry their entry window's deadline and **stop counting against capacity at that
deadline whether or not they were swept**, so a lost settlement cannot block the account.
`leader20_entry_reservation_sweep()` records the lifecycle from the order and signal journals.

**Sizing is read, never redefined.** `leader20_entry_slot_policy()` returns the current production
values in one place: `max_slots 10`, `target_margin_per_slot 152.021375`, `cash_buffer 0.10`
(= `entry-capacity.mjs slotCostUsdt()` at the live sizing contract, verified against the deployed
function body before deployment). Leverage, target margin, MAX_SLOTS, Top20 selection, the
ten-minute cadence and the 120s/24-bucket contract are unchanged.

## Observation

`leader20_clock_slots` gains `open_position_count`, `available_slots_before`,
`available_slots_after`, `reserved_slots`, `futures_available_margin`, `target_margin_per_slot`,
`watch_count`, `blocked_reasons`, `tracked_positions`; `runEntryBatch` writes them and
`leader20_reserve_entry_slot` writes the remaining-slot transition where it happens.
`leader20_clock_slot_report` adds `buy_now_count`, `orders_attempted`, `fills`, `reservations`,
`reservations_released` and `epoch_publish_lag_ms`, all derived from the durable journals so they
cannot drift from what happened.

## Not fixed here

The Top20 epoch still publishes late for some slots (13–16s lag when healthy, 48–50s when not).
That is the generator's wake schedule, not this change's scope, and the clock-derived slot makes it
survivable rather than fatal. `epoch_publish_lag_ms` is now the metric to drive that work.

## Verification

* 1 514 / 1 527 Node regression checks pass. The 13 failures are pre-existing on `main` and
  identical before and after this change (1 486 / 1 499 on the untouched tree): every one of them
  runs `git show bce9e95…:supabase/functions/_shared/leader-momentum-v17.mjs`, an object this
  130-commit clone does not carry. CI checks out with `fetch-depth: 0`.
* Deno: 1 055 tests, 13 steps, 0 failures. `deno check` passes on the changed module.
  `deno check` of the Edge entrypoints needs `esm.sh`, which this environment's network policy
  blocks; `top20-clock-release.yml` runs it.
* `tests/leader20-multi-slot-entry.test.mjs` runs the real migration bodies against PostgreSQL and
  covers: the 00:50 replay (the recorded outcome reproduced on the deployed migration, then fixed),
  TEST A–G, atomic reservation and refusal, capacity transition on each fill, three independent
  position captures, and the per-slot observation row.

---

# Follow-up: the two levers on missed fills and timeouts

Migration: `supabase/migrations/20260929090000_leader20_collector_liveness_and_final_budget.sql`
Tests: `tests/clock-authority-and-final-budget.test.mjs` (15 checks)

## Measured, not assumed

Production over 36h / 12h (`leader20_clock_slots`, `gpt_final_entry_reviews`):

| metric | value |
|---|---|
| per-call FD1_ENTRY latency (458 calls) | mean **5,847ms**, max **15,061ms** |
| FINAL stage, whole 20-symbol fan-out (p95) | **109,673ms** |
| slot → GPT completion, total (p50 / p95 / max) | **86,017 / 180,597 / 184,068 ms** |
| batch start (p95) | 22,264ms |
| DeepSeek (p95) | 17,746ms |
| FD1_FINAL_RECHECK calls | **8** (mean 6,851ms) |

The authority window is 120,000ms. **p95 total is 180.6s — 60 seconds past expiry.** Individual
calls are fast (5.8s); the stage is slow because twenty candidates share one window four at a
time, so the whole slot expires and produces *no* order. `FD1_FINAL_RECHECK` is only 8 calls, so
the duplication is not a second AI round — it is the per-candidate ENTRY-scale work in the FINAL
fan-out consuming the window.

## Lever 1 — the deadline cannot be widened by a TTL

`eventExpiry()` read `features.leader20.expires_at_ms` straight from the stored signal, bounded
only by `CAMPAIGN_POLICY.eventTtlMs`. Raising that TTL, or writing a larger stored value, would
have pushed the coordinator's `expires` past `slot_ms + 120s` — and
`CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION` would simply stop firing, letting an expired authority
execute on a stale 24-bucket path. That is the failure mode to refuse, not to relieve.

`clockAuthorityDeadline(window)` now derives the bound from `slot_ms` alone. `eventExpiry()` can
only **tighten** a clock entry to it, never loosen; a malformed window returns `null`, which every
caller treats as already expired (fail closed). `validateStored()` compares against the derived
deadline too, so a record written under a looser TTL is refused as expired rather than executed,
and a non-finite expiry is an immediate refusal instead of an open window. Legacy non-clock
entries keep their own stored expiry, and `eventTtlMs` itself is unchanged at 120,000.

## Lever 2 — the window is not spent on work that cannot finish inside it

A FINAL answer completing after `expires_at_ms` is discarded anyway. Dispatching into a window
too short to hold one buys nothing, costs money, and holds a fan-out slot belonging to a
candidate that still has room.

* `batchFinalDecision()` refuses before the paid call when the remaining window is under
  `CLOCK_FINAL_MIN_BUDGET_MS` (6,000ms — just above the measured 5,847ms mean), reporting
  **`CLOCK_FINAL_WINDOW_INSUFFICIENT`**. Deliberately a *distinct* reason from an expiry, so
  telemetry can never confuse "we ran out" with "we never tried" — and so the floor can be tuned
  from data without touching the expiry rule.
* The fan-out stops once the remaining window cannot hold one more answer, and every skipped
  candidate is still accounted for with that reason. The candidates reviewed inside the window
  keep a real chance instead of all twenty failing together.

Neither change moves a deadline, alters model evidence, or changes a decision.

## Recurrence: a dead collector now names itself

The 04:33 KST outage was invisible for four hours because a gone transport and a late capture
produce the same row: `ready=0, blocked=20, DECISION_WINDOW_INSUFFICIENT`, retry 4–21. The retry
loop then burned each decision window against streams that did not exist.

`leader20_collector_health()` reads the heartbeat the collector already writes (75s threshold —
the worker itself abandons a control response older than 90s). `runEntryBatch` asks it first: when
the transport is gone it records `COLLECTOR_DOWN` with the heartbeat age and returns, with **no
capture read, no batch claim and no provider spend**. `leader20_clock_slot_report.capture_state`
now separates the three cases that were indistinguishable — transport gone, capture incomplete,
no account room — and `final_after_expiry` counts the fills the 120s window lost, a number to
drive to zero by finishing sooner, never by widening the window.

## Still open

* **The collector process itself.** `leader20_collector_health()` makes the outage loud and stops
  the waste, but it cannot start a Fly machine. That needs `top20-book-bootstrap.yml` (collector
  only) or a manual restart; the DB is ready — lease free, `enabled=true`.
* **Reserve and fan-out width.** `decision_reserve_ms` is 80,000 (derived from a two-slot p95 of
  66,835ms) and the clock fan-out width is 4. With the measurements above both are now tunable on
  evidence: `epoch_publish_lag_ms`, `decision_total_latency_ms` and `final_after_expiry` are the
  three numbers to watch before changing either.
