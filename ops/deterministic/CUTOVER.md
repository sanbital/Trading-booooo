# Deterministic engine release and operator cutover

Status observed 2026-10-03 05:32:48 UTC: own-intent dispatch repair DEPLOYED,
NEW ENTRY ADMISSION STILL PAUSED (`pause_new_entries=true`). Production executor
v192 is ACTIVE at source 5ccc46fa3ccc88aaeddb41602eb401efbc6f48c4; generator v53
was not redeployed and its complete bundle remains unchanged. Deterministic
control is enabled, generation 2, source 5ccc46fa3ccc88aaeddb41602eb401efbc6f48c4.
GPT remains OFF, the old batch authority disabled, one fenced five-second external
clock drives the deterministic engine, and management/reconciliation continue.
Native hard stop stays 2.5%, leverage 3, margin 150 USDT and max slots 10. No new
migration, sizing/mode/order-policy/scheduler/financial-row change was made in
this repair. Natural new exchange fills remain zero; real-fill proof is pending.
Authority and replay observations do not establish improved strategy returns.

PR #335 final head 51e29ca74e40352d0274cd5fc47f2b1bc5066dfc passed all CI, including
1526/1526 active complete regressions, deterministic/Leader20/entry/capture and
workflow lint. It fixes confirmed VELVET and SAND durable PLANNED intents which
were incorrectly classified as UNKNOWN by their own final account check. Both
old intents are REJECTED, notDispatched=true, without exchange order IDs/fills.
The temporary dispatch risk view requires an exact own unsent identity and full
immutable IOC payload match; every other uncertain order and portfolio issue
remains fail closed. Durable intent/reservation, submit proof, gateway fencing,
partial IOC settlement and native protection remain intact. Legacy Futures
routing validation was aligned to the already-deployed coherent depth quote;
behavioral quote tests continue to prohibit the drifting ticker/depth mixture.

Protected normal production repair-entry 37100047133 succeeded at 05:32:09 UTC.
It verified actual old v191/v53 bytes against immutable e966badf source, repeated
paused signed/data/authority gates, observed drained holders with flat account
truth, deployed only executor v192, compared complete downloaded bundles and
CAS-recorded the deployed source without unpausing or changing generation.
Executor: 32 files, digest
3e36217d18437e9cc752e616af5890cfa0acb5866a3a5417b68899f2339c9a7d.
Generator: 13 files, unchanged digest
3434c05e38911b7b8425a2a50faee19d70f2c542a4d25d4d714400931c898a66.
Normal CLI authentication temporarily failed at 05:09, recovered at 05:27 and
was used for normal workflow dispatch. No credential extraction, approval bypass
or competing entry authority was used. Paris gateway remains d68f80678c1a29de4fc993c014a58ca54007288b;
Tokyo clock remains 1bd5e3bf76bfb55f9df749818e325f91b5c6ab02.

Post-deploy signed proof passed at 05:31:58 UTC: venue/DB positions 0,
ordinary/protective orders 0, canonical/exchange fills 18 matched, balance
reconciled, ONE_WAY and no failures. Seven historical CLOSED floating-dust rows
remain terminal accounting records, not holdings. Final deployed-source resume
gates passed at 05:32:09 with all 20 candle/volume feature sets complete, 17 full
24-bucket trade contexts and a strict 24-bucket BTC sensor. EVAA/SYN were warming
and 龙虾 had an invalid/noncausal bucket; all three were DATA/REJECT. Missing or
invalid symbol data never borrowed another symbol's data. Current postmaster is
04:41:14.489719 UTC with completed fenced recovery; earlier restart causes remain
unproven. Pin these actual service versions/source in release-request.json, repeat
fresh verify-resume, then use normal trading-control resume. Observe natural
fills with runtime-proof, never with fabricated validation orders.

At 05:19 the continuous collector had 21 watched/synced trade/candle streams,
RSS 125394944 bytes, queue 42/1200 and current REST weight 0/100 local cap (2400
exchange cap). Rejected-row metrics are per ingest batch; the collector queues
closed candle rows while hot ingest admits micro rows. Technical/volume features
use completed REST candles independently. A 155s grid at 05:31 had no duplicate
or future rows; mature symbols retained 30-31 five-second buckets, while PIXEL
and 龙虾 showed rejoin gaps. Payloads contain no embedded symbol marker; isolation
is established by per-symbol worker state, stored symbol keys and bounded SQL
reads, not a claim of matching nonexistent payload markers. No gap was filled.

In runtime window 04:51:53-05:20:50 UTC, executor/generator had 1757/606 log rows,
zero provider/GPT dependency events and zero entry/exit provider ledger calls.
Executor v191: 146 requests, 0 errors, p50 8662ms/p95 13338.75ms. Generator v53:
301 requests, one HTTP 503, p50 1310ms/p95 2071ms. Later readiness passed; these
observations do not prove the earlier 503 cause or a five-second end-to-end SLA.
The deployed candidate's 34-file source closure has zero provider dependencies.
Fresh v192 trading/fill/latency observations are still required after resumption.

