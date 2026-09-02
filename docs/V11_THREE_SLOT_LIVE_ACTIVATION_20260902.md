# V11 three-slot live activation — 2026-09-02

## What was actually blocking three slots

`MAX_SLOTS = 3` was already set in both executors and in the signal generators, but
three concurrent positions were impossible for four independent reasons. Each one
alone was sufficient to cap the system at one slot.

| # | Gate | Where | Effect |
|---|------|-------|--------|
| 1 | `v11_long_regime_one_open_position` | unique index on `v11_long_regime_positions ((1)) where state='OPEN'` | Hard 1-position cap in the database |
| 2 | `not exists (... state='OPEN')` | `v11-micro-generator` / `v11-long-regime-generator` cron | No signals produced once slot 1 filled, so slots 2–3 were unreachable |
| 3 | `not exists (... state='OPEN')` | `v11-micro-executor` / `v11-long-regime-executor` cron | Entry path never fired when the open position belonged to the other lane |
| 4 | `FUTURES_MIN_ENTRY_MARGIN_USDT = 40` | `gateway/server.mjs:1077` | 3 × 40 = 120 USDT of margin required; wallet held 118.74 |

Gates 1–3 are fixed. Gate 4 is a deliberate risk floor living on the static-IP order
gateway and is **not** changed here — see "Remaining limit" below.

## The incident this uncovered

At `12:01:12Z` the micro executor's IOC entry for **FILUSDT filled on Binance**
(155.3 FIL @ 0.7733, 40.10 USDT margin) and the follow-up
`v11_long_regime_positions` insert was rejected by gate 1:

```
POSITION:duplicate key value violates unique constraint "v11_long_regime_one_open_position"
```

The executor's catch path records `RECONCILIATION_FAILED` without the exchange
order id and opens the circuit. The result was a **live position with no database
row**: no hard stop, no time exit, no profit guardian — and, because the account
snapshot writer pauses while an unreconciled exchange position exists,
`trading_account_snapshots` also froze at `11:55:49Z`.

The position ran unmanaged for 95 minutes. It was adopted back into
`v11_long_regime_positions` from exchange truth (`p10_portfolio`), after which the
executor closed it on its own rules at `13:36:05Z`:

- exit `0.7672`, reason `MICRO_HARD_STOP`, realised **−1.067 USDT**
- managed from the start it would have stopped near `0.7706` for about −0.48 USDT
- the snapshot pipeline resumed by itself at `13:36:13Z`

This is why gate 1 was replaced rather than merely relaxed: an index that rejects a
position *after* its order has filled converts a normal entry into an untracked
live exposure.

## Changes

**Database** — `20260902132053_v11_three_slot_live_activation.sql`
- drops `v11_long_regime_one_open_position`
- adds `v11_long_regime_one_open_position_per_symbol` (one open position per symbol)
- adds `v11_long_regime_slot_cap_trg`, an advisory-lock-serialised trigger capping
  open positions at 3 — the same number the executors use, so a filled entry is
  always recordable

**Cron** — `20260902134102_v11_three_slot_generator_gate.sql`,
`20260902134139_v11_three_slot_executor_gate.sql`
- generators run while fewer than 3 positions are open
- executors run while fewer than 3 are open, or whenever their own lane holds one

**Executors** — capital-scaled slot sizing
- `slotMargin(pf)` derives the per-slot margin from the live wallet balance:
  `min(MARGIN_CAP, max(GATEWAY_MIN_ENTRY_MARGIN_USDT, floor((settled − 2) / 3)))`
- `sizeEntry(ask, step, margin)` takes the target margin as an argument instead of
  reading a fixed `MARGIN` constant
- `GATEWAY_MIN_ENTRY_MARGIN_USDT` mirrors the gateway's floor so sizing can never
  drop under it — when capital cannot fund three slots at that floor the third
  slot simply stays unfilled, and no order is sent
- fixed a latent `ReferenceError` in the micro executor's lane-switch audit call
  (`maxHoldMin` was undefined in that scope; it is now `maxHoldMin: maxMin`)

## Remaining limit

The gateway floor makes three slots an arithmetic question:

```
3 slots × 40 USDT margin + granularity/fee headroom ≈ 120.8 USDT
wallet at 13:41Z                                    = 118.74 USDT
fundableSlots (from preflight)                      = 2
```

Two ways to reach three funded slots:

- **Top up to ~121 USDT.** No further code change. `slotMargin` caps at 40, so each
  slot sizes at exactly 40 and the third fills as soon as the balance allows.
- **Lower the floor.** `FUTURES_MIN_ENTRY_MARGIN_USDT` in `gateway/server.mjs` and
  the matching engine floor would both have to come down. The gateway is deployed
  to its static-IP host from `main` by `.github/workflows/deploy-order-gateway.yml`,
  so this needs a merge to `main`, not an edge-function deploy.

## Deployment state

| Component | Status |
|---|---|
| `v11-micro-executor` | deployed, `IOC-ENTRY-V7-EQUITY-SCALED-3SLOT-GWFLOOR` (v7) |
| `v11-micro-profit-guardian` | unchanged — already iterates `MAX_SLOTS` positions |
| `v11-micro-signal-generator` | unchanged — already `3SLOT-V2` |
| Database migrations + cron gates | applied |
| `v10-lane-executor` (BULL) | **committed but not deployed** |

The BULL executor carries the same sizing change in this branch. It was not
hand-deployed: the file is 15 KB of minified live order-placing code, its production
copy already matched the repo, and its deploy path from `main` copies the file
verbatim. Redeploying it by retyping is a larger risk than the gap it closes — with
the gateway floor in place the BULL lane behaves exactly as before either way.
Let it ship through the normal `main` deploy.
