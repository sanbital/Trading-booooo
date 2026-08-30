# V10 discovery data integrity

Cutoff: `[2025-01-01 00:00 UTC, 2025-10-08 00:00 UTC)`. Final TEST data
`[2025-11-02, 2026-01-01)` was not downloaded or read during discovery.

## Binance USD-M

- 21 assets x 10 monthly 15-minute archives: 210/210 present.
- 210/210 hashes matched official `.CHECKSUM` sidecars.
- 210/210 ZIP CRC checks passed.
- 612,864/612,864 physical monthly rows passed exact month-boundary and 15-minute
  continuity checks (29,184 per asset). The October archive's post-cutoff rows are
  physically present but the data guard discards them before feature/return evaluation.
- Sorted relative-path + ZIP-SHA manifest SHA-256:
  `e806f181951d3ced630fdf789456823073d91ef7880fd540acb74e878e987754`.

Two partial ARB archives and two missing XRP checksum sidecars were detected during
prefetch; each was independently redownloaded/revalidated before discovery.

## Upbit KRW

Upbit omits a candle when a market has no trade. The cache preserves only observed
candles; the research runner never forward-fills a missing cross-exchange observation.

| Market | Observed 15m candles | Market | Observed 15m candles | Market | Observed 15m candles |
|---|---:|---|---:|---|---:|
| ADA | 26,829 | APT | 26,793 | ARB | 26,814 |
| ATOM | 26,760 | AVAX | 26,825 | BCH | 26,815 |
| BTC | 26,829 | DOGE | 26,828 | DOT | 26,804 |
| ETC | 26,825 | ETH | 26,828 | LINK | 26,827 |
| NEAR | 26,820 | OP | 6,770 | SEI | 26,821 |
| SOL | 26,829 | SUI | 26,827 | TRX | 26,826 |
| UNI | 26,776 | XLM | 26,825 | XRP | 26,829 |

OP's shorter history is a real listing-history limitation and remains unavailable before
its first observation. Sorted relative-path + JSONL-SHA manifest SHA-256:
`03e09e693a13bf0c58e70a9e61731ea64ab12351f0d735d74a9c75e8eaa4d357`.

All Upbit requests used exclusive `to` pagination in <=2-day slices (at most 192 possible
15-minute slots), then filtered every returned timestamp against the exact frozen range.
