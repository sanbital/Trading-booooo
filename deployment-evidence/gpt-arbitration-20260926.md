# Production GPT arbitration release — 2026-09-26

Production executor **v100 ACTIVE**. Artifact SHA-256: `2240e56d1479f1b0af8f9da47fe7120766b073d8cd3e5b2db0fb866823292d87`. All 61 downloaded source files exactly match the submitted release. Executor source commit: `5a52998882cbbd047bbf58ea96b7b660097f4470`. [PR #189](https://github.com/sanbital/Trading-booooo/pull/189) carries the reconciled source and evidence. See the adjacent JSON for request identities, hashes, model citations and RPC observations.

## Reconciliation and authority

Started from main `5f870b7db892b8d7160809f6cf2d1ca757afa591` and the complete v97 source artifact `5b562a53085d27c3f02f0d216e009d551e4494b9510e49299ebfbcc553e8617a`. Reconciliation was committed before implementation (`1c0693abd0faee0aa23bdbca8a38d2dccdd9e258`); baseline regression passed 399 tests. Main-only files and all v97 production-only code were retained. The existing dirty checkout was not modified. PR #188's shadow-only design was reviewed but not deployed.

ENTRY, FINAL RECHECK and event-driven HOLD/strategic EXIT now use the same arbitration implementation: independent GPT FIRST and DeepSeek calls overlap on identical immutable market inputs; only a validated GPT FINAL decision can authorize strategy action. FINAL receives both reviews, current facts, the ordered trajectory, current position/execution/safety state and changes after the first snapshot. Invalid/mismatched advice is explicit, never an executable veto. Final failure never falls back to a FIRST decision. Journals preserve both hashes and structured adoption/rejection evidence.

DeepSeek uses `deepseek-flash`; GPT retains `gpt-5.4-mini-2026-03-17`. Its independent advisory response has structured preference, thesis, risks, evidence paths, trajectory interpretation, counterargument and recommended action. FINAL schema constrains citations to actual evidence paths; each adopted/rejected DeepSeek claim must be recorded as considered. Three real-model probe iterations exposed and corrected path qualification, prose bounds, twelve-claim review capacity and RECHECK provider-time allocation before the final v100 verification.

## Preserved live execution behavior

Binance Futures, **150 USDT margin per slot, 3x leverage, MAX_SLOTS 10**, dynamic capacity, CEC0040/V17/V30/B06133 evidence, bounded IOC retry, partial-fill reconciliation, native stops, hard account safety, circuit breaker, stale-data checks and lease/fencing remain. Runtime is enabled, circuit closed, GPT mode ENFORCE, daily cap $3 and max_calls_per_day 300 unchanged.

Hard protective exits execute before AI strategy review. A model timeout cannot approve a strategic close. PROTECT retains existing native/deterministic protection and requests an earlier review; it does not widen/cancel stops or itself place a new stop. Time-based strategic exit candidates require a valid final EXIT; unresolved reviews keep protection and retry.

The pre-dispatch arbitration has an 8-second ceiling. Entry/retry time reserves increased by exactly the added four seconds (24s/20s) so settlement and native-stop protection retain their previous time allowance. Call limits, position capacity and sizing did not change. Capacity and bounded-retry tests still pass.

## Capture repair and actual observations

Root causes were inconsistent one-character symbol validation and a collector that retained market buckets in memory but persisted them only around finite research windows. The service now validates normalized active Binance USDT perpetual symbols including QUSDT and continuously persists watched-symbol micro buckets. Scanner top-10 pre-buffering and open-position capture share the existing watch path. A private service-only 10-minute ring decouples continuous production capture from finite research caps. Retention, ingestion diagnostics, received-at checks, stale/sequence/depth validation and the original 12 ordered deltas are maintained. Additional per-bucket trade count, arrival rate, aggressive notional, bid-book changes, spread/depth/imbalance and BTC context remain available without fabricated observations.

Migration applied: `20260926125702_continuous_capture_arbitration`. Worker image: `sha256:2d9a13b817f848fb9bfaf3dd79cc231534c0bb1844a02515548b7b60f7c69da2`, built from `bfcb99a58e670e1542b8a593cb67fbf833ca4998`. The old ephemeral Fly machine could not be updated; a persistent successor used the same app configuration, secrets and 1 CPU/256 MB resources, with the DB lease preventing concurrent collectors. [Successful deployment run](https://github.com/sanbital/Trading-booooo/actions/runs/36244118177).

QUSDT, SPELLUSDT and JELLYJELLYUSDT returned AVAILABLE / 12 buckets / 12 points repeatedly from 13:13 through 13:31 UTC. At 13:33 UTC all current scanner top-10 symbols returned AVAILABLE / 12 / 12. Worker observed 20 watched and 20 synced symbols, zero REST failures, ~109 MB RSS and ~3s heartbeat age. An actual transient OPGUSDT incomplete window was retained as unavailable and subsequently recovered; missing data is never relabeled as complete.

## Validation and limits

- **478 tests passed, 0 failures**: arbitration independence/mismatch/no-veto/no-fallback, SQL capture ingestion/continuity/retention/RLS, entry capacity, IOC/partial-fill/native protection, account reconciliation and HOLD/EXIT behavior. Deno executor and capture-ingest checks passed. CI now runs the complete suite on future strategy/capture changes.
- Authenticated order-free v100 requests: **2009 / 2010 / 2011**, all HTTP 200 and **orderCalls=0**. ENTRY: FIRST SKIP / DeepSeek SKIP / FINAL SKIP. FINAL RECHECK: FIRST SKIP / DeepSeek SKIP / FINAL SKIP, 6338 ms. HOLD: FIRST HOLD / DeepSeek HOLD / FINAL HOLD. Another strategic-exit fixture: FIRST EXIT / DeepSeek PROTECT / FINAL EXIT. All four had valid DeepSeek advice, matching independent snapshot hashes, AVAILABLE 12-point trajectories at FIRST and FINAL, and recorded claim adoption/rejection. ENTRY/RECHECK provider start times differed by only 1 ms.
- Unit tests also prove FIRST BUY + DeepSeek opposition can end in either FINAL BUY or FINAL SKIP; DeepSeek EXIT can end in FINAL HOLD, PROTECT or EXIT.
- No live position was open during verification. Position reviews used live market data with fixture positions. These probes establish production decision-path wiring and contracts, not realized trading returns or live fill outcomes.
- Provider outages and genuine data gaps remain explicit degraded states. New watched symbols need a full buffer; no synthetic prehistory is created.

Two legacy broad main-push deployment workflows are now manual-dispatch-only for their deployment jobs: they could replay obsolete settings/migrations or deploy a legacy autotrader merely because shared modules changed. Their validation jobs remain. No old main bundle was redeployed over production.
