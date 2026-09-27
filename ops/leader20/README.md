# Leader20 dynamic strategy — release candidate

This change is prepared for review. It is **not a live activation**. The migration starts with `observation_enabled=false`, `active_strategy=LEGACY`, and an unapproved archive budget of zero. It changes no account allocation, leverage, slots, API budget, circuit, position, or native order.

## Behavior

- Binance `/fapi/v1/exchangeInfo` selects trading, USDT-quoted/margined perpetual **COIN** contracts. Complete `/fapi/v1/ticker/24hr` coverage is sorted numerically by `priceChangePercent`, then quote volume, then symbol. Negative returns are eligible. Incomplete coverage or a response with no fresh eligible-market timestamp cannot publish an epoch. Individual quiet contracts retain their actual older closeTime and ticker age; lack of recent trades must not veto the entire market ranking.
- The first snapshot is timestamped when actually observed. Following boundaries are 00:00, 06:00, 12:00 and 18:00 Asia/Seoul. The existing generator publishes an atomic, compare-and-swap epoch; an old epoch cannot grant an entry after its refresh deadline.
- An authenticated 20-second observation tick calls only the Leader20 branch of the existing generator. It preserves the old five-minute legacy scan cadence and does not call AI or the order gateway itself.
- The existing collector's watch RPC supplies Top20 plus held/unsettled symbols and the existing BTC sensor. During prewarming it also preserves legacy watches. Collection and AI requests remain separate existing services.
- `leader20_schedule` can request reviews only. Full 24-bucket capture is required. First complete capture, material evidence changes, and a 120-second fairness interval request review; these are scheduling rules, not BUY rules. A partial unique index coalesces each symbol's in-flight work. Per-symbol data errors remain isolated.
- The existing generator materializes a distinct review event into the existing signal table. `features.strategy` retains the old storage/gateway routing identifier; `features.leader20` owns strategic identity. No fake V17 trigger is generated.
- V17 setup, B06133, V30, CEC0040, QV3 and optional directional V24/E1 entry screens do not approve/refuse this route. Existing account, lease, budget, sizing, depth, quote, spread, duplicate, IOC and native protection checks remain.
- GPT FIRST and DeepSeek receive the same frozen 24 rows, including every validated row field; GPT FINAL remains the only strategic authority. Missing advice is explicitly marked and handled by existing degraded-confidence rules. The final response binds ENTER/DEFER or HOLD/PROTECT/EXIT, pressure, counter-evidence, invalidation and next-review conditions.
- Every new-route entry requires a fresh FINAL RECHECK, even without a change flag. The current strategy, epoch and generation are reread before creating an intent and again before gateway dispatch. Expired or non-current approvals cannot dispatch.
- SKIP/WAIT/ABSTAIN remain the legacy wire vocabulary but are campaign DEFER outcomes. A completed review is retained; the campaign keeps observing and only new evidence creates another review event. Reentry requires settlement followed by a completely new 120-second window and new approval.
- Existing holdings are managed even outside Top20. Their native stops and position generations remain intact. When the new strategy is active, inherited positions receive the new HOLD packet contract too.
- No synthetic ATR is created. New-route ledger `entry_atr` is NULL, permitted only for positions marked Leader20; legacy rows still require it. This route's existing native protection is percentage based.

## Verification

Install Node 22+ and Deno 2.5.6. Install `@electric-sql/pglite@0.3.14` in a temporary dependency directory and set `PGLITE_MODULE` to its absolute `dist/index.js` path.

```sh
node ops/dynamic-flow/run-tests.mjs
deno check --no-config supabase/functions/v10-lane-executor/index.ts supabase/functions/v10-lane-signal-generator/index.ts
deno task test
git diff --check
```

The PostgreSQL tests run the actual new migration using synthetic prerequisites and source observations. They prove atomic publication, duplicate coalescing, generation/epoch refusal, continued DEFER observation, settlement invalidation, held-symbol watches, durable review audit, raw archive deduplication, private access, and bounded archive failure. The existing regression suite proves the IOC/protection/reconciliation paths. Tests are not a production replay or evidence of a live fill.

