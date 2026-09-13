# V21 entry/exit account-growth research result

## Decision

**NO PRODUCTION PROMOTION — DEFER.**

The frozen V21 policy does not satisfy the pre-registered promotion gates. No
strategy code was merged to `main`, no Edge Function was deployed, and no live
entry or exit control was changed by this work.

This is a reproducible negative research result, not a strategy rollout. The
candidate code remains side-effect-free research code and `executionEnabled`
is false in the independent replay output.

## Baseline and evidence boundary

- Baseline recorded at protocol lock:
  - repository `main`: `bce9e95210829b5ae561f667dd1b499772977ec1`
  - production release source: `716a7dc61154637da539a85931476d9c685f65c6`
  - `v10-lane-executor` version 39
  - executor patch `V20-QV3-EVIDENCE-1`
  - live strategy `QV3_ENTRY_EXIT_TWO_1`
  - production bundle SHA-256 `f4c9691c91fe89a8737a2c656923741422e658880dfca8e6028e8835075a66a5`
- Frozen candidate: `V21_DECAY_RECLAIM_1`
- Development cutoff: `2026-09-13T00:17:57.553824Z`
- Candidate lock: `2026-09-13T04:20:13Z`
- Candidate rule SHA-256:
  `8cf176b1a8afdb43c6d2325e19fbcc391f8eb1e6db954c488c2b3fa470d6a28c`
- Protocol SHA-256:
  `5f20931bb814d094878bd612e509b7cb0621269e60305cd2d9dcbfc915ecfb3e`
- Latest reconstructed input used here was queried at
  `2026-09-13T04:28:44Z`; it contains 193 closed automated long positions
  from `2026-09-08T02:26:05.078Z` through `2026-09-13T04:20:11.085Z`.
- The independent replay uses only the common exact-candle interval
  `2026-09-11T12:05:00Z` through `2026-09-11T23:59:59.999Z`: 709 scanner
  frames, 25,740 exact 1-minute candles over 36 symbols, and 103 observed
  opportunities.

Production deployments and strategy changes are distinct. Function version 39
is a deployment count/version. `V20-QV3-EVIDENCE-1` added decision evidence but
did not change QV3 trading behaviour.

### Final live addendum

A final read at `2026-09-13T04:57:07Z` found two natural QV3/R5 trades after
the candidate lock. VTHO closed `+15.14811357 USDT` net with `0.12748133 USDT`
attributed fees; SAGA closed `+1.19783603 USDT` net with `0.12070797 USDT`
fees. Neither is eligible for B/C: VTHO's 5-minute return is above B's maximum
and SAGA's 15-minute return is below B's minimum. Therefore A/B/C/D all retain
both trades and the B/D holdout delta remains `-0.18521049 USDT`.

The current available-history aggregate is now 195 trades, `+12.56727646 USDT`
net, `22.69358785 USDT` attributed fees, PF 1.0597, maximum drawdown
`25.27218885 USDT`, top-three `+40.29533668 USDT`, and ex-top-three
`-27.72806022 USDT`. The rolling 48-hour window at that read is 109 trades and
`+7.93343303 USDT` net; since-QV3 is 92 trades and `+22.29150414 USDT` net.
The locked holdout is 15 trades and `+24.17587144 USDT` for A/C versus
`+23.99066095 USDT` for B/D. It still fails the pre-registered 20-trade minimum.

The latest complete flat account snapshot at `2026-09-13T04:57:01.665Z` reports
`119.48877351 USDT` total and available equity, no locked quote, no open cost,
and no unrealized PnL. The retained snapshot window begins at
`2026-09-12T02:56:08.917Z` with `112.22429307 USDT`; equity increased
`7.26448044 USDT` while positions closed in that interval report
`7.21893059 USDT` net. The `0.04554985 USDT` difference is left unclassified:
the database exposes no matching transfer/income ledger and its funding table
does not cover this period. It is not labelled bot profit.

## Live-trade reconstruction

The position ledger reports `-3.77867314 USDT` net over 193 trades. Attributed
automated fills contain `20.24174626 USDT` gross realized PnL and
`22.44539855 USDT` fees. One VET lifecycle lacks a complete attributed entry and
exit ledger, leaving a `-1.57502085 USDT` reconciliation difference; 46 fills
remain unattributed and are not silently assigned to the bot.

