# V10-H AA — Structural RANGE / tactical squeeze continuation discovery

Frozen before querying outcomes for this family.

## Data protocol
- Source: Binance spot `scanner_candidates` point-in-time LOB/microstructure features.
- Structural regime: causal `MARKET-REGIME-OBSERVER-v1 == NEUTRAL`, <=15m stale.
- Discovery only: 2026-08-14 15:45 UTC <= t < 2026-08-19 00:00 UTC.
- FINAL TEST remains sealed: 2026-08-19 00:00 UTC <= t < 2026-08-21 01:00 UTC.
- Outcome horizon: persisted 600-second shadow outcome.
- Long only, Binance spot.
- Same-market eligible signals less than 15 minutes apart are one cluster; keep first.
- Stress round trip: 23 bps.
- Discovery robustness is checked by UTC-day folds; candidate selection requires >=4 distinct discovery dates, positive aggregate stress return, PF>1.10, positive result on at least 4/5 chronological date buckets when 5 dates exist, and positive best-event removal.

## Common mechanism
A structural RANGE market can still contain short tactical expansions. Trade only when completed 1-minute band width is expanding and live aggressive buying, displayed book, and microprice all point upward. Avoid severely stretched upper-band locations.

Common gates:
- dynamicStatus = NEUTRAL
- dataQuality >= 0.80
- spreadBps <= 10
- 0.50 <= m1BandPosition <= 1.05
- m1BandWidthExpansionRatio >= 1.05
- tradePressureFast > 0
- bookImbalance > 0
- micropriceDeviationBps > 0

Locked neighboring settings:
- `H-AA1`: pressure >= 0.25, book >= 0.05, microprice >= 0.05 bps, m1VolumeRatio >= 0.80
- `H-AA2`: pressure >= 0.35, book >= 0.10, microprice >= 0.10 bps, m1VolumeRatio >= 1.00
- `H-AA3`: pressure >= 0.50, book >= 0.15, microprice >= 0.15 bps, m1VolumeRatio >= 1.20

Selection rule before FINAL TEST:
1. Reject any candidate failing discovery robustness gates.
2. Among survivors choose highest worst-date mean stress bps; ties by higher event count, then lower strictness number.
3. Open FINAL TEST once for the single locked winner. No threshold changes after test access.
