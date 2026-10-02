# Deterministic engine release and operator cutover

Status: review branch only. No migration, Edge deployment, scheduler change,
account-authority change or real order was performed by this work. This document
is an operator procedure, not evidence of a completed release.

The release changes trading decisions; it preserves leverage 3, slot margin
150 USDT, maximum 10 slots, native hard floor 2.5%, ONE_WAY verification,
quantity/tick/min-notional checks, two bounded IOC attempts, execution fencing,
original-order reconciliation, canonical fills and accounting. It never restores
LLM decisions on failure. Capture failure blocks that symbol's entry; incomplete
account/order truth blocks new exposure. Existing native protection remains live.

## Review and reproduce

1. Review the exact commit and migration against current main. The parent includes
   PR #311 account critical sections and final gateway fencing. Compare deployed
   source, gateway build and applied migrations; version numbers alone are insufficient.
2. `npm ci --prefix test-support/deterministic`
3. `npm test --prefix test-support/deterministic`
4. Run the native protection/settlement and account critical-section regressions
   listed in `.github/workflows/deterministic-verification.yml`.
5. Reproduce calibration from the authorized private chronological entry export:
   `node ops/deterministic/calibrate.mjs entry50.json 2026-10-01T20:00:00Z profile.mjs`.
   Compare output bytes with the committed profile. Do not substitute other units
   or optimize thresholds against the three held-out incidents.
6. Causal replay:
   `node ops/deterministic/replay.mjs entry50.json archive.json candles.json replay.json`.
   Private exports must not be committed to this public repository. Replay book
   VWAPs are hypothetical prices, not exchange fills or strategy performance proof.

## Quiesce and reconcile

The operator must first pause **new entry admission only**, preserving native stops,
position management, reduce-only reconciliation and exchange-trade-sync. Wait for
all current account writer/analysis holders and provider reviews to finish. Do not
restart PostgreSQL or extend a stale BUY deadline. Save config, scheduler and source
manifests for recovery; never print service-role keys or gateway secrets.

Read fresh signed Binance positions, ordinary orders and conditional orders; compare
DB positions, original client/order IDs, canonical fills/fees, attribution and native
stop acknowledgements. Resolve UNKNOWN before allowing new orders. Existing positions
are handed over by generation/CAS; no forced liquidation, duplicate stop or duplicate
close is part of this change. Margin mode and account identity must be observed and
preserved; the branch does not silently set either.

## Install with entries paused

Apply `20261002102500_deterministic_dynamic_state.sql` only after the entry pause.
It defaults the new entry control to disabled, preserves history, retires four
provider-era journal/wake triggers, adds Top20 and batched capture RPCs, and replaces
provider-bound gateway BUY proof with deterministic submit proof. Keep the preceding
PR #311 migration, account writer/analysis leases, heartbeat and restart fences.
Deploy the exact executor and generator bundles. Keep gateway sizing/nonce/HMAC,
recvWindow and native-stop behavior. No provider key is required by these bundles.

Retire all old AI entry/review and duplicate wake schedulers: legacy generator #49,
GPT expiry #111, GPT durable recovery #148, clock maintenance #147 and old execution
outbox sweeper #151. Disable only the old strategy-specific entry/AI scheduler routes
that the current manifest confirms. Keep canonical fill sync, accounting, reconciliation,
capacity reservation sweep #152 and independent emergency/native protection. Replace
clock-gated observer #107 with a continuous five-second generator observation and run
one five-second deterministic executor cycle. Do not run old and new entry schedulers
concurrently. Read current IDs by name before changing them; the observed IDs are not
permanent authority. Preserve the archive maintenance route and its bounded retention.

Publish a valid fresh Top20 epoch while entry admission remains paused. Collector
watch must contain all 20 symbols plus BTC and every held symbol. Wait until each
eligible symbol has 25 causal boundaries yielding 24 completed five-second buckets.
Verify closed 1m/5m/BTC candles; invalid symbols remain NO_ENTRY without stopping others.
The cold archive is compact bucket data. Missing historical technical packets are
not silently fabricated; completed candles are fetched and cached separately.

## Atomic authority switch performed by the operator

After all checks pass, a single controlled configuration transaction must retire the
old batch/GPT trading controls, set `leader20_control.active_strategy` to
`DETERMINISTIC_DYNAMIC_STATE_1`, set watch_limit=20, stamp the reviewed source commit
and increment `deterministic_control.generation`, then enable the new control and
restore the prior operator entry permission. Do not change sizing, hard stop or margin
policy. Record the old/new control manifest and commit before enabling admission.

`short_writer_enabled` retains the operator's existing setting. Both settings are
supported; enabling it is a separate PR #311 infrastructure decision. The generator
runs no account writer; in short mode the executor scans/warms features under analysis
and reacquires the writer for order/protection/settlement. No paid provider journal is
created. The new submit RPC and gateway authorizer require current BUY, capacity,
exact durable order identity and the current postmaster/owner/fence generation.

## Required post-cutover evidence

Use signed `ops-readiness` and actual source/config manifests to confirm ENGINE,
new generation, Top20 refresh, complete continuous trajectories, technical/volume/candle
state, candidate phases, and fresh pre-order state. Inspect the dependency closure
and SQL/trigger graph: provider imports, key reads, history authority, budgets and wait
states must be absent. Historical AI tables remain read-only history.

If no real BUY occurs, demonstrate authority wiring without sending a test trade.
When an organic trade occurs, inspect atomic reservation, stable order ID, gateway
writer envelope, final same-order IOC receipt, actual exchange position and native
stop acknowledgement; then inspect fills, attribution, fee accounting and reconciliation.
Track market-event/capture/feature/decision/validation/capacity/intent/send/ack/fill timing
and exit deterioration/state/decision/send/fill timing. A local dispatch timestamp is
not a socket-send measurement; only gateway-provided timestamps establish that leg.

Verify strong positions HOLD, protection never lowers, missing data preserves native
safety, strategic EXIT has a current thesis proof and UNKNOWN never creates a second
order. Production API call count = 0 requires runtime counters/logs after deployment;
static dependency checks on this branch do not prove that property on the old runtime.

## Recovery

Pause new deterministic entry, leave venue stops resident, reconcile exact existing
orders and positions, then repair the deterministic/data/execution path. There is no
GPT/DeepSeek fallback. Do not enable the retired AI authority, replay an old candidate,
release unresolved exposure from capacity, delete historical ledgers or force-close
healthy positions. Config/source rollback must preserve additive state and the new
submit/gateway proof contract; restoring an old AI executor is not an approved recovery.