| Window/cohort | Trades | Net USDT | Fees USDT | PF | Max DD USDT | Top 3 USDT | Ex-top-3 USDT |
|---|---:|---:|---:|---:|---:|---:|---:|
| Available recent history | 193 | -3.779 | 22.445 | 0.982 | 25.272 | 35.655 | -39.434 |
| Latest 48 hours | 109 | -11.526 | 12.671 | 0.894 | 23.948 | 32.844 | -44.370 |
| Since QV3 cutover | 90 | 5.946 | 10.570 | 1.073 | 23.157 | 32.844 | -26.899 |
| PRE_QV3 | 103 | -9.724 | 11.875 | 0.925 | 18.796 | 28.268 | -37.992 |
| QV3 early | 46 | 10.701 | 5.414 | 1.237 | 11.110 | 32.844 | -22.143 |
| QV3 late development | 31 | -12.585 | 3.717 | 0.558 | 18.676 | 10.307 | -22.893 |
| Locked chronological holdout | 13 | 7.830 | 1.439 | 1.976 | 3.604 | 15.423 | -7.594 |

Overall there were 80 wins and 113 losses, 41.45% win rate, average win
`+2.586 USDT`, average loss `-1.864 USDT`, worst trade `-6.264 USDT`, and a
maximum 12-loss sequence. The concentration result is diagnostic rather than
an automatic rejection: QV3 can depend on large winners, but the non-top-three
burden is still large.

Sampled path evidence is explicitly not a complete MFE/MAE series. Of 113
losses, 64 never reached an *observed* +0.5%; 49 positions reached an observed
+0.5% and still ended non-positive; 87 had some observed profit and ended
non-positive. The sampled giveback aggregate is `424.314 USDT`, but sparse
observations make it an approximate path diagnostic, not true tick MFE.

Execution evidence: signal-candle-close to first fill median 64.319 seconds,
order-to-fill median 822 ms, entry order RTT median 960 ms, spread median 5.33
bp, and reference-close chase p90 45.01 bp. Chase buckets were not monotonic:
the 10–25 bp bucket retained major winners, so a generic chase cap was rejected.
Software-close detection-to-fill (native stops excluded) was 4.095 seconds
median and 7.205 seconds p90. Native-stop slippage relative to the stored stop
was -1.39 bp median and -17.18 bp p10, with a -348.53 bp worst gap event.

Same-symbol re-entry was a material pattern: 18 re-entries within 30 minutes
lost `-15.960 USDT`; 40 within 60 minutes lost `-25.047 USDT`; 20 entries within
60 minutes after a same-symbol loss lost `-19.427 USDT` (2 wins, 18 losses).
This was discovered after opening the available result set, so it is a new
prospective hypothesis, not an independently validated replacement candidate.

## Causal hypotheses and executable forms

| Problem | Information available then | Executable rule | Loss targeted | Profit at risk | Validation required |
|---|---|---|---|---|---|
| Old 15-minute momentum no longer progresses at the executable price | Completed 15m/5m returns, completed 5m reference close, final pre-order IOC limit | B: when 15m return is at least 2.5% and 5m return is at most 1.2%, block if IOC limit is not above the reference close (`V21_DECAY_NO_RECLAIM`) | No-continuation entries and two-sided fees | Reclaims immediately after the snapshot; the holdout KOMA winner was in fact removed | Frozen same-entry overlay plus independent chronological account replay and untouched/prospective holdout |
| A decelerated setup was admitted on a transient reclaim and then loses that premise | Immutable entry-time setup and reference, fresh executable bids with request/receive/book timestamps | C: after 180s, require three fresh bids below the stored reference, spaced 45–90s, then use the existing idempotent reduce-only close path (`V21_RECLAIM_FAILURE_3`) | Loss expansion after premise failure | Slow reclaim and later large trend | Same-entry comparison; account replay only when fresh quote timing exists; native-stop race/integration tests |
| Same-symbol retry after a loss repeatedly consumes released capital | Prior bot-owned close time/outcome and new signal symbol | Prospective candidate: suppress same-symbol entry for a fixed interval after a bot loss; do not affect manual positions | Observed repeated-loss clusters and repeated fees | 2 observed winners among the 20 post-loss re-entries, plus unobserved replacement opportunities | Freeze before collecting a new chronological window; independent account replay with slots/cash; no tuning on the 20 viewed trades |
| Profit is observed then returned | Entry-time policy stamp, fresh price path, R5/QV3 state, protection order state | No new generic lock promoted: preserve QV3/R5/native-stop hierarchy until a causal rule beats it | Giveback that occurs before the current exit | Large trend winners that fund the strategy | Dense path evidence, same-entry test, winner-value retention, native-stop conflict test, independent replay |

