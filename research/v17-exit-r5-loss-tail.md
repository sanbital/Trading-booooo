# V17 exit R5 — cutting the loss tail without a tighter stop

Date: 2026-09-09 (KST). Strategy: `LEADER_MOMENTUM_V17`, Binance USDⓈ-M, LONG only,
40 USDT margin at 3x (≈120 USDT notional).

Everything below is measured, not asserted. Sources:

- **Supabase production DB** (`etaajwpernzrcdrifdnw`) — `v11_long_regime_positions`,
  `exchange_trade_fills`, `v17_market_scan_runs`, `v11_long_regime_runtime`,
  `v17_operator_control`.
- **Binance USDⓈ-M public REST**, fetched from Postgres via the `http` extension
  (`fapi.binance.com/fapi/v1/klines`) because the analysis container cannot reach
  Binance directly.

## 1. What actually happened today

V17 automated trades only. Attribution is `metadata->>'executionMode' =
'LEADER_MOMENTUM_V17'` on the position row, cross-checked against
`exchange_trade_fills.v17_position_id`.

| metric | value |
|---|---|
| closed trades | 26 |
| wins / losses | 16 / 10 |
| win rate | 61.5% |
| net PnL | **+1.61 USDT** |
| largest winner | +5.73 (BRUSDT) |
| largest loser | **−6.26 (DOGSUSDT)** |
| average winner | +1.47 |
| average loser | −2.18 |
| profit factor | 1.07 |
| expectancy | +0.06 / trade |
| trades ≤ −2 USDT | **5, summing −18.95** |

The whole problem in one line: **the five tail trades cost −18.95 USDT while the
entire day netted +1.61.** Win rate is not the problem — loss size is.

### The manual MAGMA trade is excluded, and verified excluded

`exchange_trade_fills` for the KST day splits cleanly:

| source | v17 link | fills | markets | gross | fees |
|---|---|---|---|---|---|
| AUTOMATED | yes | 147 | 17 | +7.2293 | 2.7889 |
| UNCLASSIFIED | **no** | 10 | MAGMAUSDT only | −4.2611 | 0.1352 |

MAGMAUSDT (net −4.396) is the only unclassified activity, carries no
`v17_position_id`, and is excluded from every number in this document.

## 2. The three real problems

### Problem 1 — the loss tail is the entry stop, not late invalidation

Replaying all 26 trades on Binance 1m klines: the big losers did **not** drift
slowly. They went to the −2.5% entry stop quickly and the stop did its job.

| trade | MFE | MAE | realized | hold |
|---|---|---|---|---|
| DOGSUSDT 19:11 | +0.63% | −5.44% | −5.12% (−6.26 USDT) | 20 min |
| DOTUSDT 20:16 | +0.45% | −2.86% | −2.66% (−3.31) | 33 min |
| RAYSOLUSDT 21:01 | +0.69% | −2.80% | −2.51% (−3.14) | 40 min |
| IOSTUSDT 08:46 | +2.49% | −2.92% | −2.53% (−3.16) | 6 min |
| KATUSDT 11:45 | ~0% | < −2.5% | −2.5% (−3.07) | **88 s** |

There is no "slow invalidation" to fix. −2.5% × 3x × 120 USDT ≈ −3.2 USDT is
simply what a V17 stop-out costs. DOGSUSDT is the exception and it is an
*execution* defect, not a policy one: it filled 2.69% **below** its own trigger,
because it predates the exchange-resident stop (commit 256214b/125a7d4). Since
that shipped, measured stop slippage is −0.15%…+0.03%.

### Problem 2 — the ratchet is inverted: too loose before arming, too tight after

The live ladder (`EXIT_REVIEW_CANDIDATE` + `nextExit`) is:

| polled MFE | stop |
|---|---|
| < +1% | entry − 2.5% |
| ≥ +1% | **entry + 0.2%** (cost breakeven) |
| ≥ +2% | entry + 0.5 × (peak − entry) |
| ≥ +3% | peak − 1.5% |

That +1% step moves the stop **2.7 percentage points in one jump, from below
entry to above it.** It therefore does two harmful things simultaneously:

- Below +1% there is no protection except the full −2.5%. **Every loss on both
  days came from this bucket.**
- At +1% a scratch exit becomes near-certain. Six trades closed between +0.02 and
  +0.15 USDT — and the market kept going without us:

