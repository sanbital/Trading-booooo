# AI EXIT AUTHORITY v2 — release audit

Status: AI EXIT AUTHORITY v2: PRODUCTION DEPLOYED. PRODUCTION FUNCTIONAL, PROFITABILITY UNKNOWN.

Executor implementation commit: ee80b882f70dbce9ae16b5cac48e7f37acb2e531, PR #190. Final collector deployment: d44fb4dcb5617b40be70561b758f05a145d1e932, PR #191. Machine-readable verification: deployment-evidence/exit-authority-v2-release.json.

## A. Baseline frozen at 2026-09-26 14:09 UTC
- main: 69f60c7e55c2ede99cc24abe8f2ef6139d66e327 (PR #189).
- executor v100: 2240e56d1479f1b0af8f9da47fe7120766b073d8cd3e5b2db0fb866823292d87.
- signal generator v29: 7663e99429e532cb06fe2c161e74272dbb8568ee08f41c90e4c48a0a60fd1d1d (unchanged).
- migration: 20260926125702_continuous_capture_arbitration.
- LIVE_LIMITED, target slot margin 150 USDT, leverage 3, MAX_SLOTS 10; dynamic capacity unchanged.
- USUSDT was OPEN with native stop active at baseline. It closed naturally under v100 during implementation. No test trade or forced close was sent.

## B. Root cause
v100 persisted the maximum of catastrophic/R5 loss floors and P142/profit/trailing levels in hard_stop_price. manageLeader dispatched stop-based CLOSE before fd1HoldTick. The same mixed price ratcheted native STOP_MARKET, so an exchange fill could precede GPT HOLD.

## C. Explicit economic classification
The exhaustive active reason registry is supabase/functions/_shared/exit-authority.mjs: EXIT_REASONS. Unknown reasons cannot dispatch.

| Class | Existing reasons and aliases |
| --- | --- |
| HARD_SAFETY | NATIVE_HARD_STOP, V17_HARD_STOP, R5_RISK_CUT, V17_RISK_CUT, RISK_CUT; liquidation/account risk/reconciliation corruption/invalid state/exchange critical failure/operator emergency/account circuit; V21_POST_FILL_ENTRY_INPUT_INVALID; BULL_HARD_STOP; BULL_30D_SAFETY_DEADLINE |
| SOFT_PROTECTION | retestAnchor_TRAIL, retestAnchor_LOCK, rangeFloor_SUPPORT, pivotFloor_SUPPORT, P142_LOCK, TRAILING, PROFIT_LOCK, V17_TRAILING_STOP, V17_RATCHET_STOP, V17_PROFIT_LOCK, V17_COST_BREAKEVEN, V17_MOMENTUM_STALE, V17_MAX_HOLD, QV3_TWO_BEARISH_CLOSED, BULL_TRAIL_PROTECTION, BULL_T1, legacy regime-realization candidates, AI_PROTECT_LEVEL |
| AI_STRATEGIC | FD1_GPT_EXIT, requiring a fresh validated FINAL approval bound to position generation and journal job |

R5 is a genuine maximum-loss floor below entry (-1.2%), armed by the existing +1% excursion or 10-minute rule. It remains HARD with unchanged activation. P142/profit/trailing are economic profit protection, not catastrophic loss limits. Historical V17_NATIVE_STOP is an exchange receipt label that covered both classes in v100; v2 native order receipts carry explicit HARD_SAFETY provenance.

## D. Changes
- exit-authority.mjs: independent monotonic hard floor, explicit reason registry, soft evidence, generation-bound final permission.
- index.ts/manageLeader: immediate hard check before public candle/model work; existing P142/R5 calculators retained as evidence; all soft events route through fd1HoldTick. QV3 cannot bypass FINAL.
- index.ts/closePos: reject direct soft closes and stale/wrong-generation/non-FINAL strategic approvals; keep ownership, lease, pending-intent, partial-fill and exchange receipt handling.
- leader-native-protection.mjs: hard-only native orders. Replace only explicitly identified legacy profit orders after a hard replacement ACK; never retire a known HARD order by that mechanism. Ambiguous submissions/cancel races keep reconciliation.
- hold.mjs and gpt-final-decision-adapter.mjs: consumed soft crossings, new-evidence rearming, canonical parallel FIRST/DeepSeek → latest refresh → FINAL. Failure means retained hard protection plus bounded retry.
- PROTECT raises an internal soft level (never an exchange profit stop), doubles deterioration sensitivity and reevaluates in 30 seconds. No size/leverage/order increase. Rolling 30 reviews/hour retains the global production call/cost budget; it avoids a lifetime cap silently disabling review forever.
- trajectory.mjs: ordered observations plus 5/15/30/60/120-second price, flow, book and volatility dynamics. MFE/MAE are per-position; old positions explicitly label MAE since v2 attachment when earlier observations are unavailable.
- capture coverage recovery: reuse the same collector/ring. Refresh a previously sufficient finite depth snapshot when price leaves its trusted boundary; rate/weight limits remain. Intrinsically shallow books are not falsely marked complete.
- Extended live verification detected a recovery CPU defect: after snapshot age reached 60 seconds, the 200-ms recovery loop repeatedly sorted full books and calculated unused depth/impact. Fresh receipt timestamps concealed several minutes of WebSocket backlog; the RPC rejected those stale exchange times. PR #191 bounds recovery to one linear best-price scan per book per 5 seconds, rejects delayed stream events, and invalidates/reconnects old socket generations. Book/flow metrics also reject delayed event timestamps.
- A subsequent 16.6-second /proc/stat sample measured 91.74% CPU steal (1533/1671 ticks) on shared-1x. Shared CPU has a 6.25% sustained per-vCPU quota, explaining the failure after initial burst credit. The same machine is resized to shared-4x/1GB; no new collector, extra REST budget, or trading sizing change. Published preset prices are approximately $7.78/month versus $1.94/month, region-dependent: https://docs.fly.io/machines/cpu-performance/ and https://fly.io/pricing/.

## E. 120-second capture
Migration 20260926144820_exit_authority_120s_context adds service-only doa_gpt_capture_context_v3; v2 remains unchanged. Follow-up 20260926145639_exit_capture_flow_causality also requires aggregate-trade event and received timestamps to precede the bucket cutoff. All 24 buckets are required. Bucket labels are exactly 5 seconds apart; actual consecutive interval boundaries include scheduler jitter (about 120 seconds total). No gaps, future event/end/receipt times, stale trajectories or invented backfill are accepted. A valid optional 25th boundary supplies the first price delta; missing boundary returns unknown, not zero. OPEN priority 0 remains unchanged. Closed position-specific context is rejected; reentry gets a new position identity.

Initial production SQL smoke: 17/19 watched symbols AVAILABLE with 24 points, 120002 ms coverage, ~6.5 s age. QUSDT exposed an old snapshot-boundary defect, fixed in the same collector. BTC's 1000-level snapshot intrinsically covers only ~15 bp per side, so its 25 bp trajectory correctly remains unavailable. BTC candle/market facts remain separately available.

## F. AI authority
GPT FIRST and DeepSeek see the same frozen packet independently and in parallel. DeepSeek has no order authority. FINAL receives both opinions, ordered trajectory, latest refreshed facts and explicit hard/soft state. Missing/invalid advice is disclosed, not a veto. Only validated fresh FINAL EXIT can authorize a strategic close. HARD protection remains independent.

120-second schema evidence uses exact server-side catalog validation with a bounded wire schema to stay within OpenAI's 1000-enum limit. Full trajectory is retained. Duplicate serialized arbitration payloads were removed to preserve the production journal size budget.

## G. Historical regressions
Fixtures include source position IDs, actual exchange one-minute bars and retrieval URLs in test-support/exit-authority-v2/historical.json.
- JELLY: entry 0.0677364291; v100 native profit lock 0.06875 filled despite prior GPT HOLD. v2 scripted FINAL HOLD retains the position and separate hard floor; observed subsequent 60-minute high 0.07169 is evidence, not threshold calibration.
- PROM: profit protection preceded a lower subsequent price.
- FOLKS: prior HOLD followed by a hard-stop loss; hard protection still closes without AI.
- SYN and ARK: P142/trailing protected against substantial later downside. Tests exercise both scripted FINAL EXIT and FINAL HOLD followed by hard-floor breach.

These are authority and safety regressions. Scripted counterfactual model decisions do not demonstrate profitability or predict what a future model will decide.

## H. Tests
Local: 511 complete regression tests passed, followed by affected capture/arbitration tests; Deno check passed. Executor release CI run 36250295073: 513/513 PASS. Follow-up collector CI run 36251599817: 515 tests, 515 PASS, 0 FAIL, 0 skipped, including bounded recovery work and stale transport regressions. Entry evidence, sizing/BOO, workflow lint and stop-parity checks also passed. T01–T28 and INV-EXIT-01–10 PASS.

| Required tests | Validation |
| --- | --- |
| T01, T02, T03 | actual manager/close: hard immediate, liquidation authority without AI, corruption refuses guessed exposure |
| T04–T06 | actual P142/trailing/profit soft trigger, no direct CLOSE/native profit order |
| T07–T10 | HOLD consume/rearm; PROTECT; fresh EXIT; duplicate AI/order prevention |
| T11–T13 | real canonical dual API path with fixture providers, opposite opinions, mandatory FINAL and refresh |
| T14 | hard hit while arbitration remains pending |
| T15–T19 | real SQL execution and JS: 24 points, contiguous/future/stale/missing validation |
| T20–T22 | OPEN watch priority, CLOSED rejection, new position isolation |
| T23–T24 | JELLY and FOLKS historical regressions, plus PROM/SYN/ARK loss-protection counterexamples |
| T25–T26 | provider failure never invents soft EXIT; hard close remains immediate |
| T27 | existing partial fill, residual order, native/software race and reconciliation suites unchanged |
| T28 | HARD native lifecycle, no downgrade through soft retirement, ACK-before-cancel and failed replacement preservation |

INV-EXIT-01–10 are asserted in the authority, arbitration and existing durable order/native receipt suites. T02 tests the existing close safety interface, not a new liquidation predictor. Corrupt/unproven quantity enters reconciliation safety rather than placing an unowned close.

## I. Deployment
- Executor v101 ACTIVE, deployed 2026-09-26T15:00:28.419Z.
- Bundle SHA-256: c26a627220609477e6cdf9c0aeba14a14bd3cd85dd282e02c087c6c89e172642. All 63 downloaded source files exactly matched the validated release source.
- Signal generator remains v29 with the baseline hash. Sizing remains 150 USDT target margin, 3x leverage, MAX_SLOTS 10 and dynamic admission.
- Applied migrations: 20260926144820_exit_authority_120s_context and 20260926145639_exit_capture_flow_causality. The prior continuous-capture migration and v2 RPC remain present.
- Existing Fly machine 185030da006d48 updated in place, now shared-4x/1024MB to fix measured CPU scheduling starvation; secret references, REST budget and trading settings preserved. Final image registry.fly.io/sanbital-doa-capture-20260925:d44fb4dcb5617b40be70561b758f05a145d1e932, digest sha256:e16d79509fdf6d5ed67d3f94e984a633dda09bd4503f2d9b8c9d8b4c0bac757a. Final release workflow 36252542870 succeeded at 15:53:23Z. The prior shared-1x soak correctly failed and is superseded by this verified release.
- No OPEN positions immediately before deployment; no forced close or test trade. Existing hard protection was not removed.

## J. Production smoke
- Final post-capacity gate confirmed 20 consecutive QUSDT, SPELLUSDT and JELLYJELLYUSDT samples AVAILABLE with 24 points. At 15:54 UTC, 25/26 watched symbols were AVAILABLE, including all 10 current scanner leaders; BTC retained the documented incomplete-depth rejection. This supersedes the initial short smoke before CPU burst exhaustion.
- At 15:55 UTC, Q/SPELL/JELLY and the live HUMA position had 24 points, 119856 ms coverage (ordinary scheduler jitter), and newest-point age 4270 ms. Contiguous 5-second labels, event/book/flow receipt causality and freshness passed. Per-symbol SHA-256 hashes are recorded in the release evidence.
- Worker DOA-CAPTURE-5-BOUNDED-TRANSPORT: 26 watched, 26 synced, stream gaps 0, REST failures 0 after the capacity correction. All three capture flags true. Latest live_micro 15:55:05Z, heartbeat 15:55:08Z. Latest book receive lag was 123 ms. Post-capacity CPU steal measured 0.35% versus 91.74% before, with the same machine and explicit 4-vCPU/1024MB configuration verified.
- Actual order-free production JELLY probe: GPT FIRST PROTECT, DeepSeek PROTECT, GPT FINAL PROTECT. Q probe: GPT FIRST HOLD, DeepSeek PROTECT, GPT FINAL PROTECT. Each used three real API calls, identical first snapshot hashes and successful latest refresh, with AVAILABLE 24-point context in both initial and final inputs. DRYRUN journals cannot authorize production orders; orderCalls=0 in both probes.
- Models: gpt-5.4-mini-2026-03-17 and deepseek-flash. Both advice and final evidence validation succeeded. These probes demonstrate the real arbitration path, not live position execution.
- A third real order-free SPELL probe also passed with 24-point initial/final capture and no refresh error: FIRST HOLD, DeepSeek HOLD, FINAL PROTECT; orderCalls=0.
- The production system naturally opened HUMAUSDT at 15:41:29Z. At 15:55 it remained OPEN with AI_EXIT_AUTHORITY_2, a unique generation, priority-0 capture AVAILABLE and native HARD_SAFETY PROTECTED. The native hard floor tightened from 0.030157 to 0.030559 via the existing R5 rule; old protection was canceled only after replacement ACK. No position was forced closed.
- Live HUMA journals include validated parallel FIRST HOLD / DeepSeek HOLD / FINAL HOLD. Later unsupported evidence references were rejected to ABSTAIN; hard protection remained active and bounded reevaluation continued. Runtime live_enabled=true, circuit_open=false, last_error=null. This verifies an actual HOLD path but not a completed strategic EXIT lifecycle.

## K. Remaining unknown
Actual forward PnL, completed production HOLD→EXIT outcomes, tail impact and winner capture need new live lifecycle samples. A live HUMA HOLD path has been observed; unsupported model-evidence responses remain a reliability metric to quantify, and are safely rejected. Hard maximum-loss floors are unchanged; soft profit retention changes necessarily require forward research.
PRODUCTION FUNCTIONAL, PROFITABILITY UNKNOWN is the post-verification status, not a claim of improved returns.