No hypothesis assumes every loss was avoidable. Future price and sampled MFE are
used only for outcome diagnosis, never as candidate inputs.

## Frozen candidates

- A — current production QV3/R5 behaviour.
- B — entry-only decay/no-reclaim block described above.
- C — exit-only three-observation reclaim-failure close. It is disjoint from B:
  C can manage only a qualifying setup admitted because its pre-order IOC limit
  was above the reference.
- D — B and C together.

The pure rules are deliberately side-effect-free. If they had passed, B would
have been called immediately before creating the existing entry order intent;
C state would have been stamped at the successful bot-owned LONG entry and its
close request routed through the existing lease/fencing, idempotent reduce-only
close, settlement, and protection-cancellation path. Existing positions would
retain their entry-time policy and protection floor. Because the promotion
decision is DEFER, those live-path edits were not made.

## Same-entry exit isolation and trade-overlay comparison

These results reuse actual entries and quantities. They can isolate C's exit
effect, but B/D do **not** model replacement trades, freed cash, or changed
slots, so their attractive full-sample result is not promotion evidence.

| Candidate | Trades | End equity | Net PnL | Delta vs A | Fees | PF | Max DD | Worst | Giveback | Ex-baseline-top-3 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A current | 193 | 96.221 | -3.779 | 0.000 | 22.445 | 0.982 | 25.272 | -6.264 | 424.314 | -39.434 |
| B entry | 174 | 114.897 | 14.897 | 18.676 | 20.182 | 1.081 | 25.272 | -6.264 | 383.080 | -20.758 |
| C exit | 193 | 99.814 | -0.186 | 3.593 | 22.447 | 0.999 | 24.595 | -6.264 | 420.426 | -35.841 |
| D combined | 174 | 118.490 | 18.490 | 22.269 | 20.183 | 1.102 | 24.595 | -6.264 | 379.192 | -17.165 |

B avoided 19 trades: `25.774 USDT` of losses and `7.098 USDT` of profits; it
retained all baseline top-three value in this already-viewed sample. C changed
five exits and converted no winner to a loss. With doubled fees/additional exit
impact, C delta remained `+2.701 USDT` and D delta `+21.377 USDT`. A 60-second
exit delay left C delta `+3.660 USDT`. These robustness checks do not cure the
holdout and account-replay failures.

### Locked holdout

| Candidate | Trades | Net PnL | Delta vs A | PF | Max DD | Modified |
|---|---:|---:|---:|---:|---:|---:|
| A | 13 | 7.830 | 0.000 | 1.976 | 3.604 | 0 |
| B | 12 | 7.645 | **-0.185** | 1.953 | 3.604 | 1 |
| C | 13 | 7.830 | 0.000 | 1.976 | 3.604 | 0 |
| D | 12 | 7.645 | **-0.185** | 1.953 | 3.604 | 1 |

B/D removed a profitable KOMA trade. C had no holdout trigger. The required
minimum was 20 closed holdout trades; only 13 existed. Retuning after observing
this result would contaminate the holdout and was not performed.

## Independent chronological account replay

Each A/B/C/D wallet starts at 100 USDT with 40 USDT target margin, 3x leverage,
10 slots, its own cash/positions/re-entry history, IOC partial fills, sampled L1
liquidity, exact 1-minute candles, QV3/R5/native-stop exits, fees, and adverse
same-candle ordering. Missing data preserves baseline or blocks a new
counterfactual fill.

| Scenario | Candidate | Trades | End equity | Net PnL | Fees | PF | Max DD | Worst |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Normal | A | 23 | 105.763 | 5.763 | 2.298 | 1.318 | 11.221 | -2.949 |
| Normal | B | 21 | 104.946 | 4.946 | 1.958 | 1.285 | 11.221 | -2.949 |
| Normal | C | 23 | 105.763 | 5.763 | 2.298 | 1.318 | 11.221 | -2.949 |
| Normal | D | 21 | 104.946 | 4.946 | 1.958 | 1.285 | 11.221 | -2.949 |
| Stress | A | 23 | 98.824 | -1.176 | 4.593 | 0.947 | 15.081 | -3.327 |
| Stress | B | 21 | 98.964 | -1.036 | 3.913 | 0.950 | 15.081 | -3.327 |
| Stress | C | 23 | 98.824 | -1.176 | 4.593 | 0.947 | 15.081 | -3.327 |
| Stress | D | 21 | 98.964 | -1.036 | 3.913 | 0.950 | 15.081 | -3.327 |

