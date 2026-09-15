# V24 — Does "today's top gainers keep going up" actually hold?

The central hypothesis of the strategy is **당일 상승률 상위 종목의 추가 상승 모멘텀**:
that a Binance USDT-perp which is among today's biggest KST-day gainers tends to keep
rising. This document tests that directly, on the full market, before any of the
finer entry machinery is applied.

**Result: the hypothesis does not hold in this window. It is reversed.**

## Data

| | |
|---|---|
| Universe | 654 USDT perpetuals, `underlyingType=COIN` (526 TRADING + 128 SETTLING) |
| Excluded | 155 EQUITY + 15 HK_EQUITY + 8 COMMODITY + 8 KR_EQUITY + 2 CN_EQUITY + 2 PREMARKET + 2 INDEX `TRADIFI_PERPETUAL`, USDC/USD1/BTC-quoted, dated futures |
| Bars | 2 017 617 closed 15m klines, `fapi.binance.com/fapi/v1/klines` |
| Window | 2026-08-14 … 2026-09-15 (32 d; 31 rankable KST days from 2026-08-15) |
| Rank panel | 117 640 point-in-time rows (top 40 per 15m bar), 551 distinct symbols |
| Fetch errors | 0 (after percent-encoding non-ASCII symbols — Binance lists CJK pairs and the live bot has traded them) |
| **Market backdrop** | **BTCUSDT +22.19 %** over the window — a bull market, not a bear alibi |

`SETTLING` contracts are included because they were tradable during the window;
dropping them would build survivorship bias in. Symbols fully removed from
`exchangeInfo` before the capture date remain unobservable — a disclosed limitation.

## Panel validation against ground truth

The reconstructed point-in-time rank was checked against what the live bot actually
acted on, for every real entry in the window:

| | |
|---|---|
| Live entries with a recorded rank | 259 |
| Matched in the reconstructed panel | 258 |
| **Reconstructed rank ≤ 10** | **258 / 258 (100 %)** |
| Exact rank match | 256 / 258 |
| Mean abs. rank difference | 0.01 |
| Mean abs. day-return difference | 0.00020 (2 bps) |

Production entered only at rank ≤ 10, and the reconstruction independently places all
258 of those entries at rank ≤ 10. The panel reproduces what the executor saw.

## Test 1 — Unconditional forward return by rank

Rank is known at bar close `t`; the first tradable price is the **open of bar `t+1`**.
No part of the entry price is information published after the decision.

| Rank bucket | n | fwd 15m | fwd 1h | fwd 3h | win @1h |
|---|---:|---:|---:|---:|---:|
| 1–3 | 8 820 | −2 bps | **−9 bps** | −3 bps | 47.7 % |
| 4–5 | 5 880 | −4 bps | **−11 bps** | −26 bps | 46.9 % |
| 6–10 | 14 700 | −3 bps | **−7 bps** | −23 bps | 46.1 % |
| 11–20 | 29 393 | −1 bps | −2 bps | −6 bps | 45.6 % |
| 21–30 | 29 355 | −1 bps | −1 bps | −3 bps | 45.7 % |

Being a top-10 day gainer carries **negative** forward return at every horizon, and it
is *more* negative than lower ranks. There is no continuation premium to harvest; if
anything the gradient runs the wrong way.

## Test 2 — Does conditioning rescue it?

