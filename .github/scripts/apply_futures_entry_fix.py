from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one patch anchor, found {count}")
    p.write_text(text.replace(old, new, 1))


engine = "supabase/functions/market-autotrader/index.ts"
old = r'''/** Active USDⓈ-M perpetual membership is not the same thing as spot symbol grammar. */
async function activeBinanceFuturesSymbols(): Promise<Set<string>> {
  const now = Date.now();
  if (activeFuturesSymbolCache && activeFuturesSymbolCache.expires > now) {
    return activeFuturesSymbolCache.symbols;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${BINANCE_FUTURES_PUBLIC_URL}/fapi/v1/exchangeInfo`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Binance futures exchangeInfo ${response.status}: ${text.slice(0, 160)}`);
    }
    const payload = text ? JSON.parse(text) : {};
    const rows = Array.isArray(payload?.symbols) ? payload.symbols : [];
    const symbols = new Set<string>(
      rows
        .filter((row: any) =>
          String(row?.status || "") === "TRADING" &&
          String(row?.contractType || "") === "PERPETUAL" &&
          String(row?.quoteAsset || "") === "USDT"
        )
        .map((row: any) => String(row?.symbol || "").toUpperCase())
        .filter(Boolean),
    );
    if (!symbols.size) {
      throw new Error("Binance futures exchangeInfo returned no active USDT perpetuals");
    }
    activeFuturesSymbolCache = { expires: now + 5 * 60_000, symbols };
    return symbols;
  } finally {
    clearTimeout(timer);
  }
}
'''
new = r'''/**
 * Active USDⓈ-M perpetual membership is not the same thing as spot symbol grammar.
 *
 * Exchange-info alone is not sufficient: production observed symbols present in the
 * mirrored spot universe that still returned Binance -1121 from the live futures
 * ticker/order path. Require membership in BOTH the active perpetual rules and the
 * live USDⓈ-M ticker surface before a spot signal can enter the futures lane.
 */
async function activeBinanceFuturesSymbols(): Promise<Set<string>> {
  const now = Date.now();
  if (activeFuturesSymbolCache && activeFuturesSymbolCache.expires > now) {
    return activeFuturesSymbolCache.symbols;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const [exchangeInfoResponse, tickerResponse] = await Promise.all([
      fetch(`${BINANCE_FUTURES_PUBLIC_URL}/fapi/v1/exchangeInfo`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      }),
      fetch(`${BINANCE_FUTURES_PUBLIC_URL}/fapi/v2/ticker/price`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      }),
    ]);
    const [exchangeInfoText, tickerText] = await Promise.all([
      exchangeInfoResponse.text(),
      tickerResponse.text(),
    ]);
    if (!exchangeInfoResponse.ok) {
      throw new Error(
        `Binance futures exchangeInfo ${exchangeInfoResponse.status}: ${exchangeInfoText.slice(0, 160)}`,
      );
    }
    if (!tickerResponse.ok) {
      throw new Error(
        `Binance futures ticker ${tickerResponse.status}: ${tickerText.slice(0, 160)}`,
      );
    }

    const exchangeInfoPayload = exchangeInfoText ? JSON.parse(exchangeInfoText) : {};
    const tickerPayload = tickerText ? JSON.parse(tickerText) : [];
    const liveTickerSymbols = new Set<string>(
      (Array.isArray(tickerPayload) ? tickerPayload : [])
        .map((row: any) => String(row?.symbol || "").toUpperCase())
        .filter(Boolean),
    );
    const rows = Array.isArray(exchangeInfoPayload?.symbols) ? exchangeInfoPayload.symbols : [];
    const symbols = new Set<string>(
      rows
        .filter((row: any) => {
          const symbol = String(row?.symbol || "").toUpperCase();
          return String(row?.status || "") === "TRADING" &&
            String(row?.contractType || "") === "PERPETUAL" &&
            String(row?.quoteAsset || "") === "USDT" &&
            liveTickerSymbols.has(symbol);
        })
        .map((row: any) => String(row?.symbol || "").toUpperCase())
        .filter(Boolean),
    );
    if (!symbols.size) {
      throw new Error("Binance futures universe intersection returned no tradable USDT perpetuals");
    }
    activeFuturesSymbolCache = { expires: now + 5 * 60_000, symbols };
    return symbols;
  } finally {
    clearTimeout(timer);
  }
}
'''
replace_once(engine, old, new)