B/D underperform A by `0.818 USDT` in the normal account replay. Under stressed
costs every policy is negative. C cannot be identified in this replay: 29
normal-path management observations lack the quote request/receive RTT required
by the frozen freshness rule, so missing evidence correctly preserves A.

The 60-second entry-delay scenario produces only one trade for every candidate
(`+0.779 USDT`) and is not decision-supporting. Adverse-first and skip bounds
coincide in the exact common window. A second deterministic run, excluding the
generation timestamp, produced no diff.

Baseline fidelity is only 40%: 25 actual entries, 23 replay entries, 10 matches,
40% actual recall, 43.48% replay precision, and 26.05 bp p90 absolute matched
entry error. Actual window PnL was `-4.380 USDT` while baseline replay was
`+5.763 USDT`. The V18 observer is not an exact live-executor schedule, sampled
L1 cannot reconstruct every fill, and unavailable order/data-failure paths are
not inventable. This fails the frozen 99% fidelity gate.

## Funding, missing data, and attribution

Seven actual positions crossed a funding timestamp, all before QV3: DOGS,
TRUTH, EGLD (three lifecycles), EDGE, SAGA, and TAC. None has attributable
funding in the gathered ledger. The production-side historical funding table
ends before this window, recent forward snapshots contain no usable rows, and
the venue funding endpoint returned HTTP 451 for all 36 replay symbols.
Funding is therefore reported as unknown, never as zero realized cost. This
fails the gate requiring attribution for every crossing position.

The exact-candle common window stops before 2026-09-12 because later daily
archives were unavailable at collection time. No forward-fill or fabricated
candle was used. Scanner candidates and rejects are represented by 1,482 V18
frames (1,397 complete, 85 missing/stale), but they do not reproduce all live
executor timing and order failures.

## Rejected candidate families

The following were checked and were not renamed or resubmitted:

- PR #136 C1, unarmed two-bearish-below-entry: post-QV3 delta
  `-0.123 USDT`; apparent 48-hour gain reversed to `-21.328 USDT` over seven
  days and damaged LAB.
- C2, fresh-bid arm followed by two bearish bars: `-10.572 USDT`; damaged BEAT
  and CYS.
- C3 union: `-11.491 USDT`.
- `FAST_FAIL`, `EARLY_LOCK`, `VOL_TRAIL`, `COMBINED_R5`, `REPEAT_STOP_2`,
  `SPIKE_3PCT`, `COMBINED_ENTRY_SHADOW`, `LOCK_1P5`, generic reference exits,
  4–7 minute deadlines, and daily drawdown throttles were inferior, unstable,
  or damaged large winners.
- Simple volume-ratio, 15-minute-momentum, chase, and KST-hour filters were
  non-monotonic or sample/regime dependent.

## Verification executed

- Frozen candidate unit tests: 6/6 passed.
- Existing Node safety/integration suites: 120/120 passed, covering production
  module integration, partial fills, duplicate-close prevention, native-stop
  races, settlement delay, lease/CAS fencing, manual/unknown ownership, symbol
  isolation, and data gaps.
- Independent account replay deterministic rerun: passed.
- `git diff --check`: passed.
- Deno was unavailable in the local execution environment; no Deno test result
  is claimed.

Passing software tests means the research implementation behaves as specified;
it does not override failed financial validation gates.

## Frozen-gate disposition

| Gate | Result |
|---|---|
| Normal account net above A | **Fail**: B/D are 0.818 USDT below A |
| Stress candidate positive | **Fail**: best candidate is -1.036 USDT |
| Holdout delta positive | **Fail**: B/D -0.185; C 0.000 |
| Holdout at least 20 closed trades | **Fail**: 13 |
| Funding attributed for every crossing | **Fail**: 0/7 |
| Baseline fill/decision fidelity at least 99% | **Fail**: 40% agreement |
| Drawdown/worst trade/winner protections | No disqualifying degradation in the same-entry overlay, but insufficient to promote |

The required interpretation is **DEFER**. There is no validated integration
commit or deployment version to report. The live system must remain on its
existing QV3/R5 policy while genuinely new chronological evidence is collected.
The next candidate must be frozen before that evidence is opened; the strongest
new lead is a same-symbol post-loss cooldown, but its interval and gates cannot
be selected by repeatedly fitting the 20 already-viewed re-entries.
