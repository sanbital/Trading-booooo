# Live model review — exit geometry and regime hysteresis (2026-09-01)

Scope: the model-side items only. Router-level entry suspension (item 1 below) is deployment
work and is reported here as evidence, not changed.

## Cohort

All closed `binance_futures` positions carrying `metadata.p10_initial_risk`, 2026-08-21 to
08-30: 53 fills (43 P10 LONG, 10 S096 SHORT). R is computed from the recorded entry price and
`p10_initial_risk`; realised R is `realized_pnl_quote / (initial_risk * initial_quantity)`, so
it is already net of fees.

The 10-day window quoted in the review request reproduces exactly on the 08-23 cut:

| Cohort | n | wins | total | avg win | avg loss | mean peak |
|---|---|---|---|---|---|---|
| 08-23 onward (the "10-day" set) | 40 | 10 (25.0%) | −20.57 USDT | +1.26R | −0.66R | 0.70R |
| 08-21 onward (full) | 53 | 21 (39.6%) | +343.37 USDT | +1.65R | −0.67R | 1.09R |

`exchange_trade_fills`, the canonical settlement ledger, agrees with the position rows to
within 1 USDT over the same span (+342.65). The two windows differ almost entirely because
08-21 and 08-22 contributed +363 USDT. **The 10-day set is one drawdown regime, not a
stationary sample**, so every number below is reported on both windows and no parameter is
adopted that only helps the drawdown window.

## Replay method

Hourly price paths are reconstructed per position from `v2_live_universe_snapshots`
(`venue = binance_futures`, one print per market per hour) over `(opened_at, closed_at]`. This
is the same bar-close view `evaluateP10Exit` arms break-even on. Intrabar extremes come from
the recorded `peak_price` / `trough_price`, which the monitor updates at cycle cadence.

Rules are evaluated in production order (target, then partial, then break-even), and **any
fraction no new rule fires on falls back to the trade's actual realised R**. A change is only
ever credited when it demonstrably triggers before the real exit.

Three fidelity variants are reported because ordering within an hour is unknown:
`path` (hourly closes only, under-fires), `peak` (intrabar extremes, over-fires), and
`hybrid` (targets intrabar, break-even armed on hourly closes — the closest match to
production).

## 1. Router-level entry suspension — evidence only, not changed here

The registry's current revision is `P10-PRODUCTION-REGIME-ROUTER-V11` (recorded 08-30 14:44
UTC) and **all five V11 lanes carry `entry_enabled = false`**; both BULL lanes read
`REJECTED_NO_ROBUST_EDGE`. The all-branches block does exist at the registry level.

The live path does not resolve it. Every gate attempt today stamps
`policy_revision = P10-PRODUCTION-REGIME-ROUTER-v3`, and the v3 lane rows still carry
`entry_enabled = true / ENABLED_EXISTING_EDGE` on BULL_TREND and BULL_DECELERATING.

Most of today's blocks were genuine router decisions rather than the DB CHECK: 25 signals
returned `BLOCK` with `RANGE_ABSTAIN_NO_VALIDATED_EDGE` or `BEAR_ABSTAIN_NO_VALIDATED_EDGE`
while bull_score sat at 39.9–55.1. That abstention holds only while the score stays under 58,
and today it did not. At 06:04 UTC, ETHFIUSDT LONG returned

    decision = PASS, reason = VALIDATED_BULL_LONG_EDGE,
    policy_revision = P10-PRODUCTION-REGIME-ROUTER-v3, regime = BULL, bull_score = 60.21

The v3 BULL lane admitted the entry and the DB CHECK (`p10_entry_suspension`, suspended since
08-30 14:44) was the only layer that stopped it. The single-defence exposure is not
hypothetical; it was exercised this morning. The retry amplification is also real: 1,340 gate
attempts across 25 blocked signals today, 71–80 per signal on the worst ones.

