# V25 — new-entry extinction after the 40 → 30 USDT slot cutover

Window: executor v48 deploy `2026-09-16T23:09:24Z` → `2026-09-17T13:05Z`.
Production project `etaajwpernzrcdrifdnw`. 144 signals, **0 entries**.

Throughout that window the runtime reported itself healthy: `circuit_open=false`,
`last_error=null`, cycles completing inside the cadence, `live_enabled=true`,
`entry_enabled=true`. None of those look at the entry path.

## Root cause — three independent defects, all structural

### 1. A fixed USDT buffer paid for out of a relative price cap

`sizeEntry` ceiled the quantity to the target notional and then made up the
shortfall to `NOTIONAL + 0.12 USDT` by **raising the limit price**, under
`IOC_MAX_BPS = 12`. The uplift that demands is

```
requiredUpliftBps = NOTIONAL_BUFFER_USDT / sizedNotional × 10_000
```

worst case `NOTIONAL_BUFFER_USDT / targetNotional × 10_000`:

| slot | notional | worst-case uplift | cap | result |
|------|----------|-------------------|-----|--------|
| 40 USDT | 120 | 0.12/120 = **10.00 bps** | 12 | never fires |
| 30 USDT | 90  | 0.12/90  = **13.33 bps** | 12 | **self-refusing band** |

Changing only the margin opened a band of ordinary candidates the executor
refused by arithmetic. 20 `ENTRY_GRANULARITY_BPS` rejections at 12.479–13.199 bps
— and the symbols hit were the ones with the *finest* lot steps (ONEUSDT,
REZUSDT, SAGAUSDT), because a fine step lands `sizedNotional` closest to 90,
which is exactly where the demanded uplift is largest.

### 2. E1 judged a quote it was never given a fresh copy of

`E1_POLICY.maxQuoteAgeMs = 1000`. `runE1Gate` was handed the **admission-time**
quote and then stamped `decisionAt` *after* its own 10-second aggTrades fetch.
Measured over the window: **118 defers carried a quote age, 0 were inside the
policy** — 1097 ms minimum, 2596 ms maximum, 1543 ms average. A minimum above the
ceiling is the signature of a fixed cost, not of a slow venue.

### 3. One deferred candidate ended the whole run

`runEntryQueue` did `break` on **any** `releaseClaim`. So the first candidate to
hit (2) abandoned every remaining candidate for that cycle — every cycle. The
untouched candidates then aged out together:

```
stale rejections                        102
  written within 12s of bar close       102   (2.1 .. 10.3 s)
  FIRST evaluated after bar close       124.8 .. 136.5 s
  ever evaluated inside the 120s window 0
```

Not one of the 102 was ever looked at while it was still fresh. This is the same
starvation `test-support/v17-exit/entry-queue.test.mjs` was written for on
2026-09-09; the earlier fix raised the attempt count but left the `break`.

## The fix

### `supabase/functions/_shared/leader-slot-sizing.mjs` (new)

One authoritative slot contract. The rounding headroom is **relative**
(`notionalBufferBps = 10`, which *is* the old 0.12 USDT at a 120 notional) and is
satisfied by **quantity**, never by price. The limit price is a pure function of
the ask and the tick, so a sizing decision can demand **0 bps** of uplift — the
self-refusal is not re-tuned, it is unrepresentable. `assertSlotSizingContract()`
asserts that at import and the release workflow asserts it again.

```
target margin      30 USDT         (operator instruction 2026-09-16)
leverage           3x
target notional    90 USDT
quantity           smallest lot-aligned amount meeting the target at the ask,
                   the exchange min-notional at the ORDER price, and min-qty
notional buffer    10 bps of target, carried by quantity   (= 90.09 USDT)
limit price        ceilTick(ask × (1 + 3 bps)), BUY rounds UP
ioc cap            12 bps, now purely a slippage bound
margin overshoot   250/3 bps of the slot = 30.25 USDT exactly, unchanged
```

Skips are one cause each — `MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET`,
`QTY_STEP_EXCEEDS_MARGIN_BUDGET`, `IOC_PRICE_CAP_EXCEEDED` — instead of two
different failures sharing `ENTRY_SLOT_GRANULARITY_MARGIN`.

### The four copies of the slot size

`MARGIN`, `POLICY.marginUsdt` and the generator's `targetMarginUsdt` now all read
the contract, and the generator stamps `sizingContractVersion` on every signal.
The **DB** half stays a runtime comparison: `V17_MARGIN_CONFIG_MISMATCH` is kept,
so a live `trading_settings` row can never silently resize a running order.

### E1 and the queue

`runE1Gate` reads its quote at its own decision point, issued alongside the tape
so it costs no extra latency. `maxQuoteAgeMs` is **unchanged at 1000**.

`runEntryQueue` now: collapses a symbol to its freshest candidate (older ones
retired `SUPERSEDED_BY_FRESHER_SIGNAL`), retires already-expired candidates
before any gateway/BOO/E1 work using the **same** `POLICY.maxEntryAgeMs`, and
continues past a **symbol-scoped** defer while still stopping on an
**account-scoped** one. Releases carry an explicit `releaseScope`; an unlabelled
release still halts, so the change is opt-in and fail-closed. A wall-clock
`ENTRY_RUN_BUDGET_MS` replaces the attempt count as the cadence bound.

`maxEntryAgeMs` (120 s) and `maxEntryDriftPct` (1%) are untouched.

## What is NOT changed

BOO enforcement stays `OBSERVE`. The BOO risk policy still reads
`risk_per_trade_pct=100` as 100% and `max_daily_loss_pct=30` as 30% and refuses
them as implausible — no DB risk value was altered. No strategy threshold was
tuned. Exit, native protection, QV3, X1, reconciliation, settlement, accounting,
order idempotency and lease/fencing are untouched.

## Replay

`test-support/v17-entry/production-replay.test.mjs` reconstructs the exact
(quantity, ask) behind every stored sizing rejection, verifies the reconstruction
reproduces the stored figure to the digit, then re-runs it through the new
contract. 20 of 26 are admitted; the 6 that remain skipped — NEARUSDT (lot step 1
at ~2.7–2.9) and UNIUSDT (lot step 1 at 6.75) — genuinely cannot be bought in
90 USDT of notional at that granularity, and say so in their reason.

## Strategy performance is a separate question

Last 20 closed trades: 7 wins, 13 losses, net **−16.56 USDT** (−0.83/trade); the
last 7 days of DB position PnL is about **−71.68 USDT**. Restoring execution does
not make the strategy profitable and is not evidence that it is. This change
fixes availability and sizing correctness only.
