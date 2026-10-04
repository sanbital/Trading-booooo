## 2026-10-04 00:14 UTC — concurrent work confirmed, final repair not applied

The operator confirmed another task is also changing this repository and production. No migration, service deployment, source metadata update or resume has been performed by this repair task. Production mutation ownership must be coordinated before using the protected repair workflow.

Executor is now **v195**, bundle SHA256 `618ffbcc6a0d7b5c05c312aa83da8a1e5859f7436083174b045d6882f536afc0`; all34 normalized reachable files match `abf8d0b59054423f16a8401582be6af2f6faaf7b`. Its change adds independent read/intent timings; trading policy is unchanged. Current control metadata still points at prior v194 source `bdd47f4a8eb12b383ee72e4ec85bf957a7c7612b`, so ordinary resume proof must fail until actual service identity is attested. The reviewed repair admits that exact prior metadata only after proving current v195 bytes and signed account truth, then records current source while still paused. Old v194 is not a current deployment claim.

At00:10:49 UTC pause remained true, OP generation190 circuit remained open, and actual submit MD5 still `50bfd0b4738d9fc70e68f1758ee9f564` (NULL persistence bug). Proposed migration20261004000400 remains unapplied. Preserve entry pause until the coordinated production owner applies the reviewed repair, completes independent paused recovery and all resume gates. This is a blocked handoff state, not completed cutover or fill verification.

## 2026-10-04 00:05 UTC — current boundary integrated, repair still pending

Production changed during preparation: executor **v194** (bundle SHA256 `d9d96af7c877458ef571c496863e7c640ed7800428b470b01a1dd25472e495b1`) matches all 34 normalized reachable files of `bdd47f4a8eb12b383ee72e4ec85bf957a7c7612b`. Generator remains **v53**, pinned to `5ccc46fa3ccc88aaeddb41602eb401efbc6f48c4`. Paris gateway health reports `d3f9bffd00153af2fd9a5d9f4cc29f146a2b3f0c`, writer required, scheduler off; Tokyo remains the existing external clock. These concurrent changes were observed, not deployed by this repair runner.

Actual migration rows are `20261003234245` (boundary SHA256 `a7fec82055b01a1d0dbe8f85d72040a9af58dc2d4858804164ea00dfe9e0dcf8`) and `20261003235907` (terminal cleanup SHA256 `8a233f32a8e57e5413cf0d13696297936895b5af722bda83f040d4620d96f66c`). Repository filenames now match actual migration versions; SQL bytes are unchanged. Actual `deterministic_begin_submit` MD5 is `50bfd0b4738d9fc70e68f1758ee9f564` and still writes NULL || proof. The reviewed additive `20261004000400` repair preserves all its deadlines and gates, producing MD5 `ed49383c21644eba06dca0a2e04354d0`. It has **not been applied yet**.

Entries remain paused. OP incident `b28c890b-0191-49d9-a2aa-fe826cf6f708` generation190 remains open; its original order is REJECTED with signed never-placed evidence. Fresh DB shows zero OPEN positions and unresolved orders; this does not replace a new signed exchange reconciliation. `repair-submit-proof` now verifies the exact deployed v194/v53 bundles, gateway and applied migration hashes before DDL. It uses three independent signed observations across at least110 seconds while paused, then attests the already deployed source metadata and runs every resume gate. It performs no service deployment or venue mutation. Any concurrent version, postmaster or account truth change refuses. The superseded v192→v193 latency deploy must not be rerun over current v194.

The 23:47–00:01 log sample measured executor v193 p50 **4680ms**, p95 **5755ms**, max6882ms (n116, HTTP errors0); v194 initial sample p50 **4527ms**, p95/max5715ms (n13, errors0). These paused/flat samples cannot establish filled-order latency or profitability. Before resume require normal protected repair success, full bundle/market/account/capture/authority verification, then normal trading-control resume and natural fill observation. Never create a validation order.

