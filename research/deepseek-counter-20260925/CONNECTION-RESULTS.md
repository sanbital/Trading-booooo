# DeepSeek connection and provider replay — 2026-09-25

The registered `deepseek api` secret now authenticates successfully inside Supabase.
Both official model IDs were verified against the live models endpoint. No key value
was read out, copied to a local file, or written to logs.

## Release decision

Scope: this report records the c2fd61e-era research deployment, not the later v89 HOLD observer release. The external review and current prerequisites are recorded in [EXTERNAL-REVIEW.md](EXTERNAL-REVIEW.md).

**Connection and research deployment complete; trading authority remains ungranted.**
This is not a completed production trading integration or an OOS improvement claim.

122 exact saved packets (76 ENTRY, 27 RECHECK, 19 HOLD) were sent concurrently to
GPT, Flash non-thinking, and Pro thinking/low, under the existing 8s ENTRY/HOLD
and 4s RECHECK request caps. The input includes no later outcomes.
The 27 earlier diagnostic packets are separate and must not be pooled with the
final prompt revision. Structured-output instructions were tightened after those
diagnostics; validation remains fail-closed.

| Provider | Valid / attempted | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|
| GPT | 113 / 122 | 1610 | 2206 | 4002 |
| DeepSeek Flash | 120 / 122 | 1073 | 1393 | 1457 |
| DeepSeek Pro, thinking/low | 0 / 122 | 8001 | 8009 | 8010 |

Flash failed one extra-field and one enum validation. Pro timed out on every
packet, including the shorter RECHECK caps. Pro latency is censored at the deadline,
not a measurement of its full completion time. The default high-effort diagnostic
also timed out on all 27 attempts. Model response validity is not decision accuracy.

## RECHECK descriptive comparison

25 of 27 saved RECHECK packets joined to non-null tracker outcomes by exact
`final_job_key`; missing outcomes were excluded. For illustration only, the
600-USDT tracker proxy was linearly scaled to 450 USDT. This is not realized
trading PnL: it omits fills, portfolio capacity and execution latency and retains
the tracker's fixed-stop/60-minute assumptions.

| Policy | Accepted observations | Proxy net USDT | Win rate |
|---|---:|---:|---:|
| Historical GPT BUY | 4 | -31.1830 | 0% |
| Replayed GPT BUY | 4 | -31.1830 | 0% |
| BUY only with Flash SUPPORT | 1 | -11.7000 | 0% |
| Rescue GPT SKIP with Flash SUPPORT | 4 | -31.1830 | 0% |
| Veto GPT BUY with Flash OPPOSE | 4 | -31.1830 | 0% |

The support-only variant removes three losing proxy observations but still
supports the losing ONDO entry. This small, inspected sample cannot establish
OOS profitability or winner preservation. Flash also opposes XAI and SAGA
snapshots whose later tracker outcomes were strongly positive. Thus this run
does not establish the requested false-SKIP correction.

TRAIN, VALIDATION and TEST metrics remain **unavailable**. Historical outcomes
were already inspected before this continuation, no untouched chronological
holdout or calibrated A-G policy was fitted/evaluated, and ENTRY/HOLD complete
outcome reconstruction has not been completed. No arbitrary confidence or
weight rule was introduced. No surface has earned execution authority.

## Implementation and verification

- `deepseek-connection-check`: authenticated fixed-destination model discovery.
- `deepseek-counter-replay`: authenticated, bounded batches of saved packets;
  no order client, cron schedule, or trading-state mutation.
- Both reuse the existing private FD1 replay token and reject unauthenticated
  requests. Replay returned HTTP 401 without it. No new public data access.
- Provider errors now expose fixed schema-error categories only; no raw errors,
  secrets or chain-of-thought are retained.
- Existing Node regression: 762 passed after restoring Git history access in the
  isolated copy; added provider tests: 9 passed; operational harness: 71 passed.
- Deno regression: 1055 passed after restoring missing static fixture files;
  new endpoint typechecks passed. Early sandbox/process and missing-fixture
  failures were resolved, and the affected tests were rerun successfully.
- No migration. Trading executor was not changed or redeployed.

First final-revision live-network **historical replay**, epoch milliseconds:
GPT start/end 1790322998188 / 1790322999953; Flash start/end
1790322998190 / 1790322999143. Starts differ by 2ms and overlap.
Three-provider wall time 8005ms includes the Pro timeout. This is not a live
trading decision; orderCalls=0. There is no first production trading order.

Detailed outputs: `live-provider-replay.json`, `connection-validation.json`,
`recheck-descriptive.json`. Timeout/invalid-response usage is incomplete, so
total provider billing and net-after-AI-cost improvement are not claimed.

Remaining: untouched chronological OOS selection/calibration, ENTRY and HOLD
exit-path evaluation, validated task-specific fusion, audit migration and executor
integration if evidence supports them, and deployment/order-linkage/exchange
reconciliation. Credential absence is no longer the blocker.

## External-review correction: baseline deadline ownership

Confirmed defect in the research helper: parallelReview used Promise.allSettled and evaluated freshness after both providers finished. With a real advancing clock, immediate GPT BUY and a 200ms counter timeout produced ABSTAIN/COUNTER_STALE at 202ms. Earlier fixed-clock tests masked the defect. The 122-provider replay directly calls the providers rather than this helper, so this bug does not retroactively change that saved dataset. The later production HOLD observer also does not call this helper.

The patch separates startParallelReview.baseline and .counter, makes parallelReview return on GPT completion, and confines joint waiting to collectParallelReview for offline diagnostics. Freshness uses the locally observed GPT completion plus its reported timestamp, never the later counter finish. Late/invalid GPT still abstains; late counter results are discarded and cannot mutate a returned decision. Task caps are ENTRY/HOLD 8000ms and RECHECK 4000ms, intersected with snapshot expiry and any trigger expiry minus 3000ms. Consumers must still revalidate at order dispatch; an offline collected decision is not an executable ticket.

Pro remains available only as an explicitly marked research candidate (122/122 timeouts, plus 27/27 separate diagnostics). It is excluded from REALTIME_MODEL_CANDIDATES and rejected by the baseline-first coordinator without allowResearchOnly=true. Its full completion latency is unknown; the dataset establishes failure under these caps, not universal model unusability.

Official sources checked:
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/guides/thinking_mode/
