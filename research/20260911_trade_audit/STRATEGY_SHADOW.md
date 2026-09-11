# Strategy hypotheses: isolated observation only

Frozen at 2026-09-11 11:19:42.867438 UTC. See `strategy-shadow-protocol.json`.
All 99 available automatic episodes have already been seen; 58 carry the same R5
exit policy and are reported separately by operational patch. None are an untouched
validation set. Prospective observations start with the first successful remote run.

## Rules and evidence

- `REPEAT_STOP_2`: count confirmed, negative automatic stop closures in the same KST
  day and flag further entries after two. Current patch: fixed-entry diagnostic
  -8.4798 to -4.2569 USDT, 24 to 22 retained episodes. However the earlier
  `V17-EXIT-SETTLE-1` cohort falls from +7.1473 to +0.4471. Not promoted.
- `SPIKE_3PCT`: flag a completed 5m return of at least 3%. Current patch deteriorates
  to -10.3968; removing two winners costs +6.5764. Not promoted.
- `COMBINED`: apply both, with its own accepted-trade history. Current patch -9.3118.
  Not promoted. Threshold neighbors 1/3 stops and 2%/4% spikes are sensitivity checks,
  never selected post hoc as a new winner.
- `LOCK_1P5`: existing 50% peak capture starts at +1.5% instead of +2%. The prior
  fixed-horizon episode replay shows an earlier R5 sample +7.8799 to +11.0388,
  but the six eligible new-patch episodes are unchanged (+6.6300). Not promoted.
  Existing superior stops, peak, quantity, partial state, 2.5% initial stop and
  maximum hold are preserved. No live position uses this candidate.

All monetary results above exclude unverified funding. Filtering diagnostics retain
actual fills for retained entries and cannot reproduce replacement opportunities or
changed cash/slot competition. Stress doubles exact fill fees and adds 20bp adverse
exit impact, plus a separate 180s settlement-availability lag. Actual net is never
charged an estimated slippage a second time.

The recorded-bid replay sequentially reconstructs 948 existing R5 decisions; stop
and action match on all 948. This establishes deterministic decision parity on
recorded inputs, **not** intraminute fill-price fidelity or account backtest validity.

## Observation architecture

`v18-strategy-shadow` reads the existing complete top-10 scan, independently obtains
14 completed 5m bars for baseline eligible names from public Binance GET endpoints,
and evaluates every frozen variant. It does not depend on live entry being enabled.
It also compares baseline/LOCK_1P5 on fresh recorded bids for any owned live position;
these are current-state counterfactuals, not independently evolving paper positions.

The only write is an append-only row in `v18_strategy_shadow_runs`. `(policy_version,
slot_at)` preserves the first observation on concurrent/repeated minute invocations.
The table is private under RLS, without anonymous/authenticated grants. The host has
no gateway, broker, signer, live signal writer, order writer or control writer.

Authentication uses the existing diagnostic internal token, checked in the body.
Never print or export token values. Wrong/missing auth, clock skew, market API denial,
history truncation, failed persistence and stale scans are explicit failures or
unavailable evaluations. HTTP 200 by itself is not proof of a valid evaluation.

## Reproduce and deploy

Run the existing full regression plus `strategy-shadow*.test.mjs` with the pinned
PGlite dependency. `entry-filter-review.mjs` takes frozen positions, original audit,
recorded decisions and an output path. Companion evidence contains the inputs.

1. Compare current production metadata to the existing baseline. No live executor
   or scanner replacement is part of this change.
2. Test the exact commit tree. Apply only
   `20260911112129_v18_strategy_shadow_observations.sql`; do not push full DB history.
3. Deploy `v18-strategy-shadow` with `index.ts`, `handler.mjs`, and its three shared
   modules (`leader-strategy-shadow`, `leader-momentum-v17`, `leader-exit-review`).
4. Require 401 for unauthenticated invocation and a valid authenticated stored
   observation. Byte-compare remote files and record function version/bundle SHA.
5. Apply `ops/v18-strategy-shadow-cron.sql`, then observe at least three consecutive
   successful persisted evaluations spanning a fresh scanner cycle. Report actual
   candidates/rejections; no fabricated trades or paper PnL.

Rollback the observer with `select cron.unschedule('v18-strategy-shadow-observe');`.
Preserve collected evidence. This rollback does not touch trading controls or stops.

Live promotion still requires every frozen gate: 100 post-update closed episodes,
30 chronological validation trades across 3 windows, actual-fill error <=0.25 USDT
per trade, positive net expectancy and improvement, no worse drawdown/worst loss,
>=70% opportunity retention, cost/delay stress, funding coverage and account-level
cash/slot replay. Count thresholds never require continued real-money losses.
No candidate currently passes all gates. Real-account activation remains unapplied.
