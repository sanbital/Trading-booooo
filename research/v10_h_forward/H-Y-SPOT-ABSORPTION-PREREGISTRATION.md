# V10-H Y/Z — Binance Spot RANGE absorption reversal

Frozen before any outcome query for this candidate family.

## Data and split
- Source features: persisted `scanner_candidates` Binance spot LOB snapshots.
- Outcomes: persisted `scanner_blocked_shadow_outcomes`, 600-second horizon.
- Structural regime: causal `MARKET-REGIME-OBSERVER-v1 == NEUTRAL`, observation no older than 15 minutes at signal time.
- TRAIN: 2026-08-14 15:45 UTC <= t < 2026-08-17 00:00 UTC.
- VALIDATION: 2026-08-17 00:00 UTC <= t < 2026-08-19 00:00 UTC.
- FINAL TEST (sealed until validation decision): 2026-08-19 00:00 UTC <= t < 2026-08-21 01:00 UTC.
- Same-market signals within 15 minutes are one event cluster; keep the first signal only.
- Entry/reference/outcome venue: Binance spot.
- Direction: LONG only.
- Stress round-trip cost: 23 bps; base: 14 bps.

## H-Y — strict absorption reversal
All must hold at signal time:
- structural regime = NEUTRAL
- LOB dynamic status = NEUTRAL
- dataQuality >= 0.80
- spreadBps <= 10
- tradePressureFast <= -0.35 (aggressive selling)
- bidAbsorptionScore >= 0.40
- bookImbalance >= 0
- micropriceDeviationBps >= 0
- m1BandPosition <= 0.50
- m1VolumeRatio >= 0.80

Mechanism: aggressive selling reaches a lower-half intrabar/range location but bid-side absorption, displayed depth, and microprice have already stopped confirming further downside.

## H-Z — neighboring absorption reversal
Same mechanism, neighboring fixed configuration:
- structural regime = NEUTRAL
- LOB dynamic status = NEUTRAL
- dataQuality >= 0.70
- spreadBps <= 12
- tradePressureFast <= -0.25
- bidAbsorptionScore >= 0.30
- bookImbalance >= 0
- micropriceDeviationBps >= 0
- m1BandPosition <= 0.60
- m1VolumeRatio >= 0.70

## Promotion gates
Before opening FINAL TEST, both TRAIN and VALIDATION must have:
- >= 20 independent events for the selected candidate,
- positive mean stress return,
- stress PF > 1.10,
- positive first and second chronological halves,
- positive mean after removing the best event,
- no single market > 40% of events.

Only one candidate may be selected from Y/Z before TEST. If neither passes all validation gates, this family is retired without TEST access.
