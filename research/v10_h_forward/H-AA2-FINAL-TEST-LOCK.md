# V10-H H-AA2 Final-Test Lock

Locked before any H-AA2 final-test outcome access.

Candidate: `H-AA2_RANGE_TACTICAL_SQUEEZE_CONTINUATION`
Venue: Binance spot
Side: LONG
Structural regime: causal `MARKET-REGIME-OBSERVER-v1 == NEUTRAL`
Outcome horizon: 600 seconds
Stress round trip: 23 bps
Duplicate rule: same-market eligible observations <15 minutes apart form one cluster; keep first.

Exact signal:
- dynamicStatus = NEUTRAL
- dataQuality >= 0.80
- spreadBps <= 10
- 0.50 <= m1BandPosition <= 1.05
- m1BandWidthExpansionRatio >= 1.05
- tradePressureFast >= 0.35
- bookImbalance >= 0.10
- micropriceDeviationBps >= 0.10
- m1VolumeRatio >= 1.00

Discovery evidence, 2026-08-14 15:45 UTC through 2026-08-19 00:00 UTC:
- 41 independent event clusters
- 16 markets
- 5 UTC dates
- mean stress +52.59 bps/event
- stress PF 1.865
- best-event removal +34.44 bps/event
- positive dates: 4/5
- worst-date mean: -52.07 bps
- first chronological half +111.60 bps/event
- second chronological half -3.61 bps/event

The preregistered selection rule chose H-AA2 over H-AA3 because both passed the formal discovery gates and H-AA2 had the better worst-date mean.

FINAL TEST is exactly:
`2026-08-19T00:00:00Z <= signal < 2026-08-21T01:00:00Z`

No threshold, horizon, cost, clustering, venue, or side changes are permitted after this lock.
