// backtest/fetch-history.ts  (Deno)
// 업비트/바이낸스 공개 REST에서 과거 캔들을 내려받아 백테스트용 JSON으로 저장한다.
// 오더북 히스토리는 공개 API에 없으므로 캔들만 받는다(마이크로구조는 백테스트 불가).
//
// 사용:
//   deno run -A backtest/fetch-history.ts upbit KRW-BTC 180
//   deno run -A backtest/fetch-history.ts binance BTCUSDT 180
//   (마지막 인자 = 받아올 일수. v2.6.0 data 게이트가 일봉 120개를 요구하므로 최소 125일,
//    자동 교정을 위해 180일 이상 권장)
//
// 출력: backtest/data/<exchange>-<market>.json
// 진행 중인 미완성 봉은 저장하지 않으며, 중복 페이지 봉은 제거한다.

import type { MarketHistory, SimCandle } from "./simulate.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  }
  throw new Error(`rate-limited: ${url}`);
}

// ── 업비트 ──────────────────────────────────────────────
export async function upbitCandles(
  market: string,
  unit: "5" | "15" | "240" | "day",
  need: number,
): Promise<SimCandle[]> {
  const base = unit === "day"
    ? "https://api.upbit.com/v1/candles/days"
    : `https://api.upbit.com/v1/candles/minutes/${unit}`;
  const out: SimCandle[] = [];
  let to = "";
  while (out.length < need) {
    const url = `${base}?market=${market}&count=200${to ? `&to=${encodeURIComponent(to)}` : ""}`;
    const rows: any[] = await getJson(url);
    if (!rows.length) break;
    for (const r of rows) {
      out.push({
        openTime: Date.parse(r.candle_date_time_utc + "Z"),
        open: r.opening_price,
        high: r.high_price,
        low: r.low_price,
        close: r.trade_price,
        quoteVolume: r.candle_acc_trade_price,
      });
    }
    to = rows.at(-1).candle_date_time_utc; // 가장 오래된 봉 시각으로 페이지네이션
    await sleep(180);
  }
  const duration = unit === "day"
    ? 86_400_000
    : Number(unit) * 60_000;
  const seen = new Set<number>();
  return out
    .filter((c) => c.openTime + duration <= Date.now())
    .filter((c) => seen.has(c.openTime) ? false : (seen.add(c.openTime), true))
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-need);
}

export async function upbitTick(market: string, price: number): Promise<number> {
  try {
    const rows = await getJson(
      `https://api.upbit.com/v1/orderbook/instruments?markets=${market}`,
    );
    const t = Number(rows?.[0]?.tick_size);
    if (Number.isFinite(t) && t > 0) return t;
  } catch { /* fall through */ }
  // 업비트 KRW 호가단위 근사
  if (price >= 2_000_000) return 1000;
  if (price >= 1_000_000) return 500;
  if (price >= 500_000) return 100;
  if (price >= 100_000) return 50;
  if (price >= 10_000) return 10;
  if (price >= 1_000) return 1;
  if (price >= 100) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.001;
  return 0.0001;
}

// ── 바이낸스 ────────────────────────────────────────────
export async function binanceKlines(
  symbol: string,
  interval: "5m" | "15m" | "4h" | "1d",
  need: number,
): Promise<SimCandle[]> {
  const out: SimCandle[] = [];
  let endTime = Date.now();
  while (out.length < need) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${endTime}`;
    const rows: any[] = await getJson(url);
    if (!rows.length) break;
    for (const k of rows) {
      out.push({
        openTime: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        quoteVolume: Number(k[7]), // quote asset volume
      });
    }
    endTime = rows[0][0] - 1;
    await sleep(200);
  }
  const duration = interval === "5m"
    ? 300_000
    : interval === "15m"
    ? 900_000
    : interval === "4h"
    ? 14_400_000
    : 86_400_000;
  const seen = new Set<number>();
  return out
    .filter((c) => c.openTime + duration <= Date.now())
    .filter((c) => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true)))
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-need);
}

export async function binanceTick(symbol: string): Promise<number> {
  try {
    const info = await getJson(
      `https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`,
    );
    const f = info.symbols?.[0]?.filters?.find((x: any) =>
      x.filterType === "PRICE_FILTER"
    );
    const t = Number(f?.tickSize);
    if (Number.isFinite(t) && t > 0) return t;
  } catch { /* ignore */ }
  return 0.0001;
}

export async function fetchMarketHistory(
  exchange: "upbit" | "binance",
  market: string,
  days = 180,
): Promise<MarketHistory> {
  const need = { m5: days * 288, m15: days * 96, h4: days * 6, day: days + 5 };
  if (exchange === "upbit") {
    const [m5, m15, h4, dayC] = [
      await upbitCandles(market, "5", need.m5),
      await upbitCandles(market, "15", need.m15),
      await upbitCandles(market, "240", need.h4),
      await upbitCandles(market, "day", need.day),
    ];
    const tick = await upbitTick(market, m15.at(-1)?.close ?? 0);
    return {
      exchange, market, quoteCurrency: "KRW", tickSize: tick,
      collectedAt: Date.now(), m5, m15, h4, day: dayC,
    };
  }
  const [m5, m15, h4, dayC] = [
    await binanceKlines(market, "5m", need.m5),
    await binanceKlines(market, "15m", need.m15),
    await binanceKlines(market, "4h", need.h4),
    await binanceKlines(market, "1d", need.day),
  ];
  const tick = await binanceTick(market);
  return {
    exchange, market, quoteCurrency: "USDT", tickSize: tick,
    collectedAt: Date.now(), m5, m15, h4, day: dayC,
  };
}

// ── 엔트리 ──────────────────────────────────────────────
if (import.meta.main) {
  const [exchangeRaw, market, daysArg] = Deno.args;
  if (!exchangeRaw || !market || !["upbit", "binance"].includes(exchangeRaw)) {
    console.error(
      "사용: deno run -A backtest/fetch-history.ts <upbit|binance> <MARKET> [일수=180]",
    );
    Deno.exit(1);
  }
  const exchange = exchangeRaw as "upbit" | "binance";
  const days = Number(daysArg || 180);
  console.error(`${exchange} ${market} · ${days}일 수집 중…`);
  const history = await fetchMarketHistory(exchange, market, days);
  await Deno.mkdir("backtest/data", { recursive: true });
  const path = `backtest/data/${exchange}-${market}.json`;
  await Deno.writeTextFile(path, JSON.stringify(history));
  console.error(
    `저장: ${path}  (m5 ${history.m5.length} / m15 ${history.m15.length} / h4 ${history.h4.length} / day ${history.day.length})`,
  );
}
