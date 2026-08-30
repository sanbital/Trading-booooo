# V10-H Forward RANGE Preregistration

Status: ACTIVE RESEARCH LINEAGE
Date: 2026-08-30 UTC

## Lineage rule

V10-G is retired. Its fixed 12-hour half-life event condition produced zero TRAIN trades; V10-H must not loosen, rename, or reuse that mechanism.

The prior canonical V10 candle/cross-exchange search on `main` is historical evidence only. V10-H is a new point-in-time forward microstructure lineage using features that were not historically reconstructed: live aggressive trade flow, L2 depth, microprice, derivatives positioning, and (from the cross-venue collector revision) simultaneous Binance USD-M / Upbit KRW observations.

No candidate threshold may be changed after its first outcome query. Failed/sparse candidates remain frozen and the next economic mechanism must be separately preregistered.

## Data revisions

- Binance forward collector: `V10_USDM_FORWARD_COLLECTOR_R1`
- Binance feature revision: `V10_USDM_POINT_IN_TIME_V1`
- Binance fixed universe: `V10_USDM_STABLE_8_V1`
- Cross-venue collector: `V10_CROSSVENUE_FORWARD_COLLECTOR_R1`
- Cross-venue feature revision: `V10_CROSSVENUE_POINT_IN_TIME_V1`
- Cross-venue fixed universe: `V10_CROSSVENUE_STABLE_7_V1`
- Structural regime: `MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET`
- RANGE structural state for H candidates: `NEUTRAL`
- Capital effect during research: `NONE`
- Labels/fills are never written by collectors.

Execution-cost robustness remains inherited from canonical V10 for comparability:
- BASE round trip: 14 bps
- STRESS round trip: 23 bps

## H-A / H-B — microstructure volatility expansion continuation

Symmetric LONG/SHORT continuation after a directionally aligned burst. Common: `NEUTRAL`, `abs(premium_bps) <= 15`, trailing-five causal averages only.

### H-A
- aggressive quote/sec >= 2.0x trailing-five average
- abs 60s signed move >= max(3.0 bps, 1.75x trailing-five average abs move)
- abs aggressive flow imbalance >= 0.35, direction aligned
- abs 5-level book imbalance >= 0.15, direction aligned
- abs microprice displacement >= 0.15 bps, direction aligned
- signed 60s price move aligned with entry
- time exits: 15m and 30m

### H-B neighbor
- aggressive quote/sec >= 1.5x trailing-five average
- abs 60s signed move >= max(2.0 bps, 1.5x trailing-five average abs move)
- abs aggressive flow imbalance >= 0.25
- abs 5-level book imbalance >= 0.10
- abs microprice displacement >= 0.10 bps
- all directions aligned
- time exits: 15m and 30m

## H-C / H-D — failed-impact L2 absorption fade

Symmetric fade after aggressive same-direction impact meets opposite L2/microprice absorption. OI must be non-decreasing from the immediately prior observation.

### H-C
- aggressive quote/sec >= 1.5x trailing-five average
- shock flow abs >= 0.35
- shock 60s move abs >= 3.0 bps
- opposite 5-level book imbalance abs >= 0.15
- opposite microprice displacement abs >= 0.10 bps
- premium in shock direction abs >= 2.0 bps
- entry opposite shock direction
- time exits: 30m and 60m

### H-D neighbor
- aggressive quote/sec >= 1.25x trailing-five average
- shock flow abs >= 0.25
- shock 60s move abs >= 2.0 bps
- opposite 5-level book imbalance abs >= 0.10
- opposite microprice displacement abs >= 0.08 bps
- premium in shock direction abs >= 1.0 bps
- entry opposite shock direction
- time exits: 30m and 60m

## H-E / H-F — crowded-position unwind confirmation

Symmetric reversal only after the prior five observations show price extension plus OI expansion and premium crowding, while current aggressive flow, L2, microprice, and 60s price all confirm reversal.

### H-E
- prior-five price extension abs >= 12 bps
- prior-five OI increase >= 8 bps
- premium in extension direction abs >= 4 bps
- current reversal flow abs >= 0.20
- current reversal 5-level book imbalance abs >= 0.15
- current reversal microprice displacement abs >= 0.10 bps
- current reversal 60s move abs >= 1.0 bps
- time exits: 30m and 60m

### H-F neighbor
- prior-five price extension abs >= 8 bps
- prior-five OI increase >= 5 bps
- premium in extension direction abs >= 3 bps
- current reversal flow abs >= 0.15
- current reversal 5-level book imbalance abs >= 0.10
- current reversal microprice displacement abs >= 0.08 bps
- current reversal 60s move abs >= 0.5 bps
- time exits: 30m and 60m

## Independence / promotion rules

- Multiple signals from the same symbol within 30 minutes are one event cluster for robustness reporting; this is a robustness diagnostic, not a post-outcome candidate rule change.
- Cross-symbol signals during the same broad market shock must be disclosed as one market episode and cannot be counted as independent validation episodes without additional evidence.
- No production promotion from sparse forward observations. Promotion requires independent event diversity, cost-positive robustness, side/regime coverage appropriate to the candidate, implementation parity, and a separately frozen validation decision.
- No final-test or production decision may be inferred from a single market episode.
