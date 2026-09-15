# V24 — Real trade ledger reconstruction (2026-09-02 … 2026-09-15)

Source of truth is `exchange_trade_fills` (exchange-reported fills), **not** the
`realized_pnl_usdt` column on `v11_long_regime_positions`. Every number below is
rebuilt from fills and stated with its coverage.

## 0. Operational state verified (read-only)

| Item | Observed |
|---|---|
| Repo HEAD | `4faae3e` on `main` lineage |
| Deployed executor | `v10-lane-executor` **v44**, ACTIVE |
| Deploy ↔ repo parity | **byte-identical** — all 14 `_shared/*.mjs` and `index.ts` match HEAD |
| Executor revision | `V11-LONG-REGIME-1.0.1`, patch `V23-E1-X1-OPERATOR-OVERRIDE-1` |
| Entry policy | `LEADER_MOMENTUM_V17` + `E1_FAST_WEAK_RECOVERY_OVERRIDE_1` |
| Exit policy | `V17_EXIT_R5_TAIL` + `QV3_ENTRY_EXIT_TWO_1` + `X1_FAST_OBSERVATION_OVERRIDE_1` |
| New entries | **enabled** (`v17_operator_control.entry_enabled = true`, since 2026-09-08) |
| Runtime | `live_enabled=true`, `circuit_open=false`, protection_health `FLAT` |
| Sizing | margin 40 USDT × leverage 3 = **120 USDT notional**, 10 slots |
| Native exchange stop | `V17_NATIVE_STOP` gated by env, default OFF |

## 1. Ledger coverage

| | |
|---|---|
| Window | 2026-09-02 05:22Z … 2026-09-15 06:53Z (13.1 days) |
| Automated futures fills | 2 129 |
| Fills linked to a V17 position | 1 371 |
| Positions with linked fills | 271 |
| **Positions with matched buy/sell quantity (usable)** | **269** |
| Distinct symbols traded | 105 |
| Maker fills | **0** (100 % taker) |

### Two positions excluded, and why

`VETUSDT` (2026-09-10) and `哈基米USDT` (2026-09-15) each carry BUY fills with **no
linked SELL fills**. Their DB rows are `state=CLOSED, remaining_quantity=0`, so the
positions did close — the exit fills exist but were never attributed to
`v17_position_id`. Counting them naively produces a fabricated −120 USDT loss each
and drags the reported net from −38.9 to −279.0 USDT. They are **attribution gaps,
not losses**, and are excluded from performance and listed as a reconciliation defect.

### Ledger defects found

1. **Fill→position attribution gap** — 2 positions with orphaned exit fills.
2. **`realized_pnl_usdt` disagrees with fills.** DB column sums to −45.1 USDT over the
   same 271 positions; fills say −279.0 (or −38.9 excluding the two gaps). The column
   is not a reliable P&L source.
3. **Funding is not recorded anywhere.** `trading_cash_flows` holds only
   `EXTERNAL_INCREASE/DECREASE` and `MANUAL_POSITION_REDUCTION`; there is **no
   `FUNDING_FEE` row** for the futures account. Realised funding is therefore
   unmeasured. Median hold is ~15 min so the expected magnitude is small, but
   "small" is an estimate, not an observation.
4. **Accounting stuck in PENDING** — of the fills since 2026-09-02, 1 369 are
   `accounting_status='PENDING'` and only 2 are `ACCOUNTED`; 46 are
   `UNMATCHED_INVENTORY`.

## 2. Measured performance (269 matched round trips)

| Metric | Value |
|---|---|
| Gross P&L (before fees) | **−7.40 USDT** |
| Fees paid | **−31.51 USDT** |
| **Net P&L** | **−38.90 USDT** |
| Win rate | 42.0 % (113 / 269) |
| Average win | +2.14 USDT |
| Average loss | −1.80 USDT |
| Profit factor | **0.862** |
| Median hold | ~15 min (avg 918 s) |
| Avg fills per round trip | 5.08 |

**The single most important fact: gross edge is approximately zero, and the entire
loss is transaction cost.** −7.40 USDT of gross over 269 trades is −0.27 bps per
trade on 120 USDT notional. Fees alone are −9.76 bps per round trip.

### Measured cost basis (not a rate card)

| | |
|---|---|
| Realised fee | **5.000 bps per side**, min 4.980 / max 5.000, across 1 417 fills |
| Maker fills | 0 — every fill was taker |
| Entry spread at signal | median 4.22 bps, mean 4.64, p90 8.76 |
| IOC aggression above ask | mean 4.74 bps |
| **Round-trip cost floor** | **≈ 15 bps** (10 fee + ~5 crossing) |

Any entry rule must therefore produce **> ~15 bps of expected gross move** just to
break even. That is the bar the current entry rule does not clear.

## 3. Where the money actually goes

By exit reason (269 matched trades):

| Exit reason | n | Net USDT | Avg gross bps | Wins |
|---|---:|---:|---:|---:|
| `V17_NATIVE_STOP` | 150 | −31.35 | −11.0 | 55 |
| `QV3_TWO_BEARISH_CLOSED` | 72 | **+12.80** | **+24.2** | 38 |
| `V17_TRAILING_STOP` | 10 | **+35.50** | **+305.9** | 9 |
| `V17_HARD_STOP` | 10 | **−41.66** | **−337.2** | 0 |
| `RANGE_MICRO_TIME_EXIT` | 7 | +0.77 | +19.2 | 6 |
| `V17_MOMENTUM_STALE` | 5 | −3.05 | −40.9 | 1 |
| `MICRO_HARD_STOP` | 5 | −3.46 | −47.7 | 0 |
| `V17_RISK_CUT` | 4 | −7.11 | −138.2 | 0 |
| others (5 reasons) | 6 | −1.35 | — | 4 |

