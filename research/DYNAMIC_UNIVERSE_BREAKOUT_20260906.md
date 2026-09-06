# Dynamic universe + breakout research (2026-09-06)

Status: research/shadow only. This branch does not enable or deploy autonomous live-order execution.

Objectives:
- Remove the arbitrary fixed 15-symbol research universe from candidate discovery.
- Discover Binance USD-M perpetual symbols dynamically using exchange metadata and liquidity thresholds.
- Study pullback -> prior-high breakout -> continuation patterns on 5m/15m bars.
- Record taker buy/sell flow, open interest, and future order-book snapshots for candidate/exit audits.
- Evaluate exits by net PnL capture, not win rate.

Initial case studies: ARBUSDT, RAYSOLUSDT.