# 2026-10-03 23:34 UTC: latency PR345 merged, submission proof defect reproduced, entries paused

PR345 merged a8e8a7a434c6f3fa034466f12ce00c8f92841477 with seven required CI
checks successful and local1556/1556 regression. Its executor source017c7f0012cd867a01658eee6192475d6cea64a1 is prepared but NOT deployed: production remains192/53,
control generation2 / source5ccc46fa. Normal pause run37161800932 succeeded.
The CLI briefly returned401 then normal workflow invocation recovered; this is
not evidence that the production deployment completed.

Natural OPUSDT intentad65e821-1ce1-482e-b8fc-615ebb3d8c7f at23:25:42 was refused
GW_503:WRITER_FENCED. The existing reconciler proved the same identity absent
(-2013), signed symbol quantity0, recent trades0 at23:26:17 and settled REJECTED,
exchange idnull, exposure-finaltrue. Incidentb28c890b-0191-49d9-a2aa-fe826cf6f708
generation190 remains held pending independent recovery. Do not unpause to clear it.

Actual production response_payload is nullable with NO default. The deployed
submission RPC used NULL||proof, acknowledged updated=true while storing NULL,
and gateway authorization returned NULL/false. The test schema had an incorrect
{} default and hid this defect. The production-shaped SQL regression reproduces
NULL!=true before the additive repair, then proves stored submission/gateway
approval afterward; every stale-state/capacity/generation/fence refusal remains.

Prepared migration20261003233500 changes only the exact submission function's
JSON concatenation to coalesce(response_payload,'{}'::jsonb)||proof; existing
proof/audit fields, grants and deadlines remain. It adds a restricted, fenced
paused-never-placed recovery RPC. That RPC admits only the same known incident,
terminal rejected original identity, no live/uncertain orders or holdings, no
pending closed protection, fresh complete signed zero-position/order/algo truth,
and current never-placed read. The existing50s independent interval, three
observations and110s elapsed gate remain. It never changes entry permission,
financial rows, native orders or AI authority. Other recovery protocols remain.

Normal protected repair-submit-proof / markerSUBMIT_NULL_PROOF_REPAIR_1 applies
the exact hashed migration and collects actual signed observations while entries
stay paused. A verified partially applied migration can resume observation after
a fresh gate; it cannot be reapplied or replaced by a guessed function. Failure
keeps management authority and paused entries. After incident resolution, use
normal repair-latency / EXECUTOR_LATENCY_REPAIR_1, full verify-resume, and separate
normal resume. Compare runtime latency and observe only natural fills.

23:26 capture: BTC strict24 available; Top20 17/20 strict24 available. COLLECTUSDT,
IOUSDT and MEGAUSDT incomplete trajectories fail closed. Collector98f272cc,
DOA-CAPTURE-10-BOOK-INTEGRITY: watched/synced/queue21, heartbeat fresh. No new fill
or post-repair protection/accounting/latency proof has yet been established.

# 2026-10-03 23:08 UTC: executor latency repair prepared, not yet deployed

Fresh read-only preflight run37160771205 / job111313557566 passed at23:08:26Z:
Binance and DB positions0, ordinary/protective orders0, wallet reconciled,
unresolved DB orders/incidents0, new fills since14:22:46 zero. The observed
postmaster is now20:35:31.660523Z; the earlier12:16 restart observation is historical.
Authority is still deterministic generation2 / source5ccc46fa, entries unpaused.
22:55..23:08 executorv192 n73 p50 7933ms / p95 12928ms / max15180ms,
HTTPerrors1; generatorv53 n137 p50 1167ms / p95 1870ms / max3071ms, errors0.

The reviewed latency repair removes idle recovery writers, overlaps independent
signed-account/DB reads without caching, and skips intermediate account reads
only when no management/reconciliation work or new incident write ran. Position management stays
first; final signed account evidence, final BUY revalidation, capacity, writer
fencing, receipts, accounting and native protection remain required. Stage
telemetry records durations without credentials or account payloads.