By gross return bucket:

| Bucket (bps) | n | Net USDT | Reading |
|---|---:|---:|---|
| −294 … −250 | **34** | **−103.73** | the flat −2.5 % `stopPct` cluster |
| −250 … −202 | 14 | −40.96 | |
| −137 … −105 | **43** | **−65.32** | the R5 `riskCutLevelPct` −1.2 % cluster |
| −99 … −3 | 41 | −26.87 | fee-scale scratches |
| 0 … +48 | 48 | +6.29 | fee-scale scratches |
| +101 … +140 | 24 | +30.88 | |
| **+408 … +1275** | **14** | **+117.18** | the trend tail the thesis is built on |

**The continuation thesis has real signal.** 14 trades earned +117 USDT by running
past +4 %. The strategy then gives it all back through two loss clusters (−169 USDT
across 77 trades) and ~222 near-zero trades each paying ~12 bps of fees.

## 4. Live-code vulnerabilities — verified against the deployed v44 source

Each finding was traced to the actual call path, not inferred from a name.

| | Claim | Verdict | Evidence |
|---|---|---|---|
| **A** | Entry admits on "not strongly weak" rather than positive evidence | **CONFIRMED** | `leader-e1-runtime.mjs` `isFastWeak()` defers only when `return10s < −0.002` **AND** `buyShare10s < 0.45`. Everything else passes. There is no condition requiring buying to be *winning*. |
| **B** | A 10-second window overrides multi-minute weakness | **CONFIRMED** | E1 reads `fetchE1AggTrades(end−10_000, end)`; `blockMs` 5 s, `watchMs` 30 s. No 60 s or 180 s aggregate exists anywhere in the entry path. |
| **C** | The book is used only for fillability, never for flow | **CONFIRMED** | `e1QuoteEvidence()` derives `depthVwap` and `expectedCostBps` only. No queue-replenishment, no imbalance, no depth time-series. |
| **D** | Expected cost is recorded but does not gate entry | **CONFIRMED** | `expectedCostBps` is computed and written into `request_payload.e1`, but no branch in `index.ts` compares it to an edge or refuses on it. Admission uses `guardPassed`/`liquidityPassed` (spread ≤ 25 bps, full depth) only. |
| **E** | Profit-lock arms late relative to profit earned | **PARTLY** | R5 arms the lock at +2 % of a 2.5 % stop = 0.8 R and captures 50 %, which is not late in R terms. The real gap is that below +1 % MFE **the only protection is the −2.5 % stop**, which is where 34 trades / −103.7 USDT died. |
| **F** | A normal pullback and a failed entry share one flat stop | **CONFIRMED** | `POLICY.stopPct = 0.025` is applied identically to every symbol regardless of ATR or structure. R5's risk cut needs +1 % MFE **or** 10 minutes to arm, so a trade that falls straight from entry rides the full −2.5 %. |
| **G** | Exit overlays conflict / run on a shorter horizon than entry | **CONFIRMED** | Entry is a 15 m rank + closed-5 m confirmation. Exits are R5 (quote-polled), QV3 two-bearish **1 m** closes, X1 fast observation at **1 s**, RANGE_MICRO, and a native stop. QV3's 1 m rule closes a position whose thesis was formed on 5–15 m data. |
| **H** | An unvalidated operator override runs as if validated | **CONFIRMED** | `OPERATOR_OVERRIDE = {basis:'OPERATOR_OVERRIDE_UNVALIDATED', priorPerformanceVerdict:'DEFER', parametersValidatedByBacktest:false}`; `QV3_ACTIVATION_BASIS='OPERATOR_OVERRIDE_PROTOCOL_DEFER_20260911'`. Three policies (E1, X1, QV3) are live with research verdict **DEFER**. |

Note on H: QV3 is the *best performing* overlay in the ledger (+12.8 USDT over 72
trades, +24.2 bps avg). Its status as an unvalidated override is a process finding,
not evidence that it is harmful.

## 5. What this implies for the three rules

1. **Entry** must add positive-evidence confirmation and a cost gate. The problem is
   not that entries lose — it is that ~222 of 269 are coin-flips paying 12 bps.
2. **Take-profit** must keep the +408…+1275 bps bucket intact. Any change that
   truncates the runner destroys the only positive contribution in the ledger.
3. **Stop-loss** must break up the −294…−250 bps cluster with a structural,
   volatility-aware initial stop and an early-failure path, without widening the
   allowed loss on the trades that do work.

## Reproduction

```sql
-- matched round trips, rebuilt from exchange fills
with f as (
  select v17_position_id pid,
    sum(case when side='BUY'  then quantity*price else 0 end) bn,
    sum(case when side='SELL' then quantity*price else 0 end) sn,
    sum(coalesce(fee_quote_amount,0)) fees,
    sum(case when side='BUY'  then quantity else 0 end) bq,
    sum(case when side='SELL' then quantity else 0 end) sq
  from exchange_trade_fills
  where exchange='binance_futures' and v17_position_id is not null
  group by 1)
select count(*), sum(sn-bn) gross, sum(fees) fees, sum(sn-bn-fees) net
from v11_long_regime_positions p join f on f.pid=p.id
where abs(f.bq-f.sq) <= greatest(1e-9, f.bq*1e-8) and f.bq > 0;
```
