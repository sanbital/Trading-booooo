// Dynamic Binance USDⓈ-M perpetual universe discovery.
// Research/shadow rollout 2026-09-06. No fixed symbol list and no top-N cap.

export type FuturesUniverseMember = {
  symbol: string;
  quoteVolume24h: number;
  priceChangePercent24h: number;
  lastPrice: number;
};

const FUTURES_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
] as const;

function finite(value: unknown, fallback = Number.NaN): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJson(path: string): Promise<any> {
  let lastError = "UNKNOWN";
  for (const base of FUTURES_BASES) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: {
          accept: "application/json",
          "user-agent": "Trading-booooo-dynamic-futures-universe/1.0",
        },
        signal: AbortSignal.timeout(12_000),
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : null;
      lastError = `${base}:${response.status}:${text.slice(0, 240)}`;
    } catch (error) {
      lastError = `${base}:${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(`BINANCE_UNIVERSE_FETCH_FAILED:${lastError}`);
}

export async function discoverBinanceUsdtPerpetualUniverse(
  minQuoteVolume24h = 50_000_000,
): Promise<FuturesUniverseMember[]> {
  const [exchangeInfo, ticker24h] = await Promise.all([
    fetchJson("/fapi/v1/exchangeInfo"),
    fetchJson("/fapi/v1/ticker/24hr"),
  ]);

  const active = new Set(
    (Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [])
      .filter((row: any) =>
        row?.status === "TRADING" &&
        row?.quoteAsset === "USDT" &&
        row?.contractType === "PERPETUAL"
      )
      .map((row: any) => String(row.symbol || "").toUpperCase())
      .filter(Boolean),
  );

  return (Array.isArray(ticker24h) ? ticker24h : [])
    .map((row: any) => ({
      symbol: String(row?.symbol || "").toUpperCase(),
      quoteVolume24h: finite(row?.quoteVolume, 0),
      priceChangePercent24h: finite(row?.priceChangePercent, 0),
      lastPrice: finite(row?.lastPrice, 0),
    }))
    .filter((row: FuturesUniverseMember) =>
      active.has(row.symbol) &&
      row.lastPrice > 0 &&
      row.quoteVolume24h >= minQuoteVolume24h
    )
    .sort((a: FuturesUniverseMember, b: FuturesUniverseMember) =>
      b.quoteVolume24h - a.quoteVolume24h || a.symbol.localeCompare(b.symbol)
    );
}
