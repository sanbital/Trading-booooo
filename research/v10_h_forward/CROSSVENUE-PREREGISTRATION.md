# V10-H Cross-Venue RANGE Preregistration

Frozen before outcome evaluation of cross-venue candidates.

## Common data-quality and regime rules

- Structural regime must be `NEUTRAL` from `MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET`.
- Cross-venue source revision: `V10_CROSSVENUE_FORWARD_COLLECTOR_R1` / `V10_CROSSVENUE_POINT_IN_TIME_V1`.
- Fixed common universe: BTC, ETH, SOL, XRP, DOGE, ADA, LINK.
- Upbit 60-second trade count must be >= 5; otherwise the observation is `NO_SIGNAL`, not zero flow.
- Binance 60-second aggregate-trade count must be >= 30.
- Both source-quality timestamps must be causal and the snapshot must be a COMPLETE collection row.
- Entry venue for research P&L is Binance USD-M; entry reference is the Binance mid from the signal snapshot.
- BASE round trip = 14 bps; STRESS round trip = 23 bps.
- Fixed time exits for initial forward evaluation: 30m and 60m.
- No threshold may be loosened after the first outcome query.

## H-G — Upbit lead / Binance underreaction continuation

Economic mechanism: Korean spot order flow and price lead a short-lived directional impulse while Binance USD-M has moved in the same direction but has not fully followed. Enter Binance in the Upbit direction.

LONG requirements:
- Upbit signed 60s return >= +4.0 bps
- Upbit trade-sign imbalance >= +0.35
- Upbit 5-level book imbalance >= +0.10
- Upbit microprice displacement >= +0.08 bps
- Binance signed 60s return >= 0 and <= 0.60 * Upbit signed 60s return
- Binance trade-sign imbalance >= -0.10

SHORT is the exact sign mirror:
- Upbit signed 60s return <= -4.0 bps
- Upbit trade-sign imbalance <= -0.35
- Upbit 5-level book imbalance <= -0.10
- Upbit microprice displacement <= -0.08 bps
- Binance signed 60s return <= 0 and abs(Binance return) <= 0.60 * abs(Upbit return)
- Binance trade-sign imbalance <= +0.10

## H-H — neighboring Upbit lead / Binance underreaction continuation

Same mechanism, neighboring fixed configuration.

LONG requirements:
- Upbit signed 60s return >= +3.0 bps
- Upbit trade-sign imbalance >= +0.25
- Upbit 5-level book imbalance >= +0.08
- Upbit microprice displacement >= +0.05 bps
- Binance signed 60s return >= 0 and <= 0.75 * Upbit signed 60s return
- Binance trade-sign imbalance >= -0.15

SHORT is the exact sign mirror with thresholds -3.0 bps, -0.25, -0.08, -0.05 bps, Binance same-direction underreaction <=75%, and Binance flow <= +0.15.

## Robustness requirements before promotion

- At least 20 independent event clusters after 30-minute same-symbol de-duplication.
- At least 8 distinct UTC dates unless a longer predeclared forward window is used.
- No single asset may contribute more than 40% of independent events.
- Positive STRESS mean return at the chosen fixed exit.
- Positive STRESS profit factor > 1.10.
- Positive result after removing the single best event cluster.
- At least two chronological halves positive under STRESS.
- Both the candidate and its registered neighbor must not show sign reversal of the economic effect; only one may be promoted.
- Production implementation must use the exact feature semantics and thresholds above; otherwise no promotion.
