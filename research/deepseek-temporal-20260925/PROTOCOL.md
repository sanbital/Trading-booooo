# DeepSeek temporal study — preregistration

Frozen before new provider calls or outcome retrieval. Baseline commit: 68e5b4656b9fa4cf38696cdd39cf7c7d76d8a646.

Objective: reduce failed-continuation losses without prematurely exiting winners. Accuracy alone is not the objective; paired net returns, loss tails and forgone upside must all be measured.

## Fixed experiment

- A: Flash non-thinking, original counter prompt and current packet.
- B: identical Flash settings/prompt/schema, with up to three earlier same-position factual snapshots and deterministic changes. History is at most 60 minutes old, strictly earlier than the decision. No previous model answers or future outcomes enter either prompt.
- Saved production GPT is an observational baseline, not a concurrent randomized model comparison.
- No prompt tuning after inspecting these outcomes. A revised prompt starts a separate protocol.
- Historical development sample: 120 distinct simulated positions, one HOLD review per position selected by MD5 ordering of review ID, then MD5 ordering of position ID. Selection does not inspect decisions or outcomes. The entire historical dataset and original 122 live packets are DEVELOPMENT, never OOS.
- Prospective collection: completed real HOLD packets only, for seven days from activation. First three days VALIDATION, next four TEST; positions opened before a boundary are not allowed to cross into a later partition. Decision inputs are immutable. Results are collected asynchronously, so these are delayed shadow calls, not executable historical fills.
- Finite cap: 420 positions/reviews total, two calls per review; no automatic retry after a claim. Each call is capped at eight seconds and 1,500 output tokens. Request body limited to 48 KiB. At current peak Flash pricing, allowing one input token per body byte plus maximum output gives less than 0.04 USD per pair and a 16.80 USD planning ceiling. The enforced limit is calls/body/output size, not a provider billing guarantee if prices change.

## Evaluation and promotion

Development labels use one-minute futures candles, the next full minute open as a delayed executable price proxy, fixed existing stop from the snapshot, conservative stop-first treatment and 5/15/60-minute horizons. Report execution delay, gaps, missing labels, fees/slippage and residual upside. These are local counterfactual diagnostics, not the live strategy's full portfolio PnL.

Live promotion requires a frozen policy evaluated on untouched TEST positions, with complete execution/stop paths, fees and adverse slippage, same 3x leverage, 150 USDT margin and ten slots. Require positive paired incremental net profit with a day/position-clustered 95% interval above zero, non-worsening tail loss and no material winner-retention degradation. Fewer than 100 independent completed TEST positions across at least seven trading days is insufficient; this pilot may need a separately authorized extension. No peeking and then reusing TEST for selection. Missing paths or regime/strategy mismatches block promotion.

No model confidence thresholds, weighted votes, relaxed stops, sizing changes or fallback to DeepSeek when GPT fails. Collector has no exchange imports, no order calls and no writes to production positions, signals or GPT results. Production authority remains empty. An elapsed collection period does not automatically authorize trading.

Sources checked 2026-09-25: https://api-docs.deepseek.com/quick_start/pricing/ and https://api-docs.deepseek.com/updates/. Current pricing/changelog retain V4-Pro; the earlier September 10 launch announcement has a conflicting retirement statement. Flash is V4.1-Flash; Pro timing results refer to the requested API ID, not a claim of hidden backend identity.
