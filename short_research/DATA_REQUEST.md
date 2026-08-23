# EXTERNAL DATA REQUIRED — Binance USDⓈ-M Futures frozen dataset

The research environment cannot reach `fapi.binance.com` (organisation egress policy returns
403 on CONNECT), so market data must be collected externally and delivered as a frozen
dataset. Everything else — production source extraction, the overlap hotfix, the strategy
freeze, the backtest engine and its tests — is already complete and waiting on this input.

The collector needs no knowledge of the strategies. Collect mechanically, by the rules below,
so that symbol and period selection cannot bias the study.

## Directory

```
binance_dataset/
    manifest.json
    exchange_info.json
    universe.csv
    candles.parquet          (or candles.csv, same schema)
    funding.parquet          (or funding.csv, same schema)
    mark_prices.parquet      (optional)
```

## Period

- **Interval:** `1h`
- **Coverage:** the most recent **30 days** ending at the collection timestamp, for every symbol.
- Why 30 days and not 24 hours: the study runs PRIMARY (last 24h), PRIOR 24h, 72h and 7d from
  one frozen dataset, and production's longest lookbacks are EMA100, a 72-bar Donchian channel
  and a 72-bar return, with a hard `min_history_bars = 106` and a benchmark regime that only
  starts at bar index 100. 7 days of test window plus a safe warm-up is ~570 bars; 30 days
  (~720 bars) covers it with margin.
- All timestamps **UTC, milliseconds since epoch**.

## Universe

From `GET /fapi/v1/exchangeInfo`, take **every** symbol — do not pre-filter. Record for each
whether it is `contractType == PERPETUAL`, `status == TRADING`, `quoteAsset == USDT`. The
research side applies the production eligibility rules itself; the collector only reports.

## Files

### 1. `exchange_info.json`
Raw or lightly normalised `exchangeInfo`. Per symbol, must retain:
`symbol, status, contractType, baseAsset, quoteAsset, marginAsset, pricePrecision,
quantityPrecision` and the full `filters` array including `PRICE_FILTER (tickSize, minPrice,
maxPrice)`, `LOT_SIZE (stepSize, minQty, maxQty)`, `MARKET_LOT_SIZE`, and
`MIN_NOTIONAL`/`NOTIONAL`.

### 2. `universe.csv`
```
symbol, base_asset, quote_asset, contract_type, status,
binance_perpetual_eligible, production_eligible, excluded, exclusion_reason,
tick_size, step_size, min_qty, min_notional
```

### 3. `candles.parquet` — long format, one row per symbol-bar
```
symbol                   string
interval                 string   ("1h")
open_time                int64    UTC ms, bar OPEN
close_time               int64    UTC ms
open, high, low, close   float64  original precision
volume                   float64
quote_volume             float64
trade_count              int64
taker_buy_base_volume    float64
taker_buy_quote_volume   float64
```
From `GET /fapi/v1/klines` (limit 1500, paginate on `startTime`). Keep raw precision — do not
round. Include `BTCUSDT` and `ETHUSDT` even if they fail any filter: they are the benchmark
series for the regime gates.

### 4. `funding.parquet`
```
symbol        string
funding_time  int64    UTC ms
funding_rate  float64
mark_price    float64  (optional)
```
From `GET /fapi/v1/fundingRate`, same 30-day span. Funding is charged in the backtest only for
settlement stamps a position actually spans, so gaps here silently understate cost.

### 5. `manifest.json`
```json
{
  "dataset_version": "...",
  "source": "binance fapi",
  "exchange": "binance",
  "market_type": "USDM_FUTURES",
  "collection_started_utc": "...", "collection_completed_utc": "...",
  "primary_start_utc": 0, "primary_end_utc": 0,
  "primary_start_kst": "...", "primary_end_kst": "...",
  "warmup_start_utc": 0,
  "exchange_info_timestamp": "...",
  "candle_interval": "1h",
  "perpetual_symbol_count": 0, "eligible_symbol_count": 0,
  "successful_symbol_count": 0, "failed_symbol_count": 0,
  "successful_symbols": [], "failed_symbols": [],
  "candle_count": 0, "funding_record_count": 0,
  "files": [{ "filename": "candles.parquet", "row_count": 0, "sha256": "..." }]
}
```
`sha256` is required for every file; the loader verifies each one and refuses to trust a
mismatch.

## Collection rules

- Retry with exponential backoff on 429/418/5xx; respect `Retry-After`.
- Keep concurrency modest (≤ 10 symbols in flight) and re-queue failures before giving up.
- A symbol that still fails goes in `failed_symbols` **with its reason** — do not silently drop it.
- Never synthesise, interpolate or forward-fill a missing bar. A gap must arrive as a gap.

## On delivery

Place the directory in the repo (or hand over the path) and the frozen S01..S50 run starts
immediately against
`short_research/strategy_definitions.json`
(SHA-256 `4607b5c1538baa72b4fc03801c3908331b238487ff0533c6f937f09847635a30`),
which was written and hashed before any market data was seen and will not be edited.

```
python3 -m short_research.engine.run --dataset binance_dataset --out short_research/results
```