## Deployment gates

1. Freeze a reviewed commit and verify current production versions again. The read-only baseline on 2026-09-27 was main `33c9695a56e7866cb8cdb440e0a5e31d47a6520b`, executor v130, generator v29, capture ingest v1, existing collector `DOA-CAPTURE-6-MARKET-SENSOR`. This is metadata, not proof that all deployed source files match that commit.
2. Apply only `20260927121708_leader20_campaigns.sql` through the existing migration procedure after verifying migration history. Do not run an unreviewed blanket push of pending historical migrations. Deploy the generator and executor from the same reviewed source tree using their existing internal-token authentication. Verify downloaded bundles with the existing bundle parity tool. No second trading service is installed.
3. Approve storage capacity before setting `archive_max_bytes`. The raw archive currently never deletes data. It has no verified 30-day cold-storage/export pipeline yet. A full/unapproved archive cannot permit new-route entries; its cap pauses only new-strategy entry and preserves live capture and position management. Do not disable native protection or raise budgets automatically.
4. Enable observation, wait for real 24/24 coverage, and inspect `leader20_status()`. Verify heartbeat, reconnect/restart recovery, current epoch and inherited-position protection using existing production readiness/monitoring. Compare before/after settings.
5. Resolve AI capacity. At 20 symbols and a 120-second fairness interval, continuous complete coverage would request **14,400 review jobs/day**, before change-triggered reviews, HOLD and FINAL RECHECK. A normal successful dual review uses three provider requests. The observed control allowed 300 review jobs/day and USD 50/day. These are not sufficient for unrestricted continuous fairness reviews. Actual token costs and latency require a bounded forward observation; no limit has been raised.
6. Historical full-market Top20 24-bucket data was not retained by the old strategy. Exact 48-hour new-strategy replay is therefore UNKNOWN until source coverage proves otherwise. Do not relabel candles, partial old Top10 data or synthetic fixtures as that replay. Forward collection, replay coverage and retention must be verified before production readiness is asserted.
7. Before switching strategic ownership, pause new entries through the existing operator control, let the active execution lease and pending/ambiguous intents settle, and retain native position management. Verify all source hashes, 20 fresh members, archive readiness, capture coverage, provider credentials, approved capacity and protection. Atomically switch the strategy and increment generation; retire old review events. Release the existing pause only through the operator's approved rollout. Never restore an old strategy automatically.

The authorized leader20-release workflow deploys the existing services and enables observation on main. It does not activate strategic ownership, raise budgets, or submit validation orders. The migration was applied through Supabase MCP as 20260927125415_leader20_campaigns (the local source filename remains 20260927121708_leader20_campaigns.sql). `leader20_status().live_activation_ready=false` deliberately reports the unresolved external release gates; passing local tests does not change it. An operator must complete and record these gates before the flag/report and rollout are finalized.

## Operations and recovery

`leader20_status()` is service-only and returns the epoch, full membership, campaigns, review queue, archive size and release requirements. Complete original AI packets remain in `gpt_final_entry_reviews`; the event result links its job and snapshot. `fd1_final_recheck_log`, order intents, positions and existing protection records retain the execution chain.

If capture is partial/stale, epoch refresh fails, GPT is unavailable or budget is exhausted, new entry stays deferred. Holdings keep their native hard stop and last approved protection. No delayed answer creates a new approval. A rollback first pauses new entries and invalidates pending approvals by generation; keep the compatible migration, capture, native protection and settlement. Do not delete live protection orders or roll back to an incompatible executor that cannot recognize new positions.

Still required before calling this LIVE: approved rollout/capacity, verified deployed bundle/worker identities, exact historical or forward replay coverage, measured inference latency/cost under load, durable retention/export, existing dashboard/alert integration, and observation of natural reviews/rechecks/fills and a real six-hour rotation. Unobserved events must remain explicitly unobserved.