| trade | exit | move in the 30 min after exit |
|---|---|---|
| KATUSDT 03:16 | +0.14 USDT | **+13.5%** |
| RAYSOLUSDT 05:51 | +0.09 | **+10.7%** |
| FORMUSDT 00:01 | −0.01 | +4.2% |
| GRASSUSDT 06:51 | +0.08 | +0.9% |
| VVVUSDT 07:25 | +0.10 | +1.8% |
| PIEVERSEUSDT 01:51 | +0.09 | +0.3% |

### Problem 3 — MFE capture is 45%

Across both live days V17 realises 45.1% of the favourable excursion it
achieves. PONSUSDT gave back 5.87%→3.09%, BRUSDT 7.74%→4.87%,
DOGSUSDT 4.97%→−0.14%.

## 3. What was tested and rejected

**A tighter fixed stop does not work, and the data says so plainly.**
SOPHUSDT on 2026-09-08 05:05 fell **−3.09% within its first minute** and then ran
**+11%** in the following 10 minutes. Any stop inside −3% kills it. Winner MAE and
loser MAE overlap completely, so no fixed price stop separates them.

(Worth recording: SOPH survived *live* only because the software monitor polls the
bid once a minute and happened to miss the dip. With the exchange-resident stop now
active, that same trade would be stopped out. The native stop made the −2.5% level
genuinely binding for the first time.)

**Arming the ratchet from true 1m highs instead of the polled bid also fails.**
It cuts the tail (avg loss −2.59 → −2.11) but wicks arm the profit lock early and
average winner collapses 1.42 → 0.92, capture 0.451 → 0.316. Net gets *worse*.
Measurement precision helps risk and hurts profit, so the two roles must be split —
which is why R5 changes only the level, not the observation source.

## 4. The adopted change (R5)

One level, two triggers:

> The stop moves to **entry − 1.2%** when **either** a +1% favourable excursion is
> observed **or** 10 minutes pass without one.

Everything else is unchanged: −2.5% entry stop as the last-resort floor, +2% profit
lock at 50% capture, +3% trailing stop at 1.5%, 45 min stale, 6 h max hold.

Why this shape:

- It is **below entry**, so it cuts risk without manufacturing a scratch.
- The deadline means every position's loss cap reaches −1.2% within 10 minutes,
  including trades that never move up at all.
- It is monotone — only ever a candidate for the existing `max()` over protection
  levels, so it can never lower a stop that already ratcheted.

### Replay, 39 closed live trades (2026-09-08 + 2026-09-09), armed exactly as the one-minute monitor observes

| metric | V17 current | R5 | Δ |
|---|---|---|---|
| net PnL | −8.86 | **+19.60** | +28.46 |
| net excl. top-2 winners | −19.13 | **+0.71** | +19.84 |
| profit factor | 0.786 | **1.486** | |
| average loser | −2.590 | **−1.920** | −26% |
| sum of all losses | −41.44 | −40.32 | |
| MFE capture | 0.451 | **0.604** | |
| win rate | 59.0% | 46.2% | **−12.8pp** |
| average winner | 1.417 | **3.329** | |

Per day: 2026-09-09 +12.08 → +25.98; 2026-09-08 −20.94 → −6.38. Improves on
**both** days, and on both days after trimming the two best trades — so the gain is
not one lucky runner.

The win-rate drop is deliberate and is the cost of the change: scratch wins become
small losses in exchange for a smaller tail and much larger winners.

### Parameter robustness

A 5 × 6 grid over (arm, level) — arm ∈ {0.8, 1.0, 1.2, 1.5, 2.0}%, level ∈ {−1.8,
−1.5, −1.2, −1.0, −0.8, −0.5}% — beats production in **every one of the 30 cells**
on 2026-09-09, and in 26 of 30 on 2026-09-08. −1.2% is the joint ridge: it is the
best level on 2026-09-08 for every arm value, and within 2% of best on 2026-09-09.
Arm 1.0% and 1.2% give identical results (no trade has an excursion in between), so
1.0% was chosen to keep the trigger point identical to the existing
`breakEvenArmPct` — the only thing that changes is the level it moves to.

The fail deadline is the least-identified parameter: on 2026-09-08 the result is
flat in `fail_after` from 6 to 20 minutes (those trades fail faster than any of
these), and on 2026-09-09 the variation is noise. 10 minutes was chosen as the
middle of the flat region.

