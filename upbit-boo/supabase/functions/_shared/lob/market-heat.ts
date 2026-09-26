// Trading-booooo v7.1.1-TOP10-LOB-ONLY — strict per-exchange 24h gainer ranking.
// The rolling 24h return fixes the observed universe. Flow, turnover, and trade-speed
// fields remain diagnostics for the 45–50 second LOB/tape recheck and never exclude
// a valid Top 10 name before that observation.

export interface MarketHeatTicker {
  market: string;
  timestampMs: number;
  price: number;
  turnover24hQuote: number;
  tradeCount?: number | null;
  change24hPct?: number;
  range24hPct?: number;
}

export interface MarketHeatScore {
  market: string;
  rank: number;
  heatScore: number;
  recentNotionalPerSecond: number;
  previousNotionalPerSecond: number;
  notionalAcceleration: number;
  notionalTrend: number;
  tradeCountPerSecond: number;
  previousTradeCountPerSecond: number;
  tradeSpeedTrend: number;
  flowHealthy: boolean;
  flowExclusionReasons: string[];
  turnover24hQuote: number;
  change24hPct: number;
  range24hPct: number;
  components: Record<string, number>;
}

export interface MarketHeatConfig {
  minimumTurnover24hQuote: number;
  referenceRecentNotionalPerSecond: number;
  referenceTradeCountPerSecond: number;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function logNorm(value: number, reference: number): number {
  return clamp(Math.log1p(Math.max(0, value)) / Math.log1p(Math.max(1, reference)));
}

/**
 * Rank each exchange strictly by current rolling 24h percentage gain.
 * Flow fields are observation diagnostics only and do not influence rank or
 * eligibility for the strict Top 10 LOB/tape observation set.
 */
export function rankMarketHeat(
  snapshots: MarketHeatTicker[][],
  config: MarketHeatConfig,
): MarketHeatScore[] {
  if (snapshots.length < 2) return [];
  const maps = snapshots.map((rows) => new Map(rows.map((row) => [row.market, row])));
  const latest = maps.at(-1)!;
  const previous = maps.at(-2)!;
  const earlier = maps.length >= 3 ? maps.at(-3)! : previous;
  const scored: MarketHeatScore[] = [];

  for (const [market, last] of latest) {
    const prev = previous.get(market);
    const early = earlier.get(market);
    if (!prev || !early || !(last.price > 0)) continue;
    const recentSeconds = Math.max(0.25, (last.timestampMs - prev.timestampMs) / 1000);
    const previousSeconds = Math.max(0.25, (prev.timestampMs - early.timestampMs) / 1000);
    const recentNotional = Math.max(
      0,
      finite(last.turnover24hQuote) - finite(prev.turnover24hQuote),
    );
    const previousNotional = Math.max(
      0,
      finite(prev.turnover24hQuote) - finite(early.turnover24hQuote),
    );
    const recentNotionalPerSecond = recentNotional / recentSeconds;
    const previousNotionalPerSecond = previousNotional / previousSeconds;
    const recentCount = Math.max(0, finite(last.tradeCount) - finite(prev.tradeCount));
    const previousCount = Math.max(0, finite(prev.tradeCount) - finite(early.tradeCount));
    const tradeCountPerSecond = recentCount / recentSeconds;
    const previousTradeCountPerSecond = previousCount / previousSeconds;
    const notionalTrend = clamp(
      (recentNotionalPerSecond - previousNotionalPerSecond) /
        Math.max(1, recentNotionalPerSecond + previousNotionalPerSecond),
      -1,
      1,
    );
    const hasTradeCounts = Number.isFinite(Number(last.tradeCount)) &&
      Number.isFinite(Number(prev.tradeCount)) && Number.isFinite(Number(early.tradeCount));
    const tradeSpeedTrend = hasTradeCounts
      ? clamp(
        (tradeCountPerSecond - previousTradeCountPerSecond) /
          Math.max(0.01, tradeCountPerSecond + previousTradeCountPerSecond),
        -1,
        1,
      )
      : 0;
    const flowExclusionReasons: string[] = [];
    if (finite(last.turnover24hQuote) < config.minimumTurnover24hQuote) {
      flowExclusionReasons.push("TURNOVER_TOO_LOW");
    }
    if (notionalTrend < -0.20) flowExclusionReasons.push("NOTIONAL_FLOW_DECLINING");
    if (hasTradeCounts && tradeSpeedTrend < -0.20) {
      flowExclusionReasons.push("TRADE_SPEED_DECLINING");
    }
    const accelerationBase = Math.max(
      config.referenceRecentNotionalPerSecond * 0.02,
      previousNotionalPerSecond,
      1,
    );
    const accelerationRatio = recentNotionalPerSecond / accelerationBase;
    const notionalAcceleration = clamp((accelerationRatio - 0.7) / 3.3);
    const recentFlow = logNorm(
      recentNotionalPerSecond,
      config.referenceRecentNotionalPerSecond,
    );
    const relativeFlow = logNorm(
      recentNotionalPerSecond /
        Math.max(1, finite(last.turnover24hQuote) / 86_400),
      30,
    );
    const countFlow = tradeCountPerSecond > 0
      ? logNorm(tradeCountPerSecond, config.referenceTradeCountPerSecond)
      : relativeFlow * 0.65;
    const turnover = logNorm(
      finite(last.turnover24hQuote) / Math.max(1, config.minimumTurnover24hQuote),
      30,
    );
    const range = clamp(finite(last.range24hPct) / 30);
    const heatScore = (
      recentFlow * 0.30 +
      relativeFlow * 0.22 +
      notionalAcceleration * 0.25 +
      countFlow * 0.13 +
      turnover * 0.06 +
      range * 0.04
    ) * 100;
    scored.push({
      market,
      rank: 0,
      heatScore,
      recentNotionalPerSecond,
      previousNotionalPerSecond,
      notionalAcceleration,
      notionalTrend,
      tradeCountPerSecond,
      previousTradeCountPerSecond,
      tradeSpeedTrend,
      // Top-10 membership is rank-only. Weakening-flow diagnostics are retained
      // for the 45–50 second LOB/tape decision, never as a pre-observation veto.
      flowHealthy: true,
      flowExclusionReasons: recentNotionalPerSecond > 0
        ? flowExclusionReasons
        : [...flowExclusionReasons, "NO_RECENT_NOTIONAL_FLOW"],
      turnover24hQuote: finite(last.turnover24hQuote),
      change24hPct: finite(last.change24hPct),
      range24hPct: finite(last.range24hPct),
      components: {
        recent_flow: recentFlow * 100,
        relative_flow: relativeFlow * 100,
        acceleration: notionalAcceleration * 100,
        trade_count: countFlow * 100,
        turnover: turnover * 100,
        range: range * 100,
      },
    });
  }

  return scored
    .sort((left, right) =>
      right.change24hPct - left.change24hPct ||
      right.turnover24hQuote - left.turnover24hQuote
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