Restricted to rank ≤ 10 and `dayReturn ≥ 3 %` (production's own gate):

| RVOL15 | last 15m | n | fwd 15m | fwd 1h | win @1h |
|---|---|---:|---:|---:|---:|
| < 1.5 | down | 2 815 | +1 bps | −6 bps | 48.6 % |
| < 1.5 | up | 3 896 | −5 bps | −15 bps | 46.1 % |
| ≥ 1.5 | down | 8 710 | −6 bps | −6 bps | 48.5 % |
| **≥ 1.5** | **up** | **13 237** | **0 bps** | **−9 bps** | **45.4 %** |

The cell the strategy actually trades (volume accelerating, price rising) is the one
with the *lowest* win rate. No cell comes close to the **≈15 bps** round-trip cost
measured from this account's own fills.

## Test 3 — Payoff distribution (the test that matters for a trend strategy)

A trend strategy does not need a positive mean at a fixed horizon; it needs right skew
that an asymmetric exit can harvest. Over 12 forward 15m bars (3 h), from the first
tradable open, rank ≤ 10 and dayReturn ≥ 3 % (n = 28 658):

| | |
|---|---|
| Average MFE | +579 bps |
| Average MAE | −525 bps |
| Reach +2 % | 65.8 % |
| Reach +4 % | 43.6 % |
| Reach +8 % | 20.7 % |
| Reach −1.5 % | **80.0 %** |
| Reach −2.5 % | **66.7 %** |

The moves are large in both directions — so the skew alone settles nothing. What
settles it is **which level is touched first**.

## Test 4 — First-touch race (decisive)

First bar whose high reaches the target vs. first bar whose low reaches the stop. When
the same bar touches both, the order is unknowable at 15m resolution and is scored
**conservatively as the stop hitting first**.

3-hour horizon:

| TP / SL | TP first | SL first | neither | **break-even TP-first needed** |
|---|---:|---:|---:|---:|
| 2.0 % / 1.5 % | 36.9 % | 60.8 % | 2.2 % | **57.1 %** |
| 4.0 % / 1.5 % | 22.3 % | 71.3 % | 6.4 % | **72.7 %** |
| 4.0 % / 2.5 % | 29.8 % | 56.9 % | 13.3 % | **61.5 %** |
| 6.0 % / 2.5 % | 19.6 % | 61.4 % | 19.0 % | **70.6 %** |
| 8.0 % / 2.5 % | 13.5 % | 63.7 % | 22.9 % | **76.2 %** |

1-hour horizon (closer to the 15-minute median live hold):

| TP / SL | TP first | **break-even needed** | neither |
|---|---:|---:|---:|
| **1.0 % / 1.0 %** | **36.3 %** | **50.0 %** | 2.4 % |
| 1.5 % / 1.0 % | 30.1 % | 60.0 % | 4.7 % |
| 2.0 % / 1.5 % | 32.6 % | 57.1 % | 12.4 % |
| 3.0 % / 2.0 % | 25.8 % | 60.0 % | 25.6 % |

**Every configuration falls far short of break-even — typically by 25–50 percentage
points — before costs.**

The symmetric 1 % / 1 % row is the cleanest possible read on directional edge: a
top-10 day gainer touches −1 % **before** +1 % in **63.7 %** of cases. Over this
window these names are short-term **mean-reverting**, which is the opposite of the
hypothesis the strategy is built on.

### Robustness of the conservative tie-break

Same-bar ties are only **1.9 %** of cases. For 4 % / 2.5 %, TP-first is 29.8 %
(conservative) vs 31.7 % (optimistic) against the 61.5 % needed. The conclusion does
not depend on the tie-break rule.

## Why this matches the live ledger exactly

The live account traded this hypothesis 269 times and produced **−7.40 USDT gross,
−31.51 USDT net** — roughly −0.27 bps of gross edge per trade. That is precisely what
Tests 1–2 predict: a gross edge indistinguishable from zero (slightly negative),
turned into a loss by ~15 bps of round-trip cost. The live result is not bad luck or
a broken exit; it is the base rate of the entry hypothesis.

It also explains the ledger's shape. 66.7 % of entries reach −2.5 % within 3 h, which
is why the −2.5 % flat stop is the single largest loss cluster (34 trades, −103.7
USDT), and 43.6 % reach +4 %, which is why a small tail of trailing exits
(14 trades, +117 USDT) looks so good in isolation. Both are properties of the
underlying distribution, not of the exit rules.

## What this does and does not establish

**Established**, on 31 days of full-market data with a validated point-in-time panel:
- The top-10 KST day-gainer LONG continuation premium is absent, and mildly reversed,
  at 15m decision resolution over 2026-08-15 … 2026-09-15.
- It is absent in a **+22 % BTC bull market**, so a bearish backdrop does not excuse it.
- No tested TP/SL pairing produces a break-even first-touch rate.

**Not established** — these remain genuinely open:
- Whether a *sub-15-minute* entry filter (1m setup structure, real 10s/60s/180s
  aggressive-flow, live order-book imbalance) isolates a positive subset. Klines
  cannot answer this: there is no historical depth, and kline `takerBuyQuote` is a
  1-minute proxy, not a 60-second tape.
- Whether the result is specific to this 31-day regime. One month is one regime.
- Whether the SHORT side of the same ranking carries the mirrored edge. Not tested —
  and out of scope, since this work is Binance USDT-perp LONG only.

## Consequence for the deliverable

A new entry rule must not be promoted to live trading on this evidence. The
measured base rate is negative before costs, and the proposed V24 entry gates are
refinements *within* that base rate, not a different population. Better exits can
reduce the bleed, but they cannot manufacture a positive expectancy from an entry
distribution whose first-touch race is 30 % against a 62 % requirement.

## Reproduction

```sql
-- Test 4, 3-hour horizon, conservative tie-break
with base as (
  select p.t, p.symbol, e.o entry_open
  from public.v24_rank_panel p
  join public.v24_k15 e on e.symbol=p.symbol and e.t = p.t + 900000
  where p.rank <= 10 and p.day_return >= 0.03 and e.o > 0
), race as (
  select b.*,
    (select min(k.t) from public.v24_k15 k where k.symbol=b.symbol
       and k.t >= b.t+900000 and k.t < b.t+13*900000 and k.h >= b.entry_open*1.04) t_tp,
    (select min(k.t) from public.v24_k15 k where k.symbol=b.symbol
       and k.t >= b.t+900000 and k.t < b.t+13*900000 and k.l <= b.entry_open*0.975) t_sl
  from base b)
select count(*) n,
  round((count(*) filter (where t_tp is not null and (t_sl is null or t_tp < t_sl)))::numeric*100/count(*),1) tp_first_pct
from race;
```