### What R5 does *not* fix

Fast crashes straight through the entry stop. KATUSDT 11:45 today lost −3.07 in
88 seconds; neither the +1% arm nor the 10-minute deadline can fire that quickly.
On 2026-09-08 the worst-3 sum is essentially unchanged (−9.65 → −9.64) for the same
reason. Capping that class needs either a smaller entry stop (rejected above) or
smaller size, which is out of scope here.

## 5. Out-of-sample

Only two days of V17 live trades exist, so the parameters were re-tested on entries
V17 never took. The V17 scanner (`feature15` / `entryReason` / `confirm5`) was
re-implemented in SQL over the **full 521/526-symbol universe** for 2026-08-31 …
2026-09-06 — a period entirely before the in-sample days.

The reconstruction is validated against the live scanner's own audit rows: at
2026-09-09 00:00 the reconstructed `dayReturn` and `volumeRatio` match the values
recorded in `v17_market_scan_runs.details.top10` **to five decimal places** for
every symbol. The only discrepancy is a constant rank offset caused by 5 CJK-named
symbols (`牛来USDT`, `哈基米USDT`, …) that the SQL loader cannot URL-encode.

Admission proxy: at most one entry per 5-minute cycle (best rank) and one entry per
symbol per 60 minutes. It is policy-independent, so **both candidates are scored on
an identical 289-entry set** and only the exit differs.

| metric | V17 current | R5 | Δ |
|---|---|---|---|
| trades | 289 | 289 | |
| net PnL | +29.80 | **+48.96** | **+64%** |
| expectancy / trade | +0.103 | **+0.169** | +64% |
| **max drawdown** | **68.59** | **46.05** | **−33%** |
| net / max drawdown | 0.43 | **1.06** | |
| average loser | −2.863 | **−2.113** | −26% |
| trades ≤ −2 USDT | 95 | **55** | −42% |
| sum of those | −302.17 | **−170.84** | −43% |
| MFE capture | 0.516 | 0.554 | |
| win rate | 61.9% | 41.5% | −20.4pp |

Per KST day (net, and count of trades ≤ −2):

| day | n | V17 net | R5 net | V17 tail | R5 tail |
|---|---|---|---|---|---|
| 08-31 | 32 | −23.69 | −23.06 | 12 | **9** |
| 09-01 | 48 | −23.75 | **−5.08** | 18 | **8** |
| 09-02 | 47 | +3.49 | −3.79 | 15 | **6** |
| 09-03 | 49 | +33.59 | +28.98 | 16 | **9** |
| 09-04 | 51 | +18.46 | **+27.91** | 18 | **14** |
| 09-05 | 52 | +0.64 | **+6.41** | 13 | **7** |
| 09-06 | 10 | +21.06 | +17.59 | 3 | **2** |

R5 wins 4 of 7 days on net and loses 3 — it is **not** uniformly better day to day,
and that should be expected of a change this size. But the objective metric, the
loss tail, is smaller on **every single day**, and both the total and the drawdown
improve substantially.

### Why the 10-minute deadline is kept even though it costs net

Dropping the deadline (risk cut armed only by a +1% excursion) scores *higher* net
out-of-sample — +55.60 vs +48.96 — but it does nothing for the tail:

| variant | net | max DD | net/DD | tail n | tail sum |
|---|---|---|---|---|---|
| V17 current | 29.80 | 68.59 | 0.43 | 95 | −302.17 |
| R5, no deadline | **55.60** | 54.32 | 1.02 | 95 | −302.17 |
| **R5 as adopted** | 48.96 | **46.05** | **1.06** | **55** | **−170.84** |

The deadline trades 6.6 USDT of net for 8.3 USDT of drawdown and 43% of the tail.
On a 40 USDT margin account that is the right side of the trade, and it is the
stated objective of this work.

## 6. Cutover

Per position. `openBull` stamps `metadata.leaderExitPolicyVersion =
'V17_EXIT_R5_TAIL'` at entry; `manageLeader` selects `EXIT_REVIEW_R5` only for
stamped rows. Positions opened before the deploy keep `EXIT_REVIEW_CANDIDATE` for
their whole life and never have their stop moved underneath them. At deploy time
there were no open V17 positions, so the cutover is clean regardless.
