# V17 entry blockers, 2026-09-09

Two things were stopping V17 entries that had nothing to do with the exit policy. They were
found while verifying the R5 deploy, by grouping `v11_long_regime_signals.reject_reason`
over the KST day.

| reject_reason | count |
|---|---|
| `SIGNAL_STALE_OR_FUTURE` | 44 |
| `ENTRY_MARGIN:…` | ~45 |
| `GW_400: only Binance USDT spot symbols are allowed` | 23 |
| `IOC_NO_FILL:CANCELED` | 9 |
| (FILLED) | 17 |

## 1. Non-ASCII symbols were unreachable — a real bug, now fixed

Binance lists USDⓈ-M perpetuals whose symbol is not ASCII: `牛来USDT`, `哈基米USDT`,
`币安人生USDT`, `我踏马来了USDT`, `龙虾USDT`.

The V17 scanner **deliberately includes them** — `activeSymbols()` in
`leader-momentum-v17.mjs` excludes only whitespace and URL delimiters (`/[\s/?#]/`), not
non-ASCII. They ranked, they confirmed, signals were written… and then every single order
was refused at the gateway. Over 2026-09-08/09 that cost **23 signals**, on the two symbols
that were among the day's strongest movers:

| symbol | signals blocked | price over the window |
|---|---|---|
| 牛来USDT | 16 | 0.09465 → 0.12249 (**+29%**) |
| 哈基米USDT | 7 | 0.04162 → 0.04321 |

`牛来USDT` was **rank 1 in the live scanner at +39.4% on the day** and V17 structurally
could not buy it.

The exchange has no objection. Percent-encoded, it answers normally:

```
GET /fapi/v1/ticker/price?symbol=%E7%89%9B%E6%9D%A5USDT
→ {"price":"0.1192700","symbol":"牛来USDT"}
```

Nor does the transport: `binanceQueryString()` builds the payload with
`encodeURIComponent`, `createBinanceSignature()` signs **that same payload**, and the URL is
assembled from it. Signature and request cannot disagree, so non-ASCII was always safe to
send. The only obstacle was three hand-written `[A-Z0-9]` allow-lists:

| file | validator | effect if left unfixed |
|---|---|---|
| `gateway/server.mjs` | `validateBinanceSymbol` | the 23 GW_400 entry rejections |
| `supabase/functions/_shared/leader-exit-review.mjs` | `protectiveStopSpec` | position opens, native stop cannot be placed |
| `gateway/v17-stop-commands.mjs` | stop identity | native stop refused at the gateway |

All three now use `/^[\p{L}\p{N}]{…}USDT$/u`. This is still an allow-list — Unicode letters
and digits only — so whitespace, `/ ? # & = %`, quotes, control characters, combining marks
and emoji all remain rejected. The USDT suffix requirement is unchanged.

**All three had to change together.** Fixing only the gateway would let V17 open a position
it could never attach an exchange-resident stop to.

### Was it worth unblocking?

Replayed on Binance 1m klines. The 23 signals collapse to **8 entries** under the executor's
own spacing rules, and under R5 they are worth **+7.30 USDT** (5/8 wins, expectancy +0.91,
worst −3.21 — the ordinary stop-out, so no extra tail risk per trade):

| | trades | wins | net | worst | expectancy |
|---|---|---|---|---|---|
| V17 current ladder | 8 | 6 | +1.60 | −3.21 | +0.20 |
| **R5** | 8 | 5 | **+7.30** | −3.21 | **+0.91** |

For scale, V17's entire realised day was +4.15 USDT. Eight trades is a small sample and
these are violent meme listings — but the change is not "start trading something riskier",
it is "stop a transport regex from vetoing symbols the strategy already selected and the
exchange already accepts".

## 2. `ENTRY_MARGIN` was NOT a bug — the gate was right

An earlier reading of this called it the day's biggest entry blocker and implied it needed
loosening. That was wrong, and the account snapshots say so.

`locked_quote` sat at **95–99 USDT** from 15:00 on 09-08 until 11:20 on 09-09, against
equity of 69–113. Only ~40 of that was V17's one slot; the rest was the **manual MAGMAUSDT
position**. Available margin was therefore 1–15 USDT and a 40 USDT slot genuinely could not
be funded.

MAGMAUSDT closed at 11:20:09. The last two `ENTRY_MARGIN` rejections are 11:15 and 11:20.
**Zero since.** `locked_quote` dropped to ~40 and available to ~65.

So the gate did exactly its job: it refused to open a position the account could not fund.
Loosening it would risk liquidation. **The threshold is unchanged.**

### What *was* wrong: the failure mode

`openBull` **threw** on insufficient margin. Two consequences, neither intended:

1. The exception escaped `run()`, so the whole executor cycle returned 500 and set
   `last_error` — on a condition the operator cannot act on and that is not a fault. It also
   masks real errors and suppresses `last_success_at`.
2. The signal had already been claimed, so the catch marked it `REJECTED`. A still-fresh
   signal was burned even if a slot freed up seconds later, inside its own 120s entry window.

Now it returns `{entered:false, reason:'ENTRY_MARGIN_INSUFFICIENT:<avail>:<needed>', releaseClaim:true}`
and `run()` hands the claim back `CLAIMED → NEW`. The entry still does not happen. An
unreadable balance (`available_quote` not finite) remains a hard fault —
`ENTRY_AVAILABLE_BALANCE_UNREADABLE` — because that is a real data failure.

This will matter again: at ~105 USDT equity and 40 USDT per slot the account funds about two
concurrent positions, so the condition recurs whenever both slots are full.

## 3. Not addressed

`SIGNAL_STALE_OR_FUTURE` (44) is the largest single reject reason. Signals expire against
`maxEntryAgeMs = 120s` between generation and the executor claiming them. That is a cadence
question — how quickly the executor follows the generator — and is left alone here.
