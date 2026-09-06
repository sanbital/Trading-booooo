# Dynamic universe + breakout research (2026-09-06)

Status: research/shadow only. This branch does not enable or deploy autonomous live-order execution.

## Immediate architectural corrections

- Delete the arbitrary fixed 15-symbol universe from candidate discovery.
- Do not cap discovery to top-N symbols.
- Do not use the legacy 50M USDT 24h quote-volume floor as an opportunity-discovery gate. IOSTUSDT and EPICUSDT are 2026-09-06 counterexamples: both produced >20% 24h moves while current 24h quote volume remained below 50M USDT.
- Discover all TRADING / USDT / PERPETUAL Binance USD-M symbols first.
- Determine executability downstream from actual spread, depth and expected slippage for the intended order size.
- Global market regime is not an entry veto for local momentum. It should adjust position budget, confirmation strictness, trailing width and holding duration.

## 2026-09-06 case study — ARBUSDT

Observed pattern:
- 02:00 KST: wick/fakeout to 0.13960, close 0.13446; taker-buy share ~46.8%. Not a clean entry.
- 03:00-03:05 KST: 5m close 0.14042 above the prior 0.13960 wick; taker-buy share ~56.2%.
- OI increased from ~319.3M at 03:00 to ~320.3M at 03:10 while price held the breakout.
- This is the clean conservative breakout/reclaim trigger. Waiting for a 15m confirmation around 0.14102 still left substantial continuation.
- Around 10:15 and 10:45 KST, repeated high-volume upper rejections appeared while aggressive-buy share was below 50%, creating a first de-risk signal.
- 13:00-13:10 KST: price printed 0.20436 but failed to hold it. At 13:00 the 15m bar had ~48.9M USDT quote volume and ~62% taker-buy share, yet closed far below the high. OI jumped ~358.4M -> 380.1M -> 385.7M from 13:00 to 13:10 while price failed, then OI unwound. This is strong absorption/crowding/exhaustion evidence.

Implication:
- Entry logic should reward breakout + buy aggression + non-declining OI.
- Exit logic should detect price/flow divergence: aggressive buys continue but price stops responding, upper wicks repeat, and OI surges into a failed high.

## 2026-09-06 case study — RAYSOLUSDT

Observed pattern:
- 01:30-02:00 KST: first impulse toward 0.8771.
- 02:15 onward: pullback/base around the 0.86-0.88 area.
- 07:45-07:50 KST: 5m/15m reclaim and breakout of the prior ~0.8873 high. 07:50 5m close ~0.8941 with taker-buy share ~64.2%.
- OI rose in parallel from ~3.35M around the breakout setup toward ~3.52M shortly after. Price up + OI up + aggressive buying up is constructive confirmation.
- Peak later reached ~1.1999.
- 13:15 KST: price turned down after the failed high while 5m taker-buy share dropped to the low-40% area. OI continued increasing (~4.92M at 13:00 to ~5.15M at 13:15 and ~5.23M at 13:20) while price fell, confirming a crowded reversal rather than a healthy continuation.

Implication:
- A 07:50 entry near 0.8941 followed by a 13:15 exit near 1.1600 preserves roughly +29.7% underlying price move and most of the available post-entry peak profit.

## Additional counterexamples to the 50M quote-volume gate

- IOSTUSDT: current 24h move >26% with ~25.8M USDT 24h quote volume. A 10:45 KST 5m breakout above the prior ~0.7319e-3 high closed near 0.7421e-3 with taker-buy share ~66.5% before an extension/rejection sequence.
- EPICUSDT: current 24h move >22% with ~23.2M USDT 24h quote volume. Afternoon breakout continuation later reached ~0.4783 before a high-volume rejection; the following 15m bar closed near 0.4452 with taker-buy share below 50%.

## Order-book limitation and required telemetry

Binance REST exposes current depth but does not provide arbitrary historical order-book snapshots. The existing database contains no historical depth/order-book snapshot table, so the exact resting walls at the earlier breakout times cannot be reconstructed after the fact.

For every WATCH / BREAKOUT / OPEN position state, future shadow telemetry must persist temporal order-book features rather than a single snapshot:
- best bid/ask and spread bps;
- cumulative bid/ask depth within 5/10/20 bps;
- depth imbalance;
- microprice;
- bid replenishment and ask depletion;
- wall persistence/cancellation rate to reduce spoofing sensitivity;
- expected slippage for the intended notional;
- simultaneous taker-buy/sell flow and OI change.

## Replacement architecture

Opportunity discovery must precede regime routing:

1. `ALL USD-M PERPETUALS` — dynamic exchange discovery.
2. `RISING / ACCELERATING` — local 5m/15m price and quote-volume acceleration; no market-regime veto.
3. `PULLBACK / BASE` — controlled retracement or compression without structural failure.
4. `RECLAIM / PRIOR-HIGH BREAK` — 5m early trigger with 15m context.
5. `MICROSTRUCTURE CONFIRM` — taker flow + OI + temporal book/depth/slippage.
6. `OPEN / RUNNER` — manage MFE and higher lows.
7. `EXHAUSTION / DISTRIBUTION` — price/flow/OI divergence, repeated failed highs, high-volume rejection.
8. `EXIT` — ratchet profit floor; regime only changes how tight/loose the exit controller is.

Bull/range/bear therefore change duration and risk handling, not whether an independently strong asset is visible.

## Evaluation objective

Primary objective is cumulative net absolute PnL after fees and modeled slippage. Win rate is secondary. The research scorecard must include:
- net PnL in USDT per day/week/month;
- profit factor and expectancy per trade;
- max drawdown;
- opportunity-capture rate for later +10/+15/+20% movers;
- entry timing as a fraction of the eventual move already consumed;
- MFE/MAE;
- peak-profit capture ratio and profit giveback;
- trade frequency/turnover and missed-opportunity attribution.

No strategy can guarantee positive PnL; production promotion requires positive out-of-sample cumulative net PnL after costs and acceptable drawdown.
