# Temporal HOLD study: deployed, not promoted

The approved research function was deployed and exercised against real DeepSeek API calls. **This experiment did not establish a trading improvement. DeepSeek has no live decision authority.**

## Release verification

- Main implementation: 13cab4fbeb7c4ff47148df6db4c972cfe59a6ea9. Published files match the locally tested files.
- Supabase etaajwpernzrcdrifdnw: deepseek-temporal-shadow v1 ACTIVE, artifact SHA-256 b0c8bfa3840444ea2059c3a62db87753e3860784bba6a4a8d10cbef882343a39.
- Private tables and service-only claim RPC deployed with RLS. Anonymous table reads and RPC execution are denied. Advisor no-policy notices are intentional for service-only tables.
- Unauthenticated request 56373 returned 401; disabled request 56374 returned zero work; first execution 56383 completed four pairs.
- Exactly 120 claims: 119 completed pairs, one rejected missing-candle packet, zero RUNNING. Cap test 56437 returned zero work. Collection is now disabled; no recurring job was installed.
- All 119 pairs overlapped, maximum start separation 2 ms; every enriched-input hash matches local preparation. These were two Flash ablation arms, not live GPT/DeepSeek trading calls.
- Local tests: 81 passed; Deno endpoint typecheck passed. Trading executor v87 remains ACTIVE with unchanged hash 753aae6b3e65b6b064085b95d287b8c18ba500b4be1c642eb7d3527800643ace.

## Actual results

120 distinct historical simulated positions were selected without inspecting labels. Of 119 usable packets, 39 had prior same-position observations. All 120 follow-up candle paths were obtained. Eight otherwise usable packets were already below their stored stop at the next full-minute execution proxy, leaving 111 locally evaluable positions (38 with history).

| Metric | A: current snapshot | B: current + temporal wrapper |
|---|---:|---:|
| Calls | 119 | 119 |
| Valid responses | 117 (98.3%) | 113 (95.0%) |
| HOLD / UNCERTAIN / EXIT | 112 / 5 / 0 | 101 / 10 / 2 |
| Invalid responses | 2 | 6 |
| Latency p50 / p95 / p99, ms | 1058 / 1352 / 1387 | 1075 / 1377 / 2551 |
| Early exits overriding eligible saved GPT HOLD | 0 | 1 |
| Local fixed-stop 60-minute incremental proxy, USDT | 0 | +0.9337 |

The sole positive early-exit case **had no prior history**. Among pairs with two valid responses, decisions differed in 1/36 with history versus 15/75 without history. Prompt framing and model sampling can cause differences; these results do not establish a benefit from temporal information. B also increased invalid responses. No post-outcome prompt tuning or rerun was used.

Recorded tokens imply approximately $0.1223 combined at documented peak Flash prices. Usage from invalid responses was not retained by the existing provider; this estimate is incomplete billing coverage, not an invoice.

## Decision

**Do not promote either arm to an entry gate or early-exit rule.** This is DEVELOPMENT only. The positive proxy is not realized profit or OOS improvement. Minute-bar labels use delayed execution and fixed stored stops, omit full profit-lock evolution, fills, capacity and added latency. The synthetic always-HOLD event generator can include review points unreachable under production policy. Winner retention is not established by one early exit.

Trading safeguards, sizing, native stops, GPT fallback and order execution were not changed by this temporal experiment. External review reproduced a specific research-helper defect: parallelReview awaited both providers, then used their joint completion time to invalidate a timely GPT decision. A counter consuming its 200ms budget turned an immediate valid BUY into ABSTAIN/COUNTER_STALE at 202ms. The fixed helper settles baseline freshness and return time independently; only the explicitly offline collector waits for counter diagnostics. ENTRY/HOLD remain capped at 8s, RECHECK at 4s, and a supplied trigger expiry reserves 3000ms.

These statements describe the c2fd61e experiment. The later v89 release enabled a separate order-free DeepSeek observer; it does not call parallelReview and grants no counter authority. This external-review patch does not modify or redeploy the executor. See [external review](../deepseek-counter-20260925/EXTERNAL-REVIEW.md).

The temporal experiment remains disabled with no automatic promotion. Full execution-aware replay and untouched chronological TEST evidence remain required before any DeepSeek decision authority. A/A and B/B repetition tooling is now available, but no new provider noise experiment has been executed and no historical prompt or outcome has been tuned.

## Reproduction

Local artifacts: development-inputs.json, development-candles.json, development-labels.json, input-quality.json, provider-results.json, comparison.json and tests.log. The private queue retains packets, temporal inputs and results. Local evaluate.mjs and summarize.mjs reproduce preparation and the descriptive comparison. Newly collected raw records were not published to GitHub.

Sources checked 2026-09-25: [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) and [changelog](https://api-docs.deepseek.com/updates/). Current pricing/changelog retain V4-Pro despite the conflicting earlier launch announcement.
