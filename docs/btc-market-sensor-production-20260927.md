# BTC market sensor production verification

**BTC MARKET SENSOR: PRODUCTION VERIFIED** at 2026-09-26 17:07:23.583304+00.

BTC remains the priority-1 MARKET_SENSOR. MARKET_SENSOR_CONTEXT_V1 independently validates 24 contiguous causal 5-second buckets, complete trade sequence/book/flow, and closed BTC candle provenance. TRADE_CONTEXT_V3 retains the original coverage_25 requirement; its definition MD5 remains `16c234ccede07d0eaf698a02ee98b08d`.

- Continuous verified interval: 2026-09-26T16:51:51.302Z through 2026-09-26T17:01:53.048Z, 601.746 seconds and 32 observations. BTC was AVAILABLE and watched equaled synced at every observation.
- Final ten-minute raw audit: 120 BTC buckets; gaps, incomplete, future and stale counts all zero; maximum book exchange-to-receive latency 129 ms. Closed candle evidence updated across 11 minutes. Candidate BTC return injection matched in all 3,565 joined buckets.
- Partial depth remained explicitly incomplete in all 120 BTC buckets. Only observed depth within the synchronized snapshot boundary is sent to the sensor packet. BTC trade requests still fail with TRADE_CONTEXT_UNAVAILABLE_DEPTH_COVERAGE.
- Dynamic watches reached 31/31 synced. All 30 non-BTC contexts were AVAILABLE at final inspection. New LSK/BILL watches correctly returned INCOMPLETE_TRAJECTORY while warming up near the end of the soak, then both passed without changing any validator.
- A live, order-free fd1-exit-probe returned valid GPT FIRST, DeepSeek and GPT FINAL responses. FIRST and DeepSeek used the identical snapshot hash. DeepSeek cited market_sensor.return_120s and FINAL adopted that evidence. Both initial and final sensor packets were AVAILABLE. No final sensor event/receipt/ingestion exceeded the FINAL cutoff.
- T01–T14 passed. Latest strategy/capture CI: 537 passed, zero failed. Executor and generator Deno type checks passed.
- Test orders: 0. Trading configuration changes: 0; all four control-table hashes were unchanged.

The final observation had zero open positions. The predeployment WLD OPEN context was AVAILABLE before the position closed normally. OPEN_POSITION identity/state and coverage regressions passed in T12. The live model probe used a labelled position fixture; it did not open a position. Therefore this receipt does not claim a postdeployment live OPEN-position sample.

Collector source: `f9991053869ebab1cf220b3431afe0fdddcee037`; image: `sha256:8032b54a78a42507de98a2d4ef572e70967e41dbda19694dbc075ae90b5deb99`.

Executor: version 104; bundle SHA-256 `48a2657336b7ecb5b47aab79d79f2d48357e8522b367c6b41d6fadcfbe03f6a1`. All 64 files matched the intended deployment. All six changed sensor/advisory modules matched main `d89c55f62e5183c57281067d4327b7d21931f8ce`. Unrelated PR #193 exit changes on main were outside this rollout; unchanged executor files were preserved from the actual deployed bundle.

Implementation: [#194](https://github.com/sanbital/Trading-booooo/pull/194), [#195](https://github.com/sanbital/Trading-booooo/pull/195), [#196](https://github.com/sanbital/Trading-booooo/pull/196). [Production soak](https://github.com/sanbital/Trading-booooo/actions/runs/36256455824), [raw release artifact](https://github.com/sanbital/Trading-booooo/actions/runs/36256455824/artifacts/10911376651), [latest regression run](https://github.com/sanbital/Trading-booooo/actions/runs/36257506757).

See [machine-readable receipt](../deployment-evidence/btc-market-sensor-production-20260927.json) for timestamps, snapshots, configuration hashes, all soak observations and final watch results.
