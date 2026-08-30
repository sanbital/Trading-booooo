# V10-H Candidate Lock — H-T

Locked before any outcome access to the early 2026-07-25 through 2026-08-13 OOS window.

## Discovery path

H-Q/H-R tested propagation in the sign of the Upbit-minus-Binance fast-pressure spread and failed on TRAIN. The observed sign reversal motivates a distinct economic hypothesis: extreme cross-venue pressure disagreement in structural NEUTRAL is exhaustion/noise, not information propagation. H-S/H-T therefore trade opposite the pressure-spread sign using the exact Q/R feature gates.

H-S strict was not viable on TRAIN. H-T is the only locked candidate for OOS.

## Exact H-T rule

Common source/quality on TRAIN:
- exact same `scan_id` and asset on Binance + Upbit
- source timestamp delta <= 2 seconds
- both dataQuality >= 0.80
- both tradeCount >= 100
- causal `MARKET-REGIME-OBSERVER-v1 = NEUTRAL` within previous 15 minutes

Define `spread = up_pressure_fast - bin_pressure_fast`.

If spread >= +0.90 and all are true:
- Upbit microprice >= +1.0 bps
- Upbit book imbalance >= +0.03
- Upbit volume ratio >= 0.80
- abs Upbit M1 move <= 70 bps
- abs Binance M1 move <= 60 bps
then enter Binance SHORT.

If spread <= -0.90 and all mirror conditions are true:
- Upbit microprice <= -1.0 bps
- Upbit book imbalance <= -0.03
- Upbit volume ratio >= 0.80
- same move caps
then enter Binance LONG.

Exit: fixed 30 minutes. Outcome price is first same-asset Binance scanner live price in [signal+30m, signal+33m]. Same-asset signals connected by <=30m gaps are one cluster; use the first signal in each cluster.

Costs: BASE 14 bps, STRESS 23 bps.

## TRAIN result used for lock

Window with causal v1 NEUTRAL labels: 2026-08-14 15:45 UTC through 2026-08-21 01:09 UTC.

- raw signals: 56
- independent clusters: 46
- labeled 30m clusters: 41
- assets: 14
- UTC dates: 6
- max single-asset share: 26.1%
- mean gross 30m: +49.65 bps
- mean BASE: +35.65 bps
- mean STRESS: +26.65 bps
- STRESS PF: 1.266
- chronological half 1 STRESS: +30.26 bps
- chronological half 2 STRESS: +22.48 bps
- remove-best-event STRESS mean: +10.85 bps

## Untouched OOS protocol

OOS dates: `[2026-07-25 00:00 UTC, 2026-08-14 00:00 UTC)`.

`MARKET-REGIME-OBSERVER-v1` did not exist for most of this earlier window. No later regime model may be backfilled. OOS therefore has two predeclared views:

1. **Broad OOS:** exact same cross-venue/quality H-T signal without a structural label. This is a harder generalization test across mixed market states.
2. **NO_BUY OOS subset:** same signals restricted to the contemporaneous `scanner_scan_runs.status = NO_BUY`, a persisted causal low-action state. This is a diagnostic approximation only and is not treated as identical to structural NEUTRAL.

Required OOS evidence for promotion consideration:
- >=20 independent labeled clusters in broad OOS
- positive STRESS mean and PF >1.10 in broad OOS
- positive remove-best STRESS mean
- no single asset >40%
- NO_BUY subset must not show a material sign reversal when it has >=10 labeled clusters
- afterwards, exact forward C01/crossvenue feature semantics must be checked before production

No H-T threshold or direction may be changed after this lock.