# V20 loss-preservation replay result

## Decision

`NO_PRODUCTION_PROMOTION` — all three frozen candidates are `INFERIOR` under
the gates locked before their validation outcomes were opened.  Production
must remain on V20/QV3.  This result does not authorize a strategy deploy,
control change, test order, ledger edit, forced close, or circuit bypass.

## Source of truth and cutoffs

- Supabase project: `etaajwpernzrcdrifdnw`.
- Live function observed during the review: `v10-lane-executor` version 39,
  patch `V20-QV3-EVIDENCE-1`, strategy `QV3_ENTRY_EXIT_TWO_1`, bundle SHA-256
  `f4c9691c91fe89a8737a2c656923741422e658880dfca8e6028e8835075a66a5`.
- Live source commit: `716a7dc61154637da539a85931476d9c685f65c6` on
  `release/v20-qv3-evidence-1`; the V20 diff only captures exact QV3 input
  evidence and its regression test proves identical HOLD/CLOSE behavior.
- Frozen evidence: workflow run `34695837055`, artifact SHA-256
  `29e03a6d7949cc6d4828ce04c6bdc7783d95b7d14e75c71208b57b2851ec8df7`.
- Frozen Binance Vision evidence: workflow run `34696937388`, 66,110 official
  futures one-minute rows.
- Prospective V20 database cutoff: `2026-09-13T00:17:57.553824Z`.
- Exact replay population: 80 development + 46 chronological validation + 2
  operational-gap + 28 prospective V20 = 156 closed, automated, long futures
  positions.  No spot fill is mixed into any result.
- The 104-trade 48-hour baseline exactly equals the database aggregate.  The
  replayable seven-day set has 156 trades; the database has 179.  The 23 older
  trades missing from the sealed candle artifact are reported as unavailable,
  not synthesized.

The candidate replay is a fixed-actual-entry conditional-exit overlay.  It
uses only decisions, fresh quotes, and completed candles available by each
evaluation time.  It is not an account-level re-entry simulation and therefore
cannot promote an entry filter.

## Recomputed operating baseline

The user-supplied first 20 V20 trades reproduce exactly:

| Metric | V20 first 20 | Previous equal 20 | Change |
| --- | ---: | ---: | ---: |
| Wins / losses | 6 / 14 | 8 / 12 | -2 / +2 |
| Win rate | 30.0000% | 40.0000% | -10.0000 pp |
| Net realized PnL | -11.441084 USDT | -1.801836 USDT | -9.639248 USDT |
| Average return | -0.476293% | -0.074373% | -0.401920 pp |
| Average winner | +1.559632 USDT | +2.594288 USDT | -1.034656 USDT |
| Average loser | -1.485634 USDT | -1.879678 USDT | +0.394044 USDT |
| Profit factor | 0.449918 | 0.920118 | -0.470200 |
| Expectancy | -0.572054 USDT/trade | -0.090092 USDT/trade | -0.481962 |
| Initial hard loss | 3 | 4 | -1 |
| MFE capture | -48.252021% | -4.864507% | -43.387514 pp |
| Profit giveback | 148.252021% | 104.864507% | +43.387514 pp |

Gross profit fell from 20.754302 to 9.357790 USDT (-11.396511), while gross
loss improved from 22.556138 to 20.798875 USDT (+1.757263).  Thus the dominant
degradation is lost winner value, not a wider average losing trade.  Losing
native-stop count stayed at seven, but native-stop path PnL fell from
-0.880960 to -13.205591 USDT.  QV3's 11 exits remained net positive at
+1.764506 USDT, but did not offset the native-stop tail.

The last 12 trades of that immutable first-20 snapshot also reproduce exactly:
1 win / 11 losses, -13.001397 USDT, -0.902406% average return, -139.484999%
MFE capture and 239.484999% giveback.

## Loss decomposition

At the prospective cutoff the V20 cohort had 28 trades, 9 wins / 19 losses,
-16.523174 USDT.  Classifications can overlap; the primary category is selected
in G → D → A → E → C → H order.

| Primary loss category | Trades | Net PnL |
| --- | ---: | ---: |
| G STOP EXECUTION LOSS | 2 | -6.314944 USDT |
| D HARD LOSS BEFORE ARMING | 3 | -8.886722 USDT |
| E PROFIT GIVEBACK | 6 | -3.244657 USDT |
| A BAD ENTRY | 4 | -6.166040 USDT |
| H NORMAL LOSS | 4 | -3.249126 USDT |