Repointing the live resolver from v3 to V11 is the fix, and it is deployment-side.

## 2. Break-even trigger — changed, 1.50R → 0.30R

Break-even arms on a completed bar close. Across the 43 live LONG fills, **not one of the 24
losers ever closed an hour above 0.69R**, and none reached an intrabar peak of 1.50R either.
The 1.50R trigger therefore armed on no losing trade at all: the break-even stop was
unreachable code, which is why `breakEvenAtR` never once fired in ten days of live trading.

Trigger sweep, targets held at T1 2.0R/40% and T2 5.0R:

| BE | 10d hybrid | full hybrid | 10d path | 10d peak |
|---|---|---|---|---|
| 1.50 (before) | −1.48R (23.3%) | +21.09R (41.9%) | −3.64R | −1.48R |
| 0.75 | −1.48R | +19.82R | −3.64R | −0.64R |
| 0.50 | −0.38R | +20.92R | −2.80R | +2.63R |
| 0.40 | −0.38R | +20.92R | −2.79R | +3.25R |
| **0.30 (after)** | **+0.57R (40.0%)** | **+21.87R (53.5%)** | **−2.17R** | **+3.25R** |
| 0.25 | +0.57R | +20.67R | −2.17R | +4.07R |

0.30R improves or holds every cell and sits on a flat plateau (0.25 and 0.30 agree on the
10-day window). 0.50R — the value suggested in the request — is materially weaker, because
several rescued trades peaked above 0.5R intrabar but never *closed* an hour there, and
arming is close-based.

Per-trade attribution on the full window, 1.50R → 0.30R: six trades rescued (ETH, ICP, XMR,
CRV, VVV, VVV; +2.06R combined), one winner truncated (TRB, −1.26R), net +0.78R. The gain is
spread, not one trade. The benefit concentrates in the drawdown window and costs almost
nothing in the good one, which is the expected shape for a drawdown-control change.

## 3. Targets — recomputed, deliberately left unchanged

The request proposed lowering the targets to match the reach distribution (mean peak 0.69R
against a 5R target). The reach distribution does not support that: it is fat-tailed, and the
mean peak is dragged down by losers that never moved. Cutting T2 clips the right tail that
pays for the strategy.

T2 sweep at BE 0.30R, T1 2.0R/40% (hybrid):

| T2 | 1.5 | 2.0 | 2.5 | 3.0 | 3.5 | 4.0 | **5.0** | 6.0 |
|---|---|---|---|---|---|---|---|---|
| 10-day | −3.12 | −2.32 | −1.79 | −2.38 | −1.88 | −1.38 | **−0.38** | −2.23 |
| full | +9.18 | +13.98 | +16.28 | +15.99 | +18.49 | +17.92 | **+20.92** | +15.27 |

T2 = 5.0R is best on both windows and every reduction loses money. T1 = 2.0R is likewise
optimal; lowering it to 1.0–1.5R is worse on both windows. A joint grid over
(BE, T1, fraction, T2) ranked by worst case across both windows and all three fidelity
variants returns BE = 0.30 and T2 ∈ {4, 5} in every one of its first twelve rows, with T1
spread over {1.5, 2.0, 2.5} and the single best cell at T1 = 2.0, fraction 0.4, T2 = 4.0.

Raising `partialFraction` from 0.40 toward 0.60 improves both windows monotonically
(+0.35R / +0.68R), but the effect is small, it re-shapes a separately validated strategy, and
it was not requested. Left alone; flagged as the one target-side change the data does support.

**SHORT lane (S096).** `target_1` and `target_2` are equal at 1.5R by design, not by accident:
`t1_allocation_pct` is set to 100 for S096, so T1 is a full exit and the partial is
deliberately unused. This is not the config bug it looks like. Two observations:

* S096 has no break-even and no trailing logic at all — fixed stop, fixed 1.5R target, 96h
  time stop. Applying a 0.30R break-even to the 10 live shorts improves hybrid −3.19R →
  −2.12R (it rescues ZAMA, which peaked 0.73R then stopped).
* The short target cannot be re-derived from this data. Both winners closed at exactly 1.52R
  and 1.54R because the 1.5R target took them out — the peak distribution is censored at the
  target, so a T2 sweep on shorts measures the target, not the market.

With n = 10 and two wins, neither is enough to change a separately validated frozen strategy.
Recommended as a shadow evaluation, not a live change.

## 4. Regime threshold hysteresis — changed

`regimeOf` was a bare step function (72 / 58 / 42). Replayed over the 3,164 live observations
from 08-21 to 09-01 it changed label 372 times — a flip every ~43 minutes — and which side of
the 58 line a single five-minute print landed on decided whether entries were open. The
09-01 sequence in the request (60.2 → 52.6 → 47.7 inside twenty minutes) is one instance.

Each boundary now carries a pair of thresholds instead of one: the classifier's training
ground truth (40 / 60 / 75) to move up, its predicted threshold (42 / 58 / 72) to move back
down. **The band introduces no new free parameter** — it is the gap the model already records
on every observation as `thresholds` versus `training_ground_truth_thresholds`. A boundary
moves only after two consecutive observations agree, matching the `partialConfirmations: 2`
idiom `P10_MARKET_RISK_CONFIG` already applies to its own exit thresholds.

Measured by running the shipped function over the live series:

| | flips | BULL-or-above share | median dwell |
|---|---|---|---|
| step (before) | 372 | 17.4% | 25 min |
| hysteresis (after) | 173 (−53%) | 14.4% | 45 min |

Exposure is essentially unchanged while churn halves, which is the property that makes this a
noise filter rather than a regime-exposure change. Wider bands do more (±5 reaches 108 flips)
but require a parameter the model cannot justify from its own metadata.

### Two consequences worth naming

* `predicted_regime` now stores the committed label, so `market_regime_outcomes` scores the
  label the system acted on rather than the raw print. That is the more meaningful accuracy
  measure, but it is a change in what the accuracy series means.
* `MODEL_REVISION` is deliberately **not** bumped. `P10_MARKET_RISK_CONFIG.modelRevision` and
  the single row in `market_regime_provenance_registry` both pin
  `MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET`; bumping it without updating both would take the
  exit-risk overlay to STALE. Behaviour therefore changes under an unchanged revision string,
  which is exactly what that registry exists to prevent. Bumping it properly is a coordinated
  code + registry + deploy change and belongs with the router repoint in item 1.

### What this would and would not have changed on 09-01

Replaying the actual 05:20–06:25 sequence through the shipped function:

| | 05:40 | 05:45 | 05:50 | 05:55 | 06:00 | 06:05 | 06:10 |
|---|---|---|---|---|---|---|---|
| bull_score | 56.39 | 58.77 | 60.08 | 60.54 | 60.21 | 57.36 | 54.17 |
| step | NEUTRAL | **BULL** | BULL | BULL | BULL | NEUTRAL | NEUTRAL |
| hysteresis | NEUTRAL | NEUTRAL | NEUTRAL | **BULL** | BULL | BULL | NEUTRAL |

The band trims the BULL episode from four observations to three and shifts its onset ten
minutes later, but **it would not have stopped the 06:04 ETHFI PASS** — that print sat inside
the window either way, because the score genuinely held above 60 for three consecutive
observations. The band suppresses one-print excursions, and this was not one. It is a churn
fix, not a second line of defence, and it does not substitute for item 1.

## Verification

`deno test` 882 passed / 0 failed (874 before; 8 new). `deno check` clean on
`market-regime-observer/index.ts`, `_shared/regime-hysteresis.ts`, `_shared/p10-policy.ts`.
The hysteresis figures above were produced by running the shipped `committedRegimeOf` over the
live score series, not by the SQL model used to explore the parameter space.
