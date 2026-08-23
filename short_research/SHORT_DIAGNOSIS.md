# Why the SHORT side produces zero signals

**Answer: both SHORT paths are vetoed by the benchmark 72-hour return, before any symbol
is examined.** It is not a bug and not a per-symbol filter — it is the benchmark gate.

## The evidence

Over the 24h to 2026-08-23 09:04 UTC the Binance USDⓈ-M universe was strongly bearish:

| | |
|---|---|
| universe scanned | 527 perpetuals (deep_analyzed 527, errors 0) |
| down / up | **444 (84.3%)** / 83 |
| ≤ −3% / ≤ −5% / ≤ −10% | 281 / 145 / 18 |
| median 24h return | **−3.30%** |
| SHORT signals emitted | **0**, across 12+ consecutive hourly runs |

BTC's own 24h return was −0.768%, so the *24h* benchmark condition passes. The 72h one does not.

## The gate

From the deployed `market-v2-signal` (`i46Check`, `d = −1` for SHORT):

```js
if (d*s.ret24Pct < -.50 || d*s.ret72Pct < -2 || ...) return null;
```

`d*ret72 < −2` is equivalent to **`ret72_BTC > +2%` blocks every SHORT**.

Using only observed snapshot prices (`v2_live_universe_snapshots`, 68 BTC snapshots spanning
64.1h), BTC's 72h return at the latest snapshot is bracketed:

| | price | note |
|---|---|---|
| now, 2026-08-23 09:04 | 76,542.5 | |
| 64.1h earlier, 2026-08-20 16:56 | 72,677.6 | oldest snapshot |
| ~88h earlier (implied by that row's own +6.006% 24h return) | 68,559.9 | |

The 72h-ago price lies between those two, so

> **BTC ret72 ∈ [+5.32%, +11.64%]** — both bounds far above the +2% veto threshold.

Therefore `d*ret72` ∈ [−11.64, −5.32], which is `< −2`, so `i46Check` returns `null` for
SHORT on **every symbol on every bar**. No per-symbol gate (volume, RSI, close location,
ATR, hybrid score) is ever reached.

The retired P10 SHORT is blocked by the same quantity: its regime gate requires
`ret72 ≤ 0`, and ret72 ≥ +5.32%.

## Why this matters structurally

BTC rallied from ~68.5k to ~78.5k between 2026-08-20 and 2026-08-21, then rolled over. The
last 24h were sharply down while the 72h window still contains the rally.

That is the general case, not a coincidence: **a sharp selloff that follows a multi-day rally
is exactly when a 72-hour benchmark return is still positive.** The gate therefore vetoes
SHORT precisely in the setup where SHORT is most valuable, and only permits it once the market
has been falling long enough for the 72h window to clear — by which time the move is mature.

This is a design property of the entry gate, not a defect in execution. The SHORT code path is
live and reachable (confirmed: `permitted = venue === "binance_futures" ? ["LONG","SHORT"]`,
and the executor accepts SHORT); it simply never receives a signal.

## When the gate would next open

SHORT needs `ret72_BTC ≤ +2%`, i.e. the price 72h ago must be at least `76,542 / 1.02 ≈ 75,041`.
BTC first traded above that level around 2026-08-21 05:00–06:00 UTC, so — holding price roughly
flat — the veto lifts around **2026-08-24 05:00–06:00 UTC**.

## What the frozen 50-strategy run must settle

This diagnosis is why the study matters, and it is deliberately *not* pre-judged here:

1. S01 (live I46 + P10 exit) should produce ~0 trades in PRIMARY for exactly this reason.
   If it does, that confirms the diagnosis on candle data rather than on ticker snapshots.
2. S02 (retired P10 symmetric) should also produce ~0, for the same reason.
3. **S25 (regime-agnostic) and S02-family variants with the regime gate removed or replaced
   are the ones that answer the real question:** with the benchmark veto lifted, is there
   net-profitable, executable SHORT edge in this 24h — after fees, funding, slippage and the
   shared slot pool — or does the veto happen to be protecting the book?
4. S21 (benchmark bearish by magnitude), S23 (BTC+ETH), S24 (breadth) test whether a
   *different* market gate captures the opportunity without the 72h blind spot.

No parameter is changed in response to this finding: the definitions were frozen and hashed
(`ccf2b46cb6b282a32e5031e89d2bf6bb99c8af4b87c2a29726ebc1c9e26a1088`) and already contained
regime-free and alternative-regime variants precisely so this question could be answered
without retuning.

## Caveat

The bracket above comes from 24h-ticker snapshots, not hourly candles: it bounds BTC's 72h
return rather than reproducing `ret72Pct` bar by bar. The bound is wide enough that the
conclusion does not depend on the precision, but the frozen dataset will let the exact
per-bar value be recomputed and this diagnosis confirmed or corrected.