Across overlapping flags, A BAD ENTRY and C FALSE MOMENTUM each occurred in 9
of 19 losses, D in 4, E in 6, and G in 2.  B LATE ENTRY and F EXIT TOO EARLY
are `UNKNOWN`: the exact pre-entry local-high/EMA/order-book sequence and
post-exit candles were not stored in the decision evidence.  RSI, EMA distance,
breakout, pullback and entry 1m structure are likewise left `UNKNOWN` per trade
rather than backfilled with later public data.

In the original V20 first 20, the three zero-MFE losses (GRIFFAINUSDT,
龙虾USDT and ILVUSDT) lost 9.444 USDT; six losses below 20 bp MFE lost
15.275 USDT.  This confirms that entry quality and pre-arming failure are real
problems, even though the tested generic cuts did not solve them safely.

## Frozen candidates

- C1: while QV3 is unarmed, exit only after the latest two exact, contiguous,
  completed post-entry 1m candles are bearish, descending, and both below
  entry.
- C2: persist a position-bound +0.2% executable-bid proof only with 0–1000 ms
  quote RTT, 0–3000 ms book age and 0–1000 ms receive age; retain QV3's two-red
  confirmation.
- C3: union of C1 and C2.

Missing/future/incomplete/duplicated/gapped candles preserve baseline.  The
candidate module is pure, cannot alter stop/quantity/order state, and supports
only open automated long positions.  It is deliberately not connected to the
production executor because the performance gates failed.

### Candidate net-PnL delta versus the same actual entries

| Cohort | Trades | C1 | C2 | C3 |
| --- | ---: | ---: | ---: | ---: |
| Supplied V20 first 20 | 20 | -0.321551 | +0.082292 | -0.239259 |
| Frozen validation | 46 | -0.184257 | -10.654765 | -11.634341 |
| All post-QV3 replayable | 76 | -0.123407 | -10.572473 | -11.491199 |
| Latest 48h | 104 | +5.526782 | +3.710462 | +5.119368 |
| Latest 7d available | 156 | -21.327607 | +5.267260 | -8.841526 |
| Post-QV3 cost stress | 76 | -1.915353 | -11.289552 | -13.821195 |
| Post-QV3 60s-delay stress | 76 | -2.882828 | -9.356688 | -12.239516 |

C1's validation-window deltas are -2.035368 / +0.797481 / +1.053630 USDT,
so the every-window gate fails.  C1 turns validation winner LABUSDT from
+3.173058 to -0.813038 USDT.  C2 turns BEATUSDT from +8.976233 to
-1.091894 and CYSUSDT from +0.696897 to -0.685061.  C3 inherits all three.
All candidates fail leave-one-trade, leave-one-symbol, cost and delay stress,
net-PnL/expectancy, giveback, and winner-to-loss gates.  Baseline decision
parity is 100%; failure is not a replay mismatch.

### Best-looking short-window candidate is still inferior

C1 on all 76 replayable post-QV3 trades:

| Metric | Baseline | C1 | Change |
| --- | ---: | ---: | ---: |
| Trades | 76 | 76 | 0 |
| Wins / losses | 30 / 46 | 29 / 47 | -1 / +1 |
| Win rate | 39.473684% | 38.157895% | -1.315789 pp |
| Net PnL | -3.252436 | -3.375843 | -0.123407 USDT |
| Average return | -0.041549% | -0.048445% | -0.006896 pp |
| Average winner | +2.344716 | +2.316152 | -0.028564 USDT |
| Average loser | -1.599867 | -1.500942 | +0.098926 USDT |
| Profit factor | 0.955806 | 0.952146 | -0.003660 |
| Expectancy | -0.042795 | -0.044419 | -0.001624 USDT/trade |
| Initial hard loss | 13 | 12 | -1 |
| Closed-trade max DD | 21.642048 | 21.581198 | -0.060850 USDT |
| MFE capture | -2.964647% | -3.591011% | -0.626364 pp |
| Profit giveback | 102.964647% | 103.591011% | +0.626364 pp |

## Entry-filter diagnostics, not candidates

These are retrospective rejection diagnostics on the actual entries, not an
integrated cash/slot/re-entry replay.  None is eligible for production.

