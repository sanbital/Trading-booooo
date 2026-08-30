# V10-H Historical Scanner Cross-Venue Preregistration

Frozen before any future-return query on the historical scanner-pair staging set.

## Causal staging universe

Source table: `v10_h_scanner_crossvenue_pairs`.

Each row satisfies all of the following before any outcome is attached:
- Binance and Upbit candidate rows share the exact same scanner `scan_id` and asset.
- Source timestamps differ by at most 2 seconds.
- Both rows contain point-in-time live price plus persisted microstructure features.
- A causal `MARKET-REGIME-OBSERVER-v1` observation exists within the prior 15 minutes and is exactly `NEUTRAL`.
- Source candidate IDs and regime observation IDs are persisted for replay.

Frozen staging checkpoint before outcome access:
- 22,537 paired observations
- 57 common assets
- 8 UTC dates
- interval: 2026-08-14 15:45 UTC through 2026-08-21 01:09 UTC

This historical lineage uses v1 regime labels only because C01 did not yet exist. C01 is not retroactively imputed.

Common quality gates for I-L:
- Binance and Upbit `dataQuality >= 0.80`
- Binance and Upbit `tradeCount >= 100`
- finite live price, M1 completed close, pressure, book, microprice, bandwidth expansion and volume-ratio fields
- entry/exit venue: Binance scanner live reference price
- BASE round trip cost: 14 bps
- STRESS round trip cost: 23 bps
- outcome horizons: 30m and 60m
- outcome match must be a Binance scanner observation for the same asset in [target, target + 3m]; otherwise unlabeled
- same-asset signals within 30m are one event cluster for robustness

## H-I — cross-venue aligned volatility expansion continuation

Direction `d = sign(Upbit move)` and Binance move must have the same sign.

Strict H-I:
- abs Upbit move from completed M1 close >= 25 bps
- abs Binance move from completed M1 close >= 15 bps
- abs Upbit fast trade pressure >= 0.70, aligned with d
- abs Binance fast trade pressure >= 0.40, aligned with d
- abs Upbit microprice displacement >= 4.0 bps, aligned with d
- abs Binance microprice displacement >= 1.0 bps, aligned with d
- Upbit bandwidth expansion >= 1.02
- Binance bandwidth expansion >= 1.02
- both venue volume ratios >= 1.0 and max(volume ratios) >= 1.5
- enter Binance in direction d

## H-J — neighboring aligned volatility expansion continuation

Same mechanism, fixed neighbor:
- abs Upbit move >= 20 bps
- abs Binance move >= 10 bps
- abs Upbit fast trade pressure >= 0.60 aligned
- abs Binance fast trade pressure >= 0.30 aligned
- abs Upbit microprice displacement >= 3.0 bps aligned
- abs Binance microprice displacement >= 0.75 bps aligned
- both bandwidth expansion >= 1.01
- both volume ratios >= 0.9 and max(volume ratios) >= 1.3
- enter Binance in the aligned direction

## H-K — Binance overshoot / Upbit absorption convergence fade

Economic mechanism: Binance has extended materially farther than Upbit in one direction, while Upbit flow and microprice already oppose that extension and Binance flow is weak enough to indicate failed impact. Fade Binance toward convergence.

Strict H-K:
- abs Binance move >= 25 bps
- Binance and Upbit M1 moves have the same sign
- abs Binance move - abs Upbit move >= 15 bps
- Upbit fast trade pressure opposes Binance move with abs >= 0.50
- Upbit microprice displacement opposes Binance move with abs >= 3.0 bps
- Binance fast trade pressure in the extension direction <= +0.20 when direction is up, or >= -0.20 when direction is down
- Binance bandwidth expansion >= 1.02
- enter opposite Binance extension direction

## H-L — neighboring Binance overshoot convergence fade

Same mechanism, fixed neighbor:
- abs Binance move >= 20 bps
- same-sign venue M1 moves
- abs Binance move - abs Upbit move >= 10 bps
- Upbit fast trade pressure opposes with abs >= 0.40
- Upbit microprice displacement opposes with abs >= 2.0 bps
- Binance extension-direction fast pressure <= +0.30 for up extension or >= -0.30 for down extension
- Binance bandwidth expansion >= 1.01
- enter opposite Binance extension direction

## Promotion gates

No candidate may be promoted unless, after 30-minute same-asset event clustering:
- at least 20 independent clusters
- at least 4 UTC dates in historical TRAIN/validation evidence
- no single asset > 40% of independent clusters
- positive STRESS mean return at the selected fixed horizon
- STRESS profit factor > 1.10
- positive after removing the best cluster
- positive in both chronological halves, or one half positive and the other non-negative with no sign reversal in the registered neighbor
- historical evidence is then confirmed against the new `V10_CROSSVENUE_FORWARD_COLLECTOR_R1` semantics before production

No thresholds above may be changed after this commit in response to returns.