# DeepSeek connection and provider replay — 2026-09-25

The registered `deepseek api` secret now authenticates successfully inside Supabase.
Both official model IDs were verified against the live models endpoint. No key value
was read out, copied to a local file, or written to logs.

## Release decision

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

Official sources checked:
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/guides/thinking_mode/
