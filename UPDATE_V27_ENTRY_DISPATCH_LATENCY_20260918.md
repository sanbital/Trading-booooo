# V27 — the V17 entry pipeline's extinction point (2026-09-18)

## What production was doing

Between the v51 deploy and 2026-09-18 09:20 UTC the executor produced **253 signals**,
armed setups, observed pullbacks and fired triggers — and wrote **0 order intents**.
Every stage worked; the last one could not be reached.

The signal rows named the symptom (`V17_TRIGGER_STALE` ×14, `V17_CHASE_EXPIRED` ×28,
`V17_SETUP_EXPIRED` ×28). `v11_long_regime_decisions` named the cause:

```
08:21:05.173  METUSDT   V17_REACCEL_TRIGGERED   triggerAt=08:21:00
08:21:08.139  METUSDT   ENTRY_ALLOW  E1_NOT_FAST_WEAK
08:21:10.324  METUSDT   ENTRY_DEFER  E1_DISPATCH_QUOTE_AGED     <-- 49s of window left
08:22:09.006  METUSDT   ENTRY_REJECT V17_TRIGGER_STALE

08:49:07.104  STRKUSDT  V17_REACCEL_TRIGGERED   triggerAt=08:49:00
08:49:36.157  STRKUSDT  ENTRY_ALLOW  E1_TWO_BLOCK_RECOVERY      <-- 29.1s in the watch
08:49:39.608  STRKUSDT  ENTRY_DEFER  E1_DISPATCH_QUOTE_AGED
08:50:07.613  STRKUSDT  ENTRY_REJECT V17_TRIGGER_STALE
```

`V17_TRIGGER_STALE` was never the refusal that mattered. It is what the *next* cycle
writes about a trigger that the *previous* cycle released.

## Root causes

1. **The pre-dispatch quote could not be fresh.** The last check before the order
   intent asserts the pricing quote is younger than `E1_POLICY.maxQuoteAgeMs`
   (1000 ms). That quote was read *before* the entry-control decision and the BOO
   pre-dispatch gate — five sequential round trips, two of them to the gateway. The
   check was therefore unmeetable by construction: **7 of the 8** candidates that
   reached it in 24 h were refused `E1_DISPATCH_QUOTE_AGED`.
2. **E1 drained a watch whose answer was discarded.** `runE1Gate` ran the 30-second
   `WATCH_FAST_WEAK` loop to completion before `openBull`'s documented conversion
   could fire — making that conversion dead code, and spending up to half of a
   60-second trigger window re-deriving an answer a completed bullish 1 m candle had
   already given.
3. **Arming cost a whole cycle.** `advanceSignalSetup` armed a setup and returned
   without reading a candle. A setup whose pullback and re-acceleration both sit on
   the bar it is armed *from* triggers at `armedAt + 60s` and was not discovered until
   the next minute, after its window closed: GUSDT 08:20, UNIUSDT 03:15, OPUSDT 03:20,
   DRIFTUSDT 06:00, BABYUSDT 00:25.
4. **Sizing evaluated one point on the quantity lattice.** `planSlotEntry` computed
   `ceil(requiredNotional / ask)` and refused the symbol when that overshot the margin
   ceiling, never asking whether the multiple below fits. UNIUSDT: qty 11 = 32.70 USDT
   of margin against a 30.25 ceiling → refused, while qty 10 costs 29.73 USDT and is
   99.1 % of the slot.

## What changed

| File | Change |
| --- | --- |
| `v10-lane-executor/index.ts` | `booGate` split into `booGateInputs` (I/O) + `booVerdict` (pure); `decideEntry` split into `decideEntryWith` (pure) + async wrapper; the dispatch quote and BOO's four reads issue in **one** `Promise.all`, and nothing between that quote and the age check performs network work on the path to an order. `recordBooVerdict` moved behind the freshness check. |
| `v10-lane-executor/index.ts` | `runE1Gate(..., watchFastWeak)`; setup-governed signals skip the fast-weak watch, which makes the existing conversion reachable instead of dead. |
| `v10-lane-executor/index.ts` | `advanceSignalSetup` arms **and** advances in one cycle; a market failure right after arming still persists the ARMED state. |
| `v10-lane-executor/index.ts` | The setup-advance pass is ordered TRIGGERED → PULLBACK_OBSERVED → ARMED → legacy, freshest bar as tiebreaker, so the 12 s advance budget is never spent on setups with minutes left while one with seconds left waits. |
| `_shared/leader-slot-sizing.mjs` | `planSlotEntry` searches the lattice downward to the largest admissible multiple; new `minSlotFillBps` floor and `QTY_STEP_BELOW_SLOT_FLOOR` reason; `slotFillBps` and `boundBy: MARGIN_BUDGET_CAP` reported. |
| `v10-lane-executor/entry-evidence.mjs` | Every drift/staleness refusal now records signalId, symbol, setupState, triggerClose, quoteAgeMs, triggerAt and triggerExpiresAt alongside what was already there. |

## Explicitly unchanged

30 USDT slot @ 3x · 250/3 bps overshoot budget (30.25 USDT ceiling) · `MAX_SLOTS` 10 ·
`maxEntryDriftPct` 1 % · `maxEntryAgeMs` 120 s for legacy signals · `setupTtlMs` 15 min ·
`entryTriggerTtlMs` 60 s · pullback/re-accel/chase thresholds 0.25 %/0.25 %/1 % ·
`E1_POLICY.maxQuoteAgeMs` 1000 ms · `E1_POLICY.watchMs` 30 s · the R5 exit policy ·
BOO gate enforcement · the `V17_NATIVE_STOP` operator flag · every exit, protection,
settlement and reconciliation module (asserted by source parity in the release gate).

## `V17_CHASE_EXPIRED` and `V17_SETUP_EXPIRED` are not defects

Both were reconstructed against the state machine and are the strategy working as
specified: `CHASE_EXPIRED` fires when a bar closes more than `maxChasePct` above the
reference — the premise was buying near the level, not above it — and `SETUP_EXPIRED`
is a 15-minute window that saw no pullback or no re-acceleration. The two
`V17_ENTRY_DRIFT` refusals were also genuine: GUSDT 08:00 UTC, reference 0.007177 vs
limit 0.007255 = **+1.087 %**, and 07:47 UTC, +1.274 % — both past the unchanged 1 %
ceiling, on quotes 1.2–1.4 s old whose asks (0.007252, 0.007154) were themselves above
the ceiling. No threshold was touched for any of them.

## No gateway deploy required

This release adds no gateway command. `quote`, `fees`, `futures_position_mode` and
`v18_open_orders` are all already served by the live gateway — they are what v51 calls
today. The release gate still asserts `/health` advertises `futures_position_mode`
before the executor moves, so the ordering is proven rather than assumed.