The following records describe earlier cutover observations and superseded
admission states; the current status above takes precedence.

Fresh signed account proof passed at 03:34:15 UTC (37093625505), and all current
read-only resume gates passed at 03:43:46 UTC (37094127813). The normal
trading-control workflow 37094198341 resumed admission at 03:44 UTC. Through the
subsequent repair pause there were no new fills or holdings; natural BUY seeds
were rejected by current pre-order revalidation. One signed AXS quote at
03:57:44 UTC proved a ticker/depth top mismatch; it does not prove that every
rejection had that cause.

Protected rolling quote repair 37096066787 succeeded at 04:18:52 UTC. Before
rollout its fresh signed proof showed 0 venue/DB positions, 0 ordinary/protective
orders, 18 matched attributed ACCOUNTED fills, ONE_WAY, matched balances and no
failures. Paris now runs d68f80678c1a29de4fc993c014a58ca54007288b; Tokyo remains
1bd5e3bf76bfb55f9df749818e325f91b5c6ab02. Both mandatory writer fences and the
original roles were observed after deployment. No Edge service, migration,
credential, scheduler flag, sizing or native-stop policy changed in this repair.
Use complete per-app reviewed gateway pins for subsequent signed reads and
resume gates: a missing/malformed pin must fail, never borrow the other app's
source. Subsequent signed gates must require these actually deployed sources.

Post-deployment signed proof and complete resume gates passed at 04:25:15 UTC
(37096431379), with 20 complete technical feature sets, 18 full 24-bucket trade
trajectories and a strict 24-bucket BTC sensor. CHZ/TAKE were warming up and
causally DATA/REJECT; their missing buckets never borrowed another symbol's data.
Signed quote observations 37096447872 had five healthy independent REST books
and zero ticker/depth top mismatches. CT's finite 100-level bid did not cover
25bp; no full-depth claim was made for it. The actual Paris/Tokyo source pins
remain d68f80678c1a29de4fc993c014a58ca54007288b and
1bd5e3bf76bfb55f9df749818e325f91b5c6ab02, respectively.

At 04:26:18 UTC, DB permission was observed resumed, generation 2, GPT OFF and
old batch disabled. Through 04:35:48, new orders/fills/holdings and unresolved
orders remained zero, nine new natural BUY seeds were observed, circuit was
closed and recent executor telemetry had no error. A YGG BUY at 04:27:17 was
followed by production WAIT/CONFIRMATION_NOT_READY at 04:27:23 before its rejection;
do not attribute every CURRENT_THESIS_INVALID to the repaired quote defect.
Read-only watcher 37096534089 observes actual natural fills from 04:25:53 UTC and
can report success only after quantity, native-stop acknowledgements, canonical
fills/fees/attribution/accounting, settled wallet and recovery proof pass. It
never creates a validation order. A no-fill deadline is incomplete fill proof,
not deployment failure or permission to change strategy thresholds.

Source closure remains the unchanged 33 service files at e966badf, with no
OpenAI/DeepSeek or GPT wait/budget/timeout dependency. In the bounded runtime log
window 03:44:11-04:21:30 UTC, executor/generator had 2021/794 function log rows and
zero provider or GPT dependency events; trading provider ledger calls since
staging were zero. Full regression for #331/#332 passed 1516/1517 active tests.
In that pre-repair/resume log window executor v191 had 140 requests, one error,
p50 8930ms/p95 43796ms/max 53734ms; generator v53 had 396 requests, no errors,
p50 1284ms/p95 2307ms. These are measured latencies, not a five-second cycle SLA.
At that earlier observation the postmaster was 03:20:19 UTC with completed recovery. Its earlier
abnormal interruption cause remains unproven; no platform restart/resource or
credential change was performed. Keep that risk and new-position runtime proof
explicit until fresh evidence resolves them.

Release evidence:
- Stage/migration/source parity: workflow 37079937802.
- Additive capture-admission repair 20261003001800: workflow 37082047264.
- All disabled-entry gates passed: workflow 37084637377.
- Fresh repeated gates and generation/CAS activation: workflow 37084755969.
- Signed post-activation read-only reconciliation: workflow 37084840875, 0 venue/DB
  positions, 0 ordinary/protective orders, 18 matched ACCOUNTED attributed fills,
  balance matched within 0.01 USDT, ONE_WAY observed, no failures. The old preflight
  success label contained a static CUTOVER_NOT_PERFORMED suffix; the observed
  active_strategy and authority transaction, not that label, establish cutover.
