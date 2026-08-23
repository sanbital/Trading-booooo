# SHORT research methodology

## What is settled and what is pending

Settled in this session, from production sources and live data:

- Production source secured and hash-verified (deployed `market-autotrader` v360,
  `ezbr_sha256 c0f59c6d…`, 52 files, byte-identical to repo commit `ae4379c`).
- Production LONG (P10) extracted in full — see `production_long_spec.json`.
- The Python replay engine is **bit-exact** with the deployed policy module: 5,200 indicator
  comparisons and 300 benchmark-regime states with zero deviation, and 885 per-bar signal
  verdicts with zero mismatches (`engine/parity/`).
- S01..S50 defined and frozen **before** any market data was loaded, hashed to
  `4607b5c1538baa72b4fc03801c3908331b238487ff0533c6f937f09847635a30`.
- Engine, portfolio replay, metrics and leakage tests written and passing (15 tests).

Pending external input: the Binance OHLCV/funding dataset (`DATA_REQUEST.md`). The research
environment cannot reach `fapi.binance.com`; the organisation egress proxy answers 403 to
CONNECT, and its own guidance is to report a policy denial rather than route around it. The
project database holds aggregated results and 24h ticker snapshots but **no raw candles**, so
the 50-strategy backtest genuinely needs the frozen dataset. Everything that does not depend on
it is finished.

## Freeze discipline

The 50 definitions were written from the production LONG spec alone. No PRIMARY result informed
them, because no market data existed when they were hashed. After the dataset arrives, the
definitions are not edited: no strategy is retuned, dropped for being unprofitable, or added.
A strategy that throws is a code fix followed by a re-run of the *same* definition;
`test_engine.py::test_exactly_50_and_hash_matches` fails the suite if the file changes.

## Why these 50 are structural, not a parameter sweep

Thirty of the fifty change *what triggers an entry* — Donchian breakdown lineage, retest and
failed-reclaim patterns, momentum and EMA structure, volatility and volume states, regime
gating, and guards on overextension, crowding and liquidity. The remaining twenty pin the entry
to S01 and change *how the trade is managed* — fixed R targets, trailing mechanisms, stop
placement, partial sizing, time limits, momentum and regime reversal exits. Pinning the entry
is deliberate: it is the only way to attribute an exit effect rather than confound it with a
different trade population.

## Execution model

Chosen to match production, not to flatter results.

| Question | Choice | Why |
|---|---|---|
| Which bars are visible? | Closed bars only | Production drops the in-progress candle via `floor(now/1h)*1h - 1` |
| Where does entry fill? | Next bar's open | Production's `nextBarEntry`; never the signal bar's close |
| Entry rejected when? | `\|entry − referenceClose\| / atr14 > 0.50`, or initial risk > 5% | Mirrors `planP10Entry` |
| Stop and target in one bar? | Stop wins | `evaluateP10Exit` returns STOP before TARGET_2/TARGET_1, and the intrabar path is unknown |
| When do trail and rule exits update? | Only on a closed bar | Mirrors the `bar.time > lastPolicyBarTime` guard |
| Intrabar-trigger entries (S05)? | Fill at the trigger, evaluate exits from the *next* bar | No intrabar path data exists; assuming a same-bar exit would invent one |

Costs are unconditional: taker fee both sides on notional, slippage in basis points against
both fills, and funding on every settlement stamp a position spans (a SHORT receives when the
rate is positive). Slippage is embedded in fill prices and reported separately — it is not
subtracted twice.

Sizing reproduces production: 60 USDT margin per slot at 3× leverage, quantity floored to
`stepSize`, rejected below `minQty` or `minNotional`, prices rounded to `tickSize`.

## Portfolio replay

Summing per-symbol trades would let the book hold positions production could never hold, so
signals are replayed in time order under the live constraints: one active position per symbol,
a shared slot pool (shared with LONG in the combined model, never LONG *N* + SHORT *N*), at most
`max_new_entries_per_scan = 3` opened at any one timestamp, and a per-symbol cooldown. Order
within a timestamp is deterministic: score first, then symbol.

## Leakage controls

The strongest test is truncation equivalence: a signal computed with the dataset cut at bar *k*
must equal the signal computed for bar *k* from the full dataset. Any forward-reaching window,
a Donchian channel that includes the current bar, or an exit that peeks ahead breaks it. It is
tested for indicators and for signals, alongside: the Donchian channel excluding the current
bar, entry pinned to the next bar's open, and a tamper test that rewrites every bar after a
signal and asserts the entry decision is unchanged.

## Windows

All four run from one frozen dataset, so nothing is re-collected between them:
PRIMARY = last 24h, PRIOR = the 24h before it, plus 72h and 7d. The window bounds the *signal*
bar, not the exit; a trade opened inside the window is allowed to run to its own exit, and a
trade still open at the end of the data is closed at the last bar and tagged `DATASET_END` so
truncation is visible rather than hidden.

## Ranking

Ranking is deferred until all 50 have run. Score weights: net return 25%, max drawdown 20%,
profit factor 15%, expectancy 15%, robustness across the validation windows 10%, MFE/MAE 5%,
symbol concentration 5%, implementation risk 5%. A strategy whose profit is one or two symbols,
or that only works on one parameter point, is marked down rather than promoted.
