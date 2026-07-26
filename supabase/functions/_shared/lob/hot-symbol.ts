import type { HotSymbolScore, LobFeatureVector } from "./types.ts";

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function logNorm(value: number, reference: number): number {
  return clamp(Math.log1p(Math.max(0, value)) / Math.log1p(Math.max(1, reference)));
}

/**
 * Separates "activity" from "tradability". A symbol can print many trades yet still be
 * unusable because its spread is wide, its book is stale, or there is not enough depth.
 */
export function scoreHotSymbol(features: LobFeatureVector): HotSymbolScore {
  const turnoverRatio = features.minActionableTurnover24h > 0
    ? features.turnover24hQuote / features.minActionableTurnover24h
    : 0;
  const update = logNorm(features.bookUpdateRate, 30);
  const arrival = logNorm(features.tradeArrivalRate, 20);
  const notional = logNorm(features.aggressiveNotionalPerSecond, Math.max(1, features.minActionableTurnover24h / 86_400));
  const turnover = logNorm(turnoverRatio, 20);
  const flowEnergy = clamp(Math.abs(features.tradePressureFast) * 0.55 + features.ofiPersistence * 0.45);
  const activityScore = clamp(
    update * 0.24 + arrival * 0.28 + notional * 0.24 + turnover * 0.12 + flowEnergy * 0.12,
  );

  const spread = features.spreadBps == null ? 0 : clamp(1 - features.spreadBps / 30);
  const freshness = features.bookAgeMs == null ? 0 : clamp(1 - features.bookAgeMs / 5000);
  const depth = clamp(Math.log1p(Math.max(0, features.bidDepthQuote + features.askDepthQuote)) /
    Math.log1p(Math.max(1, features.averageTradeNotional || 1) * 100));
  const quality = clamp(features.dataQuality);
  const antiSpoof = clamp(1 - features.spoofLikeScore);
  const tradabilityScore = clamp(
    spread * 0.30 + freshness * 0.25 + depth * 0.18 + quality * 0.17 + antiSpoof * 0.10,
  );

  // Activity dominates because the user explicitly wants the hottest book at scan time.
  const hotnessScore = clamp(activityScore * 0.72 + tradabilityScore * 0.28) * 100;
  return {
    activityScore: activityScore * 100,
    tradabilityScore: tradabilityScore * 100,
    hotnessScore,
    components: {
      book_update_rate: update * 100,
      trade_arrival_rate: arrival * 100,
      aggressive_notional: notional * 100,
      turnover_ratio: turnover * 100,
      flow_energy: flowEnergy * 100,
      spread: spread * 100,
      freshness: freshness * 100,
      depth: depth * 100,
      data_quality: quality * 100,
      anti_spoof: antiSpoof * 100,
    },
  };
}