Immutable service source017c7f0012cd867a01658eee6192475d6cea64a1 has exactly
one changed file relative to5ccc46fa: executor/index.ts. Production deployment
must archive this source, not current main dependencies. No entry-rescue strategy
change, generator, gateway, collector, scheduler or migration belongs to this
repair. The release checks its parent, exact file diff and matching runner bytes.

Normal protected cutover operation: repair-latency with marker
EXECUTOR_LATENCY_REPAIR_1. Only baseline executor192/generator53 is admitted.
Pause entries, pass full signed/market/source gates, drain holders, deploy only
the immutable executor, prove actual downloaded bundle parity at193/53,
reconcile again, CAS only source metadata at generation2, and run full gates
again. Each service keeps its own exact immutable source. Any failure leaves
entries paused and preserves position management. Normal resume is separate.
A changed holding stops this flat repair; do not close it or replace its stops.
After success, compare bounded runtime/stage logs and observe only natural fills.

# 2026-10-03 14:32 UTC: resumed, executor latency remains, no real fill proof

Operator-confirmed database restart: postmaster 12:16:55.400305Z. This task
performed no DB restart, compute change or new migration. Existing migrations
20261002102500 / 20261002123820 / 20261003001800 remain installed.

Paris gateway writer HTTP fix PR342 is live at
31ab91abf0c30403303942373c73fadff2eb0265; PR343 pins that observed source.
Tokyo remains 1bd5e3bf76bfb55f9df749818e325f91b5c6ab02 with the single external
clock. Actual bundle parity at 14:21 confirms executor v192 / generator v53
against 5ccc46fa3ccc88aaeddb41602eb401efbc6f48c4. External main entry-rescue
code was NOT deployed to those functions. Collector remains 98f272cc / ingest v10.

First post-rollout resume checks failed at 14:14 (RELEASE_DB_HTTP_544 and
PREFLIGHT_READ_FAILED); entries stayed paused. DB small-query safety and
platform health recovered with the SAME postmaster. Fresh signed preflight
37129186269 and full resume gate 37129262172 passed sequentially, including
BTC24, 20 technical features, per-symbol data fail-closed and provider calls0.
Normal resume 37129368783 confirmed pause_new_entries=false at 14:22:46.383.
Authority remains deterministic enabled / generation2, GPT OFF and batch OFF.

14:22:46..14:28 request logs: executor v192 n12, p50 15905ms / p95 and max
36282ms; generator v53 n57, p50 1352ms / p95 2513ms / max 2645ms. HTTP errors0.
These are bounded request samples, not order send/fill latency or a 5s SLA.
432 runtime/Edge records show provider/GPT wait-budget-timeout mentions0,
old WRITER_CONTEXT_REQUIRED0 and execution errors0. Production source closure
34 files has provider dependency/invocation matches0; ENTRY/EXIT ledger0.
The gateway fix does NOT resolve the executor's repeated account reads and
writer sections. Per-operation attribution of the remaining runtime is still absent.

14:28 DB snapshot: positions0 / unresolved orders0 / incidents0 / reservations0.
12 post-resume BUY candidates: rejected CURRENT_THESIS_INVALID10,
LATEST_PRICE_OR_MARGIN_INVALID1, NEW1. Two durable entry intents were rejected
for those two gates respectively, both notDispatched=true / no venue identity.
Collector watched/synced21, BTC24, 17/20 trade captures AVAILABLE24;
EVAA/TAKE/YFI INCOMPLETE_TRAJECTORY stay fail-closed. This is a timestamped
snapshot; the universe and capture readiness continue to change.

