# V10 research basis

Frozen at 2026-08-30 UTC before candidate selection. V6-V9 final-test results are
historical evidence only and are not inputs to V10 selection.

## Point-in-time data inventory

| Source | Discovery data used | Causal fields | Production availability | V10 treatment |
|---|---|---|---|---|
| Binance USD-M public archive | 15-minute futures klines, Jan-Oct 2025 | completed OHLCV, quote volume, trade count, taker-buy base/quote volume | REST/WebSocket equivalents exist | 21 assets; only bars before 2025-10-08 enter discovery metrics |
| Upbit public REST | 15-minute KRW candles, Jan-Oct 2025 | completed OHLCV and quote volume | REST/WebSocket equivalents exist | exact UTC joins; missing no-trade candles remain missing and force no signal |
| Binance live APIs/streams | current spot/futures klines, trades, aggregate trades, depth/book ticker, mark/index/premium, funding, OI and positioning endpoints | potentially causal at receipt time | available, with endpoint-specific retention/rate limits | inventoried; not backfilled into V10 when a matching timestamp-correct history was unavailable |
| Upbit live APIs/streams | current trades, ticker and order book | potentially causal at receipt time | available | inventoried; no historical L2/trade reconstruction was fabricated |
| Production database | regime observations, signal/run lineage, claims, orders, fills, positions and exits | persisted event timestamps | already live | used for router/parity/deployment audit, not V10 candidate discovery |

Binance's official [public-data archive](https://github.com/binance/binance-public-data)
defines the downloadable kline/trade files and checksum convention. Current endpoint
and stream availability was checked against the official [USD-M REST catalog](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data),
[Spot REST documentation](https://developers.binance.com/en/docs/products/spot/rest-api),
[Spot WebSocket streams](https://developers.binance.com/en/docs/products/spot/web-socket-streams),
and [USD-M market streams](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect).
Upbit pagination, rate limits, and stream behavior were checked against its
[minute-candle reference](https://global-docs.upbit.com/reference/list-candles-minutes),
[rate-limit reference](https://docs.upbit.com/kr/reference/rate-limits), and
[WebSocket guide](https://docs.upbit.com/kr/reference/websocket-guide).

## Hypothesis universe and economic mechanisms

The preregistered search deliberately uses twelve mechanisms, with two neighboring
configurations each rather than a large threshold sweep:

1. Upbit-to-Binance continuation before Binance fully follows.
2. Temporary Upbit/Binance divergence convergence.
3. Korean quote-volume shock transmission.
4. Cross-sectional Korean residual ranking.
5. Cross-exchange breadth propagation.
6. Upbit signed flow versus Binance taker-flow disagreement.
7. Korean-flow-confirmed volatility compression breakout.
8. Fixed KST-session conditional transmission.
9. RANGE VWAP/ATR-normalized directional reversal.
10. BEAR weak-rebound failure and renewed-low-close continuation SHORT.
11. BEAR abnormal-volume downside shock followed by completed recovery LONG.
12. Binance-only BTC/ETH two-factor beta-residual cross-sectional continuation.

This covers the data-permitted mechanisms requested for V10: directional RANGE
reversal (9), candle-level flow disagreement (6), relative value/cross-sectional
models (4, 5, 12), BEAR continuation SHORT (10), BEAR exhaustion LONG (11),
volatility transition (7), cross-exchange transmission (1-8), and cross-sectional
selection (4, 5, 12). Historical L2 microstructure and consistent historical
funding/OI models remain explicitly unavailable. ML was not fitted merely to add
complexity: with only four chronological validation rewards per candidate family,
a learned router would not have an independently estimable advantage over the
predeclared candidate-versus-cash decision.

The design is economically motivated by documented order-flow/price-impact and
cross-venue fragmentation mechanisms, including Cont, Kukanov and Stoikov's
[order-flow imbalance study](https://arxiv.org/abs/1011.6402), Stoikov's
[micro-price formulation](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2970694),
and Makarov and Schoar's [crypto cross-exchange arbitrage evidence](https://www.aeaweb.org/articles?id=10.1257%2Fpandp.20191020).
Those papers motivate hypotheses; none of their reported results are treated as our
evidence.

## Families rejected before V10 candidate fitting

- Historical L2 imbalance, microprice, replenishment and depletion: no point-in-time
  2025 depth history was available. Testing current snapshots against future returns
  would not provide an independent OOS sample, so these are data-unavailable rather
  than negative-alpha conclusions.
- Historical funding/OI/position-ratio shock models: public endpoint retention did not
  cover the frozen 2025 discovery window consistently across the 21-asset universe.
  No publication-time reconstruction was invented.
- V6-V9 simple mean-reversion, sweep/wick reversal, simple funding/OI/basis/taker
  thresholds, and their final-test variants: quarantined as seen lineages rather than
  retuned.
- Contextual/online router fitting: contextual selection is a legitimate framework
  (for example, [LinUCB](https://arxiv.org/abs/1003.0146)), but V10 has too few
  independently validated strategy rewards to estimate a trustworthy online policy.
  Cash therefore remains an explicit action.

## Frozen validation contract

- Four chronological 120-day train / 40-day validation folds with a 16-bar embargo.
- Candidate-selection cutoff: 2025-10-08 00:00 UTC.
- Unused buffer: 2025-10-08 through 2025-11-02.
- Final TEST: 2025-11-02 through 2026-01-01, inaccessible until an immutable eligible
  candidate lock exists.
- Next-bar-open execution; stop-first ambiguity; adverse gaps fill at the open; funding
  crossings excluded because funding history is absent.
- Round-trip costs: 14 bps BASE and 23 bps STRESS.
- Promotion requires at least 80 validation trades, 20 signal days, three positive
  folds, stress PF at least 1.05, positive neighboring-parameter evidence, and bounded
  market concentration. If nothing passes, the only valid lock is `NO_CANDIDATE` and
  the final TEST remains unopened.

The exact parameters, schedules, ordering rule, hashes, and one-shot TEST ledger are
machine-readable in `preregistration.json`, `candidate-universe.json`, and `run.py`.
