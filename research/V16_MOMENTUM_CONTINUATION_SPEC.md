# V16 Momentum Continuation — research/shadow specification

Status: research/shadow only; no autonomous live-order activation.

## Thesis

The primary opportunity detector is asset-local. Market regime cannot hide an independently strong symbol. Regime modifies risk budget and exit tightness after a local opportunity is found.

## State machine

`DISCOVER -> RISING -> PULLBACK_BASE -> BREAKOUT_RECLAIM -> MICRO_CONFIRM -> RUNNER -> EXHAUSTION -> EXIT`

### DISCOVER
- Source: all Binance USD-M `TRADING / USDT / PERPETUAL` symbols.
- No hardcoded symbol list.
- No top-N cap.
- No arbitrary 50M USDT 24h-volume discovery floor.
- Existing full-universe Binance ticker code in `market-v2-signal` should be reused where practical.

### RISING
Log, rank and later tune rather than hard-veto on a single threshold:
- 5m/15m returns and acceleration;
- higher-high/higher-low structure;
- quote-volume acceleration versus the symbol's own rolling baseline;
- distance from VWAP/EMA/ATR to identify already-overextended moves.

### PULLBACK_BASE
Track:
- retracement from local impulse high;
- time spent below/around prior high;
- falling/normalizing volume during pullback;
- preservation of the prior higher low;
- compression/volatility contraction before re-expansion.

### BREAKOUT_RECLAIM
Primary timestamp is the earliest closed 5m bar that reclaims/breaks the relevant prior high after the pullback/base. 15m provides context and confirmation; it must not force a 10-15 minute late entry when the 5m signal is already high quality.

Log:
- breakout close versus prior high;
- breakout distance in ATR units;
- quote-volume expansion versus rolling median;
- taker-buy share and change from the pullback period;
- candle close location / upper-wick rejection;
- anti-chase distance.

### MICRO_CONFIRM
For shortlisted candidates only:
- OI level/change/acceleration;
- taker buy/sell flow;
- best bid/ask and spread bps;
- cumulative depth within 5/10/20 bps;
- depth imbalance and microprice;
- bid replenishment / ask depletion over time;
- wall persistence/cancellation rate;
- expected slippage at the intended notional.

Historical book depth must be captured prospectively because Binance REST cannot reconstruct arbitrary old depth snapshots.

### RUNNER
Maintain a high-water mark and MFE/MAE continuously. Profit protection is stateful, not a fixed hold-time exit.

### EXHAUSTION
Score simultaneous evidence rather than using one indicator:
1. failed new high / repeated upper rejection;
2. aggressive-buy share falls materially or becomes sell-dominant;
3. aggressive buying remains high but price no longer responds (absorption);
4. OI rises while price stalls/falls after an extension (crowding/reversal risk);
5. high-volume negative/rejection candle;
6. temporal book flips toward persistent ask supply / weak bid replenishment;
7. break of the last confirmed 5m higher low or volatility-adjusted trail.

Use the first cluster of exhaustion evidence to de-risk; use stronger confirmation / structural break to close the runner. Exact score weights and thresholds must be selected from out-of-sample event studies rather than fitted to ARB/RAYSOL alone.

## Regime use

Regime is a modifier, not the opportunity gate:
- BULL: wider trail, more tolerance for pullbacks, longer runner.
- RANGE: medium trail and faster de-risking after divergence.
- BEAR/RISK_OFF: smaller risk budget, tighter confirmation/exit, shorter runner; still permit exceptional asset-local momentum when execution quality is acceptable.

## Objective function

Primary: cumulative net PnL in USDT after fees, modeled slippage and funding where relevant.

Secondary diagnostics:
- opportunity capture rate for future +10/+15/+20% movers;
- fraction of the move consumed before entry;
- MFE/MAE;
- peak-profit capture ratio;
- giveback from MFE to realized exit;
- expectancy/trade, profit factor, max drawdown;
- trades/day and capital utilization;
- missed-opportunity attribution (`NOT_DISCOVERED`, `NO_PULLBACK`, `BREAKOUT_FAIL`, `FLOW_FAIL`, `BOOK_FAIL`, `RISK_BLOCK`, `EXECUTION_FAIL`).

## Promotion rule

No production promotion from a single-day example. Require positive cumulative out-of-sample net PnL after costs across multiple market regimes, acceptable drawdown, materially higher opportunity-capture rate than V11/V15, and no hidden fixed-universe or regime-veto regression.
