"""Build a synthetic binance_dataset/ so the whole pipeline is exercised before real data.

This exists to prove the engine runs end to end -- loader, validator, all 50 strategies,
portfolio replay, metrics, CSV output. It is NOT research data and its numbers mean nothing
about the market; it is deliberately written to a directory named `synthetic` so it can
never be mistaken for the frozen Binance dataset.
"""
from __future__ import annotations
import json, math, pathlib, sys, hashlib

def lcg(seed):
    s = seed & 0xFFFFFFFF
    def r():
        nonlocal s
        s = (s * 1103515245 + 12345) & 0xFFFFFFFF
        return s / 4294967296
    return r

def series(symbol, n, seed, base, drift, vol, vol_scale, break_at, direction):
    r = lcg(seed)
    rows, price = [], base
    t0 = 1_755_000_000_000 - n * 3_600_000
    t0 = (t0 // 3_600_000) * 3_600_000
    for i in range(n):
        d = drift + (r() - 0.5) * vol
        m = 1.0
        if break_at and i >= break_at:
            d += direction * 0.0035
            m = 3.2
        o = price
        c = max(1e-8, o * (1 + d))
        up = c >= o
        h = (c if up else o) * (1 + r() * 0.0012)
        l = (o if up else c) * (1 - r() * 0.0012)
        v = (1000 + r() * 500) * m * vol_scale
        ot = t0 + i * 3_600_000
        rows.append(dict(symbol=symbol, interval="1h", open_time=ot,
                         close_time=ot + 3_599_999, open=o, high=h, low=l, close=c,
                         volume=v, quote_volume=v * c, trade_count=int(500 + r() * 500),
                         taker_buy_base_volume=v * 0.5, taker_buy_quote_volume=v * c * 0.5))
        price = c
    return rows

def main(outdir="short_research/synthetic_dataset", n_symbols=40, bars=600):
    import pandas as pd
    out = pathlib.Path(outdir); out.mkdir(parents=True, exist_ok=True)
    candles, symbols = [], []
    specs = [("BTCUSDT", 60000.0, -0.0009, 0.004, 5000.0, 0, 0),
             ("ETHUSDT", 3000.0, -0.0009, 0.005, 4000.0, 0, 0)]
    for k in range(n_symbols):
        drift = -0.0004 if k % 3 == 0 else (0.0003 if k % 3 == 1 else 0.0)
        brk = bars - 260 + (k * 7) % 200
        direction = -1 if k % 2 == 0 else 1
        specs.append((f"SYN{k:02d}USDT", 10.0 + k, drift, 0.010, 60.0 + k * 3, brk, direction))
    for sym, base, drift, vol, vs, brk, direction in specs:
        candles += series(sym, bars, 1000 + hash(sym) % 9000, base, drift, vol, vs,
                          brk, direction)
        symbols.append(dict(symbol=sym, status="TRADING", contractType="PERPETUAL",
                            baseAsset=sym.replace("USDT", ""), quoteAsset="USDT",
                            marginAsset="USDT", pricePrecision=4, quantityPrecision=3,
                            filters=[{"filterType": "PRICE_FILTER", "tickSize": "0.0001",
                                      "minPrice": "0.0001", "maxPrice": "1000000"},
                                     {"filterType": "LOT_SIZE", "stepSize": "0.001",
                                      "minQty": "0.001", "maxQty": "1000000"},
                                     {"filterType": "NOTIONAL", "notional": "5"}]))
    funding = []
    for sym in [s["symbol"] for s in symbols]:
        t = candles[0]["open_time"]
        last = candles[-1]["open_time"]
        r = lcg(abs(hash(sym)) % 100000)
        while t <= last:
            if (t // 3_600_000) % 8 == 0:
                funding.append(dict(symbol=sym, funding_time=t,
                                    funding_rate=(r() - 0.45) * 0.0004))
            t += 3_600_000
    cdf = pd.DataFrame(candles); fdf = pd.DataFrame(funding)
    cdf.to_parquet(out / "candles.parquet", index=False)
    fdf.to_parquet(out / "funding.parquet", index=False)
    (out / "exchange_info.json").write_text(json.dumps({"symbols": symbols}, indent=1))
    def sha(p):
        h = hashlib.sha256(); h.update(pathlib.Path(p).read_bytes()); return h.hexdigest()
    prim_end = max(c["open_time"] for c in candles)
    manifest = dict(
        dataset_version="SYNTHETIC-0", source="synthetic generator (NOT market data)",
        exchange="binance", market_type="USDM_FUTURES",
        primary_start_utc=prim_end - 24 * 3_600_000, primary_end_utc=prim_end,
        warmup_start_utc=candles[0]["open_time"], candle_interval="1h",
        perpetual_symbol_count=len(symbols), eligible_symbol_count=len(symbols),
        successful_symbol_count=len(symbols), failed_symbol_count=0,
        candle_count=len(candles), funding_record_count=len(funding),
        files=[dict(filename="candles.parquet", row_count=len(candles),
                    sha256=sha(out / "candles.parquet")),
               dict(filename="funding.parquet", row_count=len(funding),
                    sha256=sha(out / "funding.parquet")),
               dict(filename="exchange_info.json", row_count=len(symbols),
                    sha256=sha(out / "exchange_info.json"))])
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"synthetic dataset: {len(symbols)} symbols, {len(candles)} candles, "
          f"{len(funding)} funding rows -> {out}")

if __name__ == "__main__":
    main()
