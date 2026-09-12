// Trading-booooo v6.2.0-HEAT — perpetual funding as an auxiliary signal.
//
// SCOPE
// -----
// This bot trades Upbit KRW spot and Binance USDT spot. Neither has funding. What follows
// reads Binance *perpetual* funding and mark/index premium and uses it only as a signal
// about where leveraged attention is concentrated. It never places a futures order, and it
// is never a veto — a missing perp, a failed fetch or an unmapped symbol all resolve to
// neutral, which is the same as the signal not existing.
//
// WHY THE PREMIUM MATTERS MORE THAN THE FUNDING RATE HERE
// ------------------------------------------------------
// `lastFundingRate` is a settled 8-hour number. On a 12-second scan cycle it is nearly a
// constant, so on its own it would only ever act as a slow regime tag. The mark-to-index
// premium is the live quantity: it moves within seconds and measures how hard perp traders
// are currently pressing, which is exactly the horizon this strategy operates on.
//
// Both are kept. The premium carries the fast signal; the settled rate carries the crowding
// context that says whether that pressure is fresh or already paid for.
//
// Pure functions plus one fetch. No I/O in the scoring path.

export interface FundingObservation {
  /** Perp symbol, e.g. BTCUSDT. */
  symbol: string;
  /** Last settled 8h funding rate as a decimal, e.g. 0.0001 = 1bp. */
  lastFundingRate: number;
  markPrice: number;
  indexPrice: number;
  timestampMs: number;
}

export interface FundingSignal {
  available: boolean;
  /** (mark / index - 1) in bps. Positive means perps are bid over spot. */
  premiumBps: number;
  /** Settled 8h funding rate in bps. */
  fundingBps: number;
  /** Change in premium since the previous observation, in bps. */
  premiumDeltaBps: number;
  /** 0..1 attention proxy from the magnitude of leveraged pressure. */
  attention: number;
  /** Bounded additive edge for a long. Positive = supportive, negative = crowded. */
  edge: number;
  note: string;
}

export interface FundingConfig {
  /** Premium beyond which longs are treated as crowded rather than supportive. */
  crowdedPremiumBps: number;
  /** Settled funding beyond which the crowding is already established, not fresh. */
  crowdedFundingBps: number;
  /** Hard bound on how much this signal may move the entry edge. */
  maxEdge: number;
  /** Premium magnitude that maps to full attention. */
  attentionReferenceBps: number;
}

export const DEFAULT_FUNDING_CONFIG: FundingConfig = {
  crowdedPremiumBps: 12,
  crowdedFundingBps: 5,
  maxEdge: 0.03,
  attentionReferenceBps: 8,
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const NEUTRAL_FUNDING: FundingSignal = {
  available: false,
  premiumBps: 0,
  fundingBps: 0,
  premiumDeltaBps: 0,
  attention: 0,
  edge: 0,
  note: "무기한 선물 대응 종목 없음 — 펀딩 신호 미적용",
};

/**
 * Map a spot market to its Binance perpetual symbol. Upbit KRW-BTC and Binance BTCUSDT both
 * resolve to BTCUSDT, because the leveraged positioning that matters is global rather than
 * per-venue.
 */
export function perpSymbolFor(market: string): string | null {
  const raw = String(market || "").toUpperCase().trim();
  if (!raw) return null;
  if (raw.startsWith("KRW-")) return `${raw.slice(4)}USDT`;
  if (raw.endsWith("USDT")) return raw;
  return null;
}

/**
 * Score one market. `previous` is the same market's observation from an earlier scan; when
 * absent the delta term is simply zero rather than guessed.
 */
export function scoreFunding(
  current: FundingObservation | null | undefined,
  previous: FundingObservation | null | undefined,
  overrides: Partial<FundingConfig> = {},
): FundingSignal {
  if (!current || !(current.indexPrice > 0) || !(current.markPrice > 0)) return NEUTRAL_FUNDING;
  const cfg = { ...DEFAULT_FUNDING_CONFIG, ...overrides };

  const premiumBps = (current.markPrice / current.indexPrice - 1) * 10_000;
  const fundingBps = finite(current.lastFundingRate) * 10_000;
  const previousPremiumBps = previous && previous.indexPrice > 0 && previous.markPrice > 0
    ? (previous.markPrice / previous.indexPrice - 1) * 10_000
    : premiumBps;
  const premiumDeltaBps = premiumBps - previousPremiumBps;

  const attention = clamp(
    Math.abs(premiumBps) / cfg.attentionReferenceBps * 0.6 +
      Math.abs(premiumDeltaBps) / cfg.attentionReferenceBps * 0.4,
    0,
    1,
  );

  // Fresh pressure supports a long; pressure that has already been paid for through several
  // funding settlements is crowding, and crowding is what unwinds fastest on this horizon.
  const fresh = clamp(premiumDeltaBps / cfg.crowdedPremiumBps, -1, 1);
  const crowded = clamp(
    (Math.max(0, premiumBps) / cfg.crowdedPremiumBps) *
      (Math.max(0, fundingBps) / Math.max(1e-9, cfg.crowdedFundingBps)),
    0,
    2,
  );
  const rawEdge = fresh * 0.6 - Math.max(0, crowded - 1) * 0.5;
  const edge = clamp(rawEdge * cfg.maxEdge, -cfg.maxEdge, cfg.maxEdge);

  const note = crowded > 1
    ? `프리미엄 ${premiumBps.toFixed(1)}bp · 펀딩 ${fundingBps.toFixed(2)}bp — 롱 쏠림 누적`
    : premiumDeltaBps > 0
    ? `프리미엄 ${premiumBps.toFixed(1)}bp (${premiumDeltaBps >= 0 ? "+" : ""}${premiumDeltaBps.toFixed(1)}) — 선물 매수 압력 증가`
    : `프리미엄 ${premiumBps.toFixed(1)}bp (${premiumDeltaBps.toFixed(1)}) — 선물 매수 압력 감소`;

  return { available: true, premiumBps, fundingBps, premiumDeltaBps, attention, edge, note };
}

/**
 * One call returns every perpetual. Per-symbol requests would not fit a 12-second scan, and
 * a scan that runs late is worse than a scan without this signal.
 */
export async function fetchFundingSnapshot(
  fetchImpl: typeof fetch = fetch,
  baseUrl = "https://fapi.binance.com",
  timeoutMs = 4000,
): Promise<Map<string, FundingObservation>> {
  const out = new Map<string, FundingObservation>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/fapi/v1/premiumIndex`, {
      signal: controller.signal,
    });
    if (!response.ok) return out;
    const rows = await response.json();
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
      const symbol = String(row?.symbol || "").toUpperCase();
      if (!symbol.endsWith("USDT")) continue;
      const markPrice = finite(row?.markPrice);
      const indexPrice = finite(row?.indexPrice);
      if (!(markPrice > 0) || !(indexPrice > 0)) continue;
      out.set(symbol, {
        symbol,
        lastFundingRate: finite(row?.lastFundingRate),
        markPrice,
        indexPrice,
        timestampMs: finite(row?.time, Date.now()),
      });
    }
  } catch {
    // Region block, timeout or schema change: the scan proceeds without the signal.
  } finally {
    clearTimeout(timer);
  }
  return out;
}
