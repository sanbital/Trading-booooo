# V17 LEADER MOMENTUM — Research Specification

Status: RESEARCH / SHADOW ONLY. No order routing or live-control changes in this branch.

## Objective
Replace pullback-first opportunity discovery with a cross-sectional leader-following process that searches the full Binance USDⓈ-M USDT perpetual universe for the strongest intraday movers, enters while momentum is still expanding, and exits when momentum decays or profit giveback becomes excessive.

The target is not to predict every daily winner. The target is to capture a robust subset of daily leaders early enough that the remaining move exceeds losses, fees, slippage, and failed-breakout costs.

## Non-negotiable principles
1. Full eligible futures universe, not a fixed 15/21-symbol list.
2. No requirement for BB pullback / oversold / low-RSI entry.
3. Market regime is a risk feature, not a hard prerequisite for leader discovery.
4. 15m bars select and rank leaders; 5m bars time entries and exits.
5. Every decision must use only information available at that timestamp.
6. Entry execution in research occurs at the next 5m bar open after a completed signal bar.
7. Include all failed signals, not only eventual winners.
8. Use realistic fees and slippage stress at 6/10/15 bp entry degradation plus round-trip fee model.
9. No live deployment until walk-forward / out-of-sample and forward-shadow results pass.

## Universe
At each timestamp, start from all active Binance USDⓈ-M USDT perpetual contracts with sufficient data history.

Liquidity thresholds to test rather than assume:
- 24h quote volume >= 10M / 20M / 50M USDT
- minimum recent 5m and 15m nonzero quote-volume coverage

Do not exclude a symbol only because it is not in an old static strategy universe.

## 15m leader discovery features
Compute cross-sectional ranks each completed 15m bar:
- return 15m
- return 30m
- return 60m
- return 3h
- return 6h
- return 24h
- distance from 24h high
- breakout above previous 1h / 3h / 6h high
- ATR / ATR baseline expansion
- current 15m quote-volume / rolling median quote-volume
- 1h quote-volume / prior 24h hourly median
- taker-buy quote ratio / imbalance
- relative strength versus BTC and versus cross-sectional median
- acceleration: short-horizon return minus longer-horizon normalized return

Primary candidate pool must be cross-sectional (top-N / percentile) rather than a fixed absolute return list only.

Leader pool grids to test:
- top 3 / 5 / 10 / 15 by composite leader score
- top 1% / 2% / 5% / 10% of active universe

## 5m entry families
Do not wait for a deep pullback. Test continuation confirmation families only.

A. Immediate continuation
- 15m leader candidate already active
- 5m close exceeds recent 15m/30m local high
- 5m return and quote-volume acceleration positive
- enter next 5m open

B. Momentum re-acceleration
- leader remains in top cross-sectional rank
- one or more 5m bars pause without breaking the leader structure
- new 5m high with renewed quote-volume / taker-buy expansion
- enter next 5m open

C. Rank-persistence continuation
- symbol remains top-N leader for 2 or 3 consecutive 15m observations
- 5m closes at/near new session high with positive acceleration
- enter next 5m open

No RSI oversold, stochastic oversold, BB-lower-band or deep-pullback gate is allowed in the core V17 family.

## Entry ranking / slot admission
When more candidates exist than available slots, rank by a deterministic composite of:
1. cross-sectional 1h/3h relative strength
2. volume acceleration
3. proximity to/new session high
4. 5m acceleration
5. taker-buy confirmation

Maximum portfolio capacity for later live evaluation: 10 slots.
Research must compare 1 / 3 / 5 / 10 slots and track expectancy by admitted rank (1-3, 4-5, 6-10).
Never force-fill weak slots.

## Exit families to test
V17 should make exits responsive to momentum decay, not fixed profit targets alone.

1. MFE giveback trailing
- arm after a minimum unrealized gain
- exit when a tested fraction or absolute amount of MFE is surrendered
- grids: 20% / 25% / 30% / 35% / 40% MFE giveback and alternative ATR-based trails

2. 5m momentum failure
- lower high + negative 5m acceleration
- break of short-term trailing low / volatility stop
- leader rank deterioration across two observations

3. Time-decay exit
- if position has not made a new MFE for N completed 5m bars, reduce/exit
- test 3 / 6 / 9 / 12 bars

4. Catastrophic stop
- volatility-normalized emergency stop only; test 1.5 / 2.0 / 2.5 5m ATR and capped-percent variants

5. Max hold
- test 1h / 2h / 4h / 6h / session-end behavior

No single take-profit level should be assumed before empirical testing because the desired edge is participation in unusually large right-tail moves.

## Required evaluation metrics
For every signal and trade:
- symbol
- timestamp
- leader rank at signal
- 15m/5m features
- next-open simulated fill
- MFE / MAE
- time to MFE
- realized return after costs
- exit reason
- MFE capture ratio
- profit giveback
- maximum adverse move before continuation
- leader-rank persistence

Portfolio metrics:
- trades/day
- daily leader opportunities/day
- leader capture rate
- win rate
- PF
- expectancy/trade
- expectancy/day
- max drawdown
- average winner / loser
- tail contribution from top winners
- results by slot rank
- results by BTC/market regime without hard-gating them

## Opportunity-capture metric
Define the day's ex-post leader set only for evaluation, never for signal generation.
Test multiple definitions, e.g. top-10 daily return / top-10 intraday high excursion among liquid contracts.
Measure how many were signaled before 25%, 50%, and 75% of their eventual daily move had already occurred.

The objective is to determine whether a robust system can capture roughly 3 of 10 daily leaders early enough to produce positive net expectancy. The 3/10 target is a coverage target, not an assumed profitability result.

## Walk-forward requirement
Use multiple non-overlapping periods. Select parameters only on train windows and freeze them for validation/test windows.
Report at minimum:
- historical multi-period test
- 2026 recent test
- most recent independent 7d and 14d windows where data are available
- 5m and 15m exact-bar parity

Reject any parameter set that depends on one recent window or one named example such as IOST/SOPH/UAI.

## Deployment boundary
This branch must not:
- enable live routing
- clear trading circuits
- modify user/manual positions
- place or cancel orders
- modify margin/leverage/account settings

Only after empirical validation should a separate production implementation be considered.