Natural fill observer 37129370401 made no orders, observed ten times and ended
14:28:06.488 REAL_FILL_NOT_VERIFIED_WITHIN_WINDOW. New fills0; new native-stop
ACK, HOLD/PROTECT/EXIT receipts and post-fill attribution/accounting remain
UNVERIFIED. No validation trade, forced close, duplicate stop or AI fallback.
Final signed account proof 37129933151 at 14:32:15.670: venue/DB flat,
ordinary/algo orders0, trades0 in the documented scope, wallet matched,
ONE_WAY and no circuit. Entry authority is resumed; this is not a claim of
completed real-fill verification or solved executor latency. Preserve all
financial parameters, IOC and native -2.5% stop. Management HTTP544 cause
remains unproven; recurrence requires fresh truth and failed gates stay closed.

# 2026-10-03 14:07 UTC: writer HTTP repair deployed, entries paused

PR342 merged as 31ab91abf0c30403303942373c73fadff2eb0265.
Protected production workflow 37128457227 succeeded: signed Binance/DB
flat account and wallet reconciliation at 14:06:25.848; zero ordinary/algo
orders and no unresolved execution incident. Encrypted manifest confirms one
existing machine / compute unchanged. At 14:07:21 Paris reports that exact
source, mandatory writer=true, external scheduler=false and scheduler=false.
Public build is 2026-10-03-writer-http-boundary-1 with writer_http_fencing=true.
Tokyo remains 1bd5e3bf76bfb55f9df749818e325f91b5c6ab02, mandatory writer=true,
external scheduler=true. No credential staging, migration, executor/generator,
collector, scheduler authority, strategy or financial-policy rollout occurred.

CI on head 498fdea6304d216ffb9e4049bcf3eac52a6a4260: 1544/1544 complete
regression, verify, v714, entry evidence, validate and workflow lint passed.
Gateway suite 122/122 and new HTTP regression 3/3 passed locally; all three
HTTP regressions fail with WRITER_CONTEXT_REQUIRED on the original route.

The reviewed per-app release pin now records Paris's observed deployment,
retaining the independent Tokyo pin and staged engine source 5ccc46fa.
Entries remain paused. Fresh post-rollout resume gates and any natural real
fill are still pending at this timestamp. The original ~10s executor median
latency is NOT fixed by connecting HTTP writer fencing. DB restart was performed
by the operator, as confirmed in the conversation.

# 2026-10-03 13:56 UTC: executor latency / writer HTTP repair pending

The operator confirms they restarted the database; postmaster remains
2026-10-03T12:16:55.400305Z. This task did not restart the DB.

13:28..13:40 UTC production executor v192: 50 Edge request records,
p50 10071ms / p95 16622ms / max 19272ms, one HTTP error. Generator v53:
122 records, p50 1316ms / p95 2186ms / max 3406ms, one HTTP error.
Scheduler DB ticks independently show executor admission p50 328ms;
51 successful executions p50 9879.923ms / p95 15815.947ms.
Single-flight prevents overlap and skips old ticks; 5s is the configured
schedule period, not observed end-to-end executor latency.

Invocation 964803f7-b32e-41a8-bc9e-5f3756e094ab lasted 10297ms and
contained five ACCOUNT_WRITER sections totaling 3150ms. Code preserves four
serial account-pair observations even on the flat path. Existing telemetry
cannot apportion the remaining time exactly among DB, gateway and venue;
REST observations are sampled and not an invocation trace. DB at 13:43 was
ACTIVE_HEALTHY, no deadlocks or observed lock waits; this does not prove
all DB/REST latency is absent. Trading provider ledger in this window: 0.

A natural SUPERUSDT entry at 13:31 produced order
8cd23207-67c1-47bb-95f3-3f45f51aa528. The gateway refused it with
WRITER_CONTEXT_REQUIRED. Existing reconciliation established never placed;
final order state REJECTED / ORDER_NEVER_PLACED, venue identity absent.
At 13:48 the DB was flat with no unresolved order or incident and no new fill.