- A second signed postcheck passed at 01:12:01 UTC (workflow 37085151877).
- PostgreSQL restarted abnormally at 01:15:17.592669 UTC. Its logs report an
  interrupted database and automatic recovery. The immediate signed check
  (workflow 37085407001 attempt 1) failed only BALANCE_RECONCILIATION_UNPROVEN;
  holdings, orders and all 18 fills still matched. New admission was paused.
  The scheduler fenced the new postmaster and completed recovery at 01:16:31 UTC.
- Workflow 37085407001 attempt 2 passed at 01:19:55 UTC: balance reconciled, 0
  positions/ordinary/protective orders, 18 matched fills, ONE_WAY, no open account
  incident. This clears the immediate stale-balance gate but does not establish
  the cause of repeated platform interruptions. Keep new admission paused until
  fresh resume gates pass; do not manually reset circuits, restart the DB, or enable AI.
- Complete regression at PR #326: workflow 37083937248, 1503/1503, no skips/failures.
  The later PR #327 only batches/reorders read-only release observations; its
  deterministic and execution-parity CI passed without changing service sources.

At 01:11:43 UTC, all ten natural generation-2 BUY candidates had been rejected by
the executor's current pre-order thesis check (CURRENT_THESIS_INVALID). New orders
and holdings were still zero; no validation order was created. Resident protection
and HOLD/PROTECT/EXIT on a new filled position therefore remain covered by preserved
code/regressions rather than a newly observed live position cycle. Incident 148
resolved through three normal independent observations and remains resolved.

Observed limitations: intermittent management API 544/connection timeouts and a
retryable executor 503 occurred. The clock remained enabled and executor cycles
recovered; no forced restart or direct circuit reset was performed. The underlying
platform interruption cause is not established. After activation, through
01:13:00 UTC, executor v191 recorded 26 HTTP requests, one 503
(MANUAL_POSITION_ALLOWLIST timeout), p50 9766.5 ms and p95 22082 ms; generator v53
recorded 69 requests, no errors, p50 1487 ms and p95 2622.4 ms. The same window had
zero new OpenAI/DeepSeek calls and zero GPT wait/budget/timeout events. Full
executor cycles exceed the
nominal five-second clock, so five seconds describes schedule/capture cadence,
not a guarantee for a complete account/entry cycle. Preserve the seven terminal
accounted CLOSED dust rows; they are not holdings and may conservatively block a
candidate for the affected symbol. A flat account has no held-position margin-type
observation; no margin configuration was changed.

For platform diagnosis use `deterministic-platform-health.yml` on exact main,
through the production environment. It reads fixed management health/config/
metrics endpoints and grouped SQL counters. It never reveals API keys, reads host
files, executes machine commands or changes platform/account configuration.
Restart logs prove interruption, not OOM or a specific resource cause. If platform
evidence is unavailable, report that limit and leave entries paused. To resume,
first collect fresh signed account/order/fill/balance proof, verify the current
postmaster recovery fence and clock, source parity, data freshness and single
authority. Retain the unexplained interruption as a reported infrastructure risk:
entry requires completed recovery and complete current execution truth, and loses
authority again on a changed postmaster. Then use the normal trading-control
`resume_new_entries` action. Do not rerun the generation-2 activation transaction
or redeploy stage over an enabled control. Existing position safety remains on.

`verify-resume` is the read-only operation for an already active generation-2
engine with operator entry permission paused. It checks actual enabled control,
source SHA, strategy and readiness identity without rewriting them or running
activation. All original signed account, source parity, data/candle/BTC freshness,
single-clock, postmaster recovery, sizing/native-stop and no-provider gates remain.
Failure does not disable the position-management engine or clear the pause. A
successful verification itself never resumes permission, calls an executor cycle
or sends an order; use the existing conditional reconciliation/resume workflow.

The protected `deterministic-runtime-proof.yml` provides signed read-only quote
integrity observations and a bounded natural-fill watch. It cannot create an
order or change entry permission. Fill success requires an actual new attributed
deterministic BUY fill, matched venue quantities/trades/fees/accounting, settled
USDT wallet (not floating mark-price equity), exact native stop acknowledgements
including the unchanged hard floor, stable execution truth and postmaster recovery.
It records WAIT when no fill occurs and cannot report completion at its deadline.
Raw account/trade/stop/quote evidence is encrypted; summaries exclude balances.

`revalidation-evidence` adds a bounded read-only comparison of fresh signed books
and actual current 24-bucket capture using a recent same-minute BUY's saved candle
facts. Only proven bullish candle support is reused; minute changes, aged seeds
and incomplete data are unavailable. It reports which pure market gates change
when the executable book is overlaid. This is a current comparison, explicitly
not the historical executor's exact order trace, and never submit authorization.
It cannot change a signal, invoke a cycle or send an order. At most twelve
comparisons are collected in one one-to-ten-minute run through normal credentials.