| Filter | V20 first-20 loss/winner rejected | First-20 net improvement | Validation loss/winner rejected | Validation net improvement | Why rejected |
| --- | ---: | ---: | ---: | ---: | --- |
| 15m return ≤3% | 8 / 3 | +16.338270 | 11 / 9 | -5.746327 | reverses OOS; 55% first-20 trade reduction |
| volume ratio ≤2 | 11 / 3 | +13.040914 | 14 / 12 | -10.975480 | removes most winners/trades |
| 5m return ≤1% | 7 / 3 | +5.462199 | 19 / 11 | -6.938607 | 65.2% validation trade reduction |
| day return ≤25% | 2 / 1 | +4.562703 | 11 / 6 | +3.839084 | adjacent 20%/30% thresholds are -11.739070/-2.064743 |
| entry drift ≤0.5% | 3 / 2 | +0.707363 | 4 / 1 | +1.816287 | adjacent 0.3% is -13.811526; no stable sensitivity |

The apparently positive point estimates are threshold-unstable and do not
model rejected-entry cash/slot replacement.  Treating them as deployed filters
would be look-ahead selection on this cohort.

## Native stop execution

The 28-trade V20 snapshot includes 11 native-stop exits.  Every final stop is
`STOP_MARKET`, `CONTRACT_PRICE`, `priceProtect=false`, `reduceOnly=true`.
Median trigger-to-fill price slippage is -1.8184 bp; three are worse than
-10 bp, two worse than -30 bp, and the worst is -76.1874 bp.

- TAUSDT: trigger 0.06169, fill 0.06122, -76.1874 bp, -2.445719 USDT and
  -2.037202% realized.  The replacement stop was acknowledged 102 ms before
  the prior stop's cancel request, so the evidence does not show a replacement
  race.
- GRIFFAINUSDT: trigger 0.016275, fill 0.01617, -64.5161 bp and
  -3.869225 USDT.
- 龙虾USDT: trigger 0.138218, fill 0.138117982, -7.2362 bp.
- ILVUSDT: trigger 3.868, fill 3.867, -2.5853 bp.

Exact exchange trigger timestamps, mark/last at trigger and trigger-time depth
were not persisted: coverage is 0/11 and those fields remain `UNKNOWN`.
Therefore the review cannot establish that changing `workingType`, enabling
`priceProtect`, or replacing the market stop with a limit stop would improve
execution without increasing non-fill risk.  No stop-order configuration change
is authorized.

## Representative counterfactuals

| Trade | Actual | C1 replay | Delta | Finding |
| --- | ---: | ---: | ---: | --- |
| TAUSDT | -2.445719 | -0.892885 | +1.552834 | early cut helps |
| Later GRIFFAINUSDT | -1.553414 | -0.773327 | +0.780086 | early cut helps |
| PUMPUSDT | -0.210707 | -2.353972 | -2.143265 | normal recovery is cut |
| Initial GRIFFAINUSDT | -3.869225 | unchanged | 0 | stop arrives before two completed bars |
| 龙虾USDT / hard-loss ILVUSDT | -3.205012 / -3.129676 | unchanged | 0 / 0 | core zero-MFE targets not caught |

## Verification

- Production release-equivalent Node regression: 395/395 passed.
- Candidate unit/no-look-ahead tests: 7/7 passed.
- Repository Deno regression: 886 passed, 0 failed (13 steps).
- Replayed baseline decision parity: 100%.
- Covered safety paths include duplicate-order prevention, reduce-only, partial
  fills, stop replacement, reconciliation, circuit behavior, restart/CAS/lease,
  stale/incomplete data, DB failures and temporary exchange/API failures.

## Reproduce

```sh
node research/20260912_v20/replay-candidates.mjs \
  --evidence /path/to/checksum-verified-v20-evidence \
  --vision /path/to/checksum-verified-binance-vision \
  --prospective /path/to/read-only-v20-dataset.json \
  --supplement /path/to/read-only-operational-gap.json \
  --output /path/to/replay-results.json
```

The output contains every prospective trade's available entry/exit fields,
fees, MFE/MAE and their evidence times, exit-time MFE, giveback, entry features,
stop history, trigger/fill data, slippage and A–H classification.  Absent
evidence is emitted literally as `UNKNOWN`.