The root cause is the gateway HTTP command handler calling handleCommand
without orderWriterFence.run. The signed Binance mutation boundary therefore
has no writer AsyncLocalStorage context even for a valid writer envelope.
The repair connects the existing fence; it does not relax authorizations,
financial parameters, IOC, native stop, strategy or scheduler authority.
Local HTTP regression reproduces the original error using fixture-only DB
and venue transports. No production validation trade is manufactured.

Normal pause workflow 37127538769 and signed account preflight
37127541013 succeeded. Entries are paused for this repair. The existing
protected deterministic gateway repair workflow accepts an explicit
writer_http_boundary / WRITER_HTTP_BOUNDARY_REPAIR_1 operation, retaining its
paused-flat signed truth, encrypted manifest and source/role gates. The Tokyo
clock, executor v192, generator v53 and collector 98f272c remain independent.
Deployment, resume and real-fill verification are still pending at this timestamp.

# Deterministic engine release and operator cutover

Status observed 2026-10-03 13:03:45 UTC: COLLECTOR INTEGRITY REPAIR DEPLOYED,
DETERMINISTIC ENTRY ADMISSION RESUMED, NEW REAL FILL UNVERIFIED.
PR #340 head 1c86763f808432ad082142788fcb7c33b991d824 passed all CI, including
1535/1535 active complete regressions and workflow lint. Merge/source
98f272cc6583ffba82ee7db58a8ed39e3d38f38b is the actual collector image source.
Protected normal workflow 37123681911 replaced only existing collector machine
185030da006d48, preserving its shared-4/1024MB guest, restart policy, opaque
configuration and protocol. No migration, gateway/executor deployment, order or
authority mutation occurred in that repair. It observed three consecutive
strict BTC 24-bucket sensor proofs and finished at 12:46:02 with entries paused.

Full normal verify-resume 37123972941 passed at 12:47:39: signed venue/DB holdings
and ordinary/protective orders zero, wallet matched, no unresolved orders or
incidents, current-postmaster recovery and single five-second scheduler authority
ready. All 20 technical feature sets were ready; every unavailable symbol stayed
DATA/REJECT. Actual downloaded executor v192/generator v53 bundles matched source
5ccc46fa3ccc88aaeddb41602eb401efbc6f48c4. Their previously verified digests remain
3e36217d18437e9cc752e616af5890cfa0acb5866a3a5417b68899f2339c9a7d and
3434c05e38911b7b8425a2a50faee19d70f2c542a4d25d4d714400931c898a66 respectively.
Normal control 37124119949 applied pause_new_entries=false at 12:49:37.285.
Deterministic generation remains 2/enabled, GPT OFF and old batch authority OFF.
Leverage 3, margin 150 USDT, ten slots, IOC policy and 2.5% native stop are preserved.

The five-minute natural-fill observer 37124121817 completed at 12:55:00 with
REAL_FILL_NOT_VERIFIED_WITHIN_WINDOW (exit 3), not successful fill proof. At
13:00:21, 16 real deterministic BUY candidates had been created after resume:
15 were REJECTED/CURRENT_THESIS_INVALID and one was rejected by ownership/universe
validation. Exactly one durable ZRO intent (3ec0c40c-d9d5-4aed-ba72-55d0d27fea4a)
reached final dispatch authority and was REJECTED at 12:52:46 with
notDispatched=true and no exchange order ID. Active reservations, unresolved
orders/incidents and new fills were zero. Its seed-decision to final refusal
elapsed 11657ms; this is refusal latency, not send/ack/fill latency.

Read-only comparison 37124506136 observed five new BUY seeds with same-minute
saved candle facts, actual current capture and signed book. Each current capture
and data/technical/execution gate passed, while current trigger/confirmation was
WAIT; all comparisons refused CURRENT_THESIS_INVALID. Candidate ages were
4625..13250ms. These independent comparisons are explicitly NOT executor traces
and do not prove each earlier refusal's exact subgate or a causal latency fix.
Do not weaken strategy/confirmation or manufacture an order to obtain a fill.