Signed quote observation 37094913628 at 03:57:44 UTC found AXSUSDT
BID_TOP_MISMATCH: separate ticker and depth reads described different book tops.
The Binance-only repair takes executable bid/ask and liquidity from the same
depth snapshot, and does not promote absent depth through ticker fallback. Depth
limit, strategy, leverage/mode/sizing, native stop and writer fencing remain.
Deploy through the protected exact-main `deterministic-quote-repair.yml` with
entries paused, signed flat reconciliation and encrypted machine manifests. It
uses the repository's normal Fly rolling deployment, retains one 256MB/one-CPU
Paris machine, changes no credentials/flags, and leaves Tokyo's source and
scheduler roles intact. Pin the actually observed new Paris source before resume.

Readiness requests explicitly select the observed production clock region,
`ap-northeast-1`, and reject a different `x-sb-edge-region` response. On
2026-10-03 at 00:48:19 UTC, an unpinned GitHub runner diagnostic reached
`us-east-2` and reported all 20 candle features unavailable while adjacent
Tokyo production clock observations had no TECHNICAL rejections. This is an
ops request-routing correction, not an exemption from any candle/data gate;
there is no alternate-region retry or market-data fabrication. Actual regional
verification is still required through the protected manual cutover workflow.

The follow-up repair uses `deterministic-cutover.yml` on exact main with the normal
production environment. `stage` requires the observed flat signed baseline,
pauses/retire legacy admission, drains holders, applies only the exact migration,
deploys and verifies both complete bundles, and binds the existing two clock jobs
at five seconds while deterministic admission remains disabled. The operator
permission can then return to its previous value for unchanged V18 incident
recovery; it cannot grant BUY while deterministic control is disabled. `verify`
checks fresh signed account/fill/balance proof, source parity, all Top20 trade
context statuses and candle features, the existing BTC market sensor contract,
recovered scheduler and zero new provider calls. BTC's finite 1000-level snapshot
can cover less than 25bp. Its sensor requires 24 complete causal buckets and
reports only observed depth; it cannot substitute for a traded symbol's full
25bp context, including BTC if BTC enters Top20. The verifier pins the already
staged service SHA and versions separately from an ops-only release-runner SHA.
`activate` repeats those gates before one generation/CAS authority transaction.
Failure pauses new admission; no AI rollback or direct circuit reset is performed.

Top20 membership refreshes every minute while each trade trajectory requires
120 seconds. All 20 symbols must be observed with fresh complete candle features;
an unavailable or stale trajectory must produce SETUP=REJECT, decision=REJECT and
DATA in that same symbol's diagnostic. A missing status/reason, BUY/WAIT on invalid
data or a fully blind universe blocks activation. At least one genuine complete
trade trajectory must be observed. Healthy symbols never supply another symbol's
data. Every production BUY retains all 24 causal buckets, full 25bp trade depth
and immediate pre-order revalidation; no strategy threshold is changed here.

`repair-capture` installs only additive migration 20261003001800 while entry
authority remains disabled. The original ingest regex rejected QUSDT and Unicode
symbols that the collector and eligible universe accept. The repair replaces only
that regex, pins the exact before/after RPC definition hashes, and preserves grants,
all existing hot/archive rows and every causal bucket check. Previously discarded
history is not reconstructed; collect a new genuine 25-boundary trajectory before
the unchanged activation gates can pass.

Credential lookup failures return retryable 503 rather than permanent 401; actual
invalid callers remain 401. The executor preserves the scheduler's entry-free
`account-recovery` route. Candidate wake keeps its compatibility signature but
does not add a pg_net caller alongside the single fenced external clock.

The release changes trading decisions; it preserves leverage 3, slot margin
150 USDT, maximum 10 slots, native hard floor 2.5%, ONE_WAY verification,
quantity/tick/min-notional checks, two bounded IOC attempts, execution fencing,
original-order reconciliation, canonical fills and accounting. It never restores
LLM decisions on failure. Capture failure blocks that symbol's entry; incomplete
account/order truth blocks new exposure. Existing native protection remains live.

## Review and reproduce

1. Review the exact commit and migration against current main. The parent includes
   PR #311 account critical sections and final gateway fencing plus the external
   scheduler admission/restart fencing merged through PR #315/#317. Compare deployed
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
Use the current external scheduler catalog and `trading_scheduler_admit` fencing from
the merged mainline. Do not bypass admission by sending an unfenced duplicate clock;
the legacy allowance exists only for the audited cutover window. Back up the exact
active schedule through `EXTERNAL-CLOCK-CUTOVER.md`, drain accepted ticks, then switch
the generator/executor target bodies to the deterministic modes.

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
