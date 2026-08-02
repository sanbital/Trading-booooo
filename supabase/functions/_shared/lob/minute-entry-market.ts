import {
  evaluateMinuteEntryGate,
  type MinuteCandle,
  type MinuteEntryGate,
  unavailableMinuteEntryGate,
} from "./minute-entry-gate.ts";

export type MinuteEntryExchange = "upbit" | "binance";

const UPBIT = "https://api.upbit.com";
const BINANCE = "https://api.binance.com";

function utcTimestamp(value: unknown): number {
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
}

function normalizeUpbit(raw: unknown): MinuteCandle[] {
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const row = value as Record<string, unknown>;
    const openTimeMs = utcTimestamp(row.candle_date_time_utc);
    if (!Number.isFinite(openTimeMs)) return [];
    return [{
      openTimeMs,
      closeTimeMs: openTimeMs + 60_000,
      open: Number(row.opening_price),
      high: Number(row.high_price),
      low: Number(row.low_price),
      close: Number(row.trade_price),
    }];
  });
}

function normalizeBinance(raw: unknown): MinuteCandle[] {
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    if (!Array.isArray(value) || value.length < 7) return [];
    return [{
      openTimeMs: Number(value[0]),
      closeTimeMs: Number(value[6]),
      open: Number(value[1]),
      high: Number(value[2]),
      low: Number(value[3]),
      close: Number(value[4]),
    }];
  });
}

async function fetchJson(url: string, timeoutMs = 6_000): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`minute candle HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      return text ? JSON.parse(text) : [];
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function loadMinuteEntryGate(
  exchange: MinuteEntryExchange,
  market: string,
  nowMs = Date.now(),
): Promise<MinuteEntryGate> {
  try {
    const url = exchange === "upbit"
      ? `${UPBIT}/v1/candles/minutes/1?market=${encodeURIComponent(market)}&count=40`
      : `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(market)}&interval=1m&limit=40`;
    const raw = await fetchJson(url);
    return evaluateMinuteEntryGate(
      exchange === "upbit" ? normalizeUpbit(raw) : normalizeBinance(raw),
      nowMs,
    );
  } catch (error) {
    return unavailableMinuteEntryGate(error instanceof Error ? error.message : String(error));
  }
}

export async function loadMinuteEntryGates(
  exchange: MinuteEntryExchange,
  markets: string[],
  nowMs = Date.now(),
): Promise<Map<string, MinuteEntryGate>> {
  const unique = [...new Set(markets.map((market) => String(market)).filter(Boolean))];
  const output = new Map<string, MinuteEntryGate>();
  const batchSize = exchange === "upbit" ? 5 : 10;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    const results = await Promise.all(
      batch.map((market) => loadMinuteEntryGate(exchange, market, nowMs)),
    );
    batch.forEach((market, index) => output.set(market, results[index]));
    if (offset + batchSize < unique.length) {
      await new Promise((resolve) => setTimeout(resolve, exchange === "upbit" ? 300 : 100));
    }
  }
  return output;
}