Final signed account preflight 37124574474 passed at 12:57:58: zero venue/DB
holdings and ordinary/protective orders, matched wallet, no failures. Its 24h
DB-known symbol/current-holding scope had zero canonical/exchange fills. Historical
closed float dust remains preserved; other-symbol manual closed history is not
proven. New-position HOLD/PROTECT/EXIT, native stop acknowledgement and new-fill
attribution/accounting still require a natural new fill and are unverified.

At 13:03:45 the collector reported version DOA-CAPTURE-10-BOOK-INTEGRITY/source
98f272cc, 21 watched/synced/trade streams, 19 observed candle streams, queue
21/1200, RSS 122802176 bytes, REST weight 44/100, no archive degradation and
zero rejected rows in the last ingest batch. BTC's strict sensor was AVAILABLE/24.
Top20 had 16 AVAILABLE/24 contexts; JST/AR/Q/STX were INCOMPLETE_TRAJECTORY and
remain ineligible. Per-batch ingest rejection counts do not prove bucket validity.
The latest Top20 epoch was observed at 13:03:16, next refresh 13:04:16. Legacy
clock_capture_enabled=false coexists with the deterministic continuous collector;
it does not disable continuous capture or authorize a legacy entry loop.

Live logs 12:49:37..12:57:00 include both function_logs and function_edge_logs:
executor v192 414 events and generator v53 232, total 646, with zero provider,
GPT wait/budget/timeout, writer-context or analysis-release errors. Request metrics:
executor 27/0 HTTP errors, p50 11781ms, p95 31699ms, max 43977ms; generator 80/0,
p50 1368ms, p95 2105ms, max 2836ms. The provider dependency search across 34 actual
service source files found zero invocation/dependency hits; the ENTRY/EXIT ledger
since 2026-10-02 23:58:25 also remained zero through 13:00:21. Five-second schedule
cadence is not end-to-end latency. Latency remains a risk, not a proven sole cause
of the market thesis refusals or evidence of improved returns.

Platform health 37124576024 at 12:58 confirmed all four services healthy, SQL
1716ms, load1 1.01, available memory 839626752/2025488384 bytes and OOM counter 0.
Postmaster remains 12:16:55.400305; restart actor/root cause is unproven and this
task did not restart or resize PostgreSQL. Preserve normal pause, native protection
and reconciliation if execution truth degrades; rerun fresh signed/current-postmaster
and per-symbol data gates before resuming. Prior sections below are historical.

Status observed 2026-10-03 12:27 UTC: DB/REST RECOVERED, ENTRIES PAUSED,
BTC SENSOR RESUME GATE FAILED. PostgreSQL's current postmaster started at
12:16:55.400305; this task did not restart it. Tokyo leadership and current
postmaster recovery are healthy. Normal pause 37122694754 succeeded with
pause_new_entries=true. Signed preflight 37122697007 and verify-resume account
proof 37122749433 found zero venue/DB holdings, ordinary/protective orders,
unresolved orders and incident failures; balance matched. The 24h DB-known
symbol history has zero canonical/exchange fills, so this proves no new fill.

Verify-resume 37122749433 failed BTC_MARKET_SENSOR_NOT_READY. All 20 technical
feature sets were ready; 17 trade symbols had 24 valid buckets and three
incomplete symbols remained DATA/REJECT. BTC's latest 25 buckets all had
book_complete=false. The latest payload reports CROSSED_OR_EMPTY even though
the worker reports SYNCED; its last BTC snapshot is still the initial snapshot
from 2026-10-02 23:47. This is a separate collector book-integrity recovery
failure after DB recovery, not evidence that the database outage was fixed by
the collector repair.

The reviewed repair invalidates only a crossed/empty book and uses existing
bounded symbol single-flight snapshot/sequence recovery. It preserves market
flow, other symbols and bucket clocks; a broken/recovery interval stays invalid.
No capture/depth/freshness/strategy thresholds change. The new exact-main
production workflow replaces only the existing collector image under its
machine lease/current_version guard, preserving opaque configuration and
requiring paused flat reconciliation/current-postmaster recovery. It requires
three consecutive strict BTC 24-bucket sensor proofs after replacement. This
section describes prepared code; production replacement has not yet happened.

If the collector repair fails, keep entries paused and retain its artifact's
exact before/after image and machine identity. Restore only its recorded prior
image through the normal Fly administrative deployment path, preserving config;
the old image retains the known integrity defect and is not a resume gate pass.
Re-run signed account proof, service parity and verify-resume before admitting
entries. Never replay outage ticks, fabricate buckets/orders, reset circuits or
restore AI authority. DB restart actor/root cause remains unproven.

Status observed 2026-10-03 11:01:54 UTC: PRODUCTION DATABASE/REST UNAVAILABLE.
Independent platform workflow 37118244156 observed db/db_postgres_user/rest
UNHEALTHY, metrics HTTP 500 and a 15002ms SQL timeout. Two management SQL reads,
including a minimal runtime read, timed out. Tokyo's process heartbeat continued
at 11:01, but its last DB clock heartbeat was 10:07:28 and leadership was false
with DEPENDENCY_UNAVAILABLE. Generator/executor logs stop around 10:08. This is
an infrastructure block before current entry classification; the earlier
NO_DETERMINISTIC_BUY observation does not describe this outage.

Normal pause workflow 37118239081 reported HTTP/workflow success, but its
endpoint returned DB_DEGRADED and LOAD_SETTINGS_DB:Signal timed out. The pause
was not confirmed. Trading-control now rejects that envelope and requires the
requested pause permission in the returned settings. Signed preflight
37118241681 failed before any venue read, so current positions, protective
orders, fills and DB reconciliation must not be inferred from the earlier flat
account. The reviewed venue-evidence operation reads portfolio/open orders/mode
through the existing signed gateway without a DB read, emits encrypted raw
evidence and a non-secret summary, and grants no entry authority. It does not
substitute venue-only proof for DB reconciliation or restart/restore the DB.
Do not resume entries while execution truth or postmaster recovery is unproven.
Preserve native exchange protection and existing financial history; no duplicate
stop/close, forced liquidation, provider fallback or key extraction is allowed.

The following status is the last verified healthy cutover before that outage.

Status observed 2026-10-03 06:09:48 UTC: own-intent dispatch repair DEPLOYED,
NEW ENTRY ADMISSION RESUMED (`pause_new_entries=false`). Normal trading-control
37100422079 resumed admission after fresh signed verify-resume 37100318954
passed at 05:36:18 UTC; DB permission was observed resumed at 05:38:15 UTC. Production executor
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
unproven. PR #336 pins the actual v192/v53 source and versions; main
24bc3499b26b6ec8f850241df5d1cddbedeee284 passed the subsequent fresh resume gates.
At 05:36:15, all 20 technical feature sets were complete, 19 trade contexts and
the BTC sensor had 24 buckets, and warming RESOLV was DATA/REJECT. Read-only
watcher 37100456120 observes natural new fills from 05:37:01 UTC for a bounded
30-minute window. No new exchange fill has been proved yet; native stop, fill
attribution and settled-wallet proof for a new position therefore remain pending.
Do not submit a fabricated validation order to complete the report.

The resumed 30-minute natural-fill watcher 37100456120 completed at 06:08:49 UTC
with REAL_FILL_NOT_VERIFIED_WITHIN_WINDOW and exit code 3: no new fill was
available. This is incomplete real-fill proof, not a successful live-fill test.
At 06:08:36 admission remained resumed, circuit/incidents/unresolved orders and
open positions were zero, the last cycle completed at 06:08:32, and the entry
reason was NO_DETERMINISTIC_BUY. The same window exercised zero order commands
in the observer. New-position HOLD/PROTECT/EXIT, native stop acknowledgements and
new-fill attribution/accounting remain unverified without an actual position.
Normal read-only signed account workflow 37101746660 passed at 06:02:46:
venue/DB positions and ordinary/protective orders zero, 18 canonical/exchange
fills matched including fees/attribution/accounting, balance reconciled, ONE_WAY,
no failures. Its scope is DB-known symbols/current holdings and the last 24h;
other-symbol manual closed history and a held-position margin mode are unproven.

The final 05:37:01-06:08:05 UTC provider search included both function_logs and
function_edge_logs: executor v192 had 1962 rows and generator v53 967, with zero
OpenAI/DeepSeek and GPT wait/budget/timeout events; the trading provider ledger
also remained zero. Actual request measurements: executor 136/0 HTTP errors,
p50 9283ms, p95 19459.75ms, max 51312ms; generator 328/1 HTTP error, p50 1287ms,
p95 1876.95ms, max 3920ms. All request status fields were present. Five-second
scheduler cadence is still not an end-to-end latency SLA.

At 06:08:36, 16/20 current symbols had complete 24-bucket capture. ATH had an
invalid/noncausal bucket; PHAROS/IMX/Q had incomplete trajectories. BTC's sensor
was AVAILABLE with 24 buckets and its finite-depth/no-extrapolation contract.
At 06:09:48, mature current symbols retained 31 five-second rows without gaps;
PHAROS had a gap and incomplete book rows, IMX/Q had recently started rows and
incomplete book rows, and returning EVAA had only 19 recent rows. Recent epoch
membership confirms churn; these observations do not establish the cause of
every incomplete bucket or make every current symbol trade-ready. At 06:01:26
the collector had 21 watched/synced streams, queue 21/1200, REST weight 22/100,
zero last-batch rejects and no degraded archive. Its symbol-specific fail-closed
gates remain required. No missing interval or absent depth was synthesized.

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
After resumption, the exact v192 dispatch path persisted NIGHT intent
650cbdcb-0c5b-47b8-bec6-acbcd4d9bf94 and passed the scoped own-intent/fresh risk
checks. Latest market validation then refused CURRENT_THESIS_INVALID, with
notDispatched=true and no venue order ID. This is actual runtime wiring evidence,
not an exchange fill. Signed quote observation 37100477387 had six healthy
independent REST snapshots with book ages 53-59ms; CT's finite 100 levels did not
cover 25bp, and no depth extrapolation was used. Top20 storage at 05:44:26 had 20
unique symbols ranked by descending 24h change. Of 1523 live entry-state audits,
none granted BUY/WAIT with incomplete data or technical features.

In the post-resume 05:37:01-05:43:06 UTC log window, actual executor v192/generator
v53 had 327/119 log rows, zero OpenAI/DeepSeek/provider or GPT wait/budget/timeout
events and zero trading provider ledger calls. Their deployed 34-file source
closure also contains no provider dependency. Executor: 18 requests/0 HTTP
errors, p50 10240ms/p95 46830.8ms/max 51312ms. Generator: 61 requests/1 HTTP
error, p50 1334ms/p95 1878ms. These bounded measurements do not establish a
five-second end-to-end SLA. At 05:49:27 SQL showed 14/90 DB connections, no temp
bytes or deadlocks; live micro storage was 5128192 bytes with recent autovacuum.
Database interruption and transient 503 causes remain unproven. Native safety,
reconciliation and strict stale-data/execution fences must remain active.

Recovery uses normal trading-control pause_new_entries with PAUSE_NOW, preserving
deterministic management/reconciliation and existing native protection. Reconcile
any uncertain order by its exact durable identity before admitting more exposure;
never duplicate a stop/close, force-close for cutover, restore AI authority or
roll accounting proof backward.

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
