import type { LobPatternName } from "./types.ts";

export interface LobOnlineProfileRow {
  exchange: string;
  market: string;
  pattern: string;
  version: number;
  samples: number;
  profitable_trades: number;
  target_hits: number;
  early_exit_losses: number;
  ewma_net_bps: number;
  ewma_hold_seconds: number;
  ewma_profitable_hold_seconds: number;
  ewma_mae_bps: number;
  ewma_mfe_bps: number;
  ewma_profitable_mae_bps: number;
  exit_counts?: Record<string, number> | null;
  updated_at?: string | null;
}

export interface LobOnlineMarketPolicy {
  profileVersion: number;
  marketSamples: number;
  globalSamples: number;
  profitableRate: number | null;
  targetHitRate: number | null;
  meanNetBps: number | null;
  expectedHoldSeconds: number | null;
  /** Ranking-only. It is always positive and can never change raw EV's sign. */
  rankingQuality: number;
  /**
   * Minimum stop distance learned only from the adverse excursion of trades that
   * ultimately made money. The entry EV gate must be rerun after applying it.
   */
  learnedStopFloorBps: number;
  /** Short settlement window for non-catastrophic LOB invalidation after a maker fill. */
  softExitGraceSeconds: number;
  /** Consecutive monitor observations required before a soft exit. */
  softExitConfirmations: number;
  source: "PRIOR" | "PATTERN" | "MARKET";
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function profileOf(
  rows: LobOnlineProfileRow[],
  exchange: string,
  market: string,
  pattern: LobPatternName | null,
): LobOnlineProfileRow | null {
  if (!pattern) return null;
  return rows.find((row) =>
    String(row.exchange).toLowerCase() === exchange.toLowerCase() &&
    String(row.market).toUpperCase() === market.toUpperCase() &&
    String(row.pattern) === pattern
  ) ?? null;
}

/**
 * Resolve a hierarchical online policy.
 *
 * Every closed trade updates two rows: one exchange-wide wildcard pattern row and one
 * exchange/market/pattern row. The market estimate is shrunk toward its pattern-wide parent
 * until the coin has enough outcomes. No negative observation becomes a hard veto:
 * adverse evidence changes ordering and soft-exit confirmation, preserving candidate
 * supply and capital turnover.
 */
export function resolveLobOnlineMarketPolicy(
  rows: LobOnlineProfileRow[],
  exchange: string,
  market: string,
  pattern: LobPatternName | null,
  marketPriorStrength = 24,
): LobOnlineMarketPolicy {
  const global = profileOf(rows, exchange, "*", pattern);
  const exact = profileOf(rows, exchange, market, pattern);
  const globalSamples = Math.max(0, Math.floor(finite(global?.samples)));
  const marketSamples = Math.max(0, Math.floor(finite(exact?.samples)));
  const parentProfitRate = globalSamples > 0
    ? clamp(finite(global?.profitable_trades) / globalSamples, 0, 1)
    : null;
  const exactProfitRate = marketSamples > 0
    ? clamp(finite(exact?.profitable_trades) / marketSamples, 0, 1)
    : null;
  const weight = marketSamples /
    (marketSamples + Math.max(1, finite(marketPriorStrength, 24)));
  const profitableRate = exactProfitRate == null
    ? parentProfitRate
    : parentProfitRate == null
    ? exactProfitRate
    : exactProfitRate * weight + parentProfitRate * (1 - weight);

  const parentTargetRate = globalSamples > 0
    ? clamp(finite(global?.target_hits) / globalSamples, 0, 1)
    : null;
  const exactTargetRate = marketSamples > 0
    ? clamp(finite(exact?.target_hits) / marketSamples, 0, 1)
    : null;
  const targetHitRate = exactTargetRate == null
    ? parentTargetRate
    : parentTargetRate == null
    ? exactTargetRate
    : exactTargetRate * weight + parentTargetRate * (1 - weight);

  const parentNet = globalSamples > 0 ? finite(global?.ewma_net_bps) : null;
  const exactNet = marketSamples > 0 ? finite(exact?.ewma_net_bps) : null;
  const meanNetBps = exactNet == null
    ? parentNet
    : parentNet == null
    ? exactNet
    : exactNet * weight + parentNet * (1 - weight);

  const parentHold = globalSamples > 0 ? finite(global?.ewma_hold_seconds) : null;
  const exactHold = marketSamples > 0 ? finite(exact?.ewma_hold_seconds) : null;
  const expectedHoldSeconds = exactHold == null
    ? parentHold
    : parentHold == null
    ? exactHold
    : exactHold * weight + parentHold * (1 - weight);

  const winFactor = profitableRate == null ? 1 : clamp(0.5 + profitableRate, 0.5, 1.5);
  const netFactor = meanNetBps == null ? 1 : clamp(1 + meanNetBps / 100, 0.5, 1.5);
  const rankingQuality = clamp(winFactor * netFactor, 0.25, 1.75);

  const exactProfitable = Math.max(0, Math.floor(finite(exact?.profitable_trades)));
  const globalProfitable = Math.max(0, Math.floor(finite(global?.profitable_trades)));
  const exactWinnerMae = exactProfitable >= 5
    ? Math.max(0, finite(exact?.ewma_profitable_mae_bps))
    : null;
  const parentWinnerMae = globalProfitable >= 12
    ? Math.max(0, finite(global?.ewma_profitable_mae_bps))
    : null;
  const learnedMae = exactWinnerMae == null
    ? parentWinnerMae
    : parentWinnerMae == null
    ? exactWinnerMae
    : exactWinnerMae * weight + parentWinnerMae * (1 - weight);
  // Give a profitable trade's normal adverse excursion 20% breathing room. This floor is
  // bounded and still has to survive the full cost-aware EV calculation at order time.
  const learnedStopFloorBps = learnedMae == null ? 0 : clamp(learnedMae * 1.20, 0, 500);

  const profitableHold = exactProfitable >= 3
    ? finite(exact?.ewma_profitable_hold_seconds)
    : globalProfitable >= 8
    ? finite(global?.ewma_profitable_hold_seconds)
    : 0;
  const softExitGraceSeconds = clamp(profitableHold > 0 ? profitableHold * 0.15 : 6, 6, 24);

  const earlyLossRate = marketSamples > 0
    ? clamp(finite(exact?.early_exit_losses) / marketSamples, 0, 1)
    : globalSamples > 0
    ? clamp(finite(global?.early_exit_losses) / globalSamples, 0, 1)
    : 0;
  const softExitConfirmations = earlyLossRate >= 0.45 ? 4 : earlyLossRate >= 0.25 ? 3 : 2;

  return {
    profileVersion: Math.max(
      Math.floor(finite(global?.version)),
      Math.floor(finite(exact?.version)),
    ),
    marketSamples,
    globalSamples,
    profitableRate,
    targetHitRate,
    meanNetBps,
    expectedHoldSeconds,
    rankingQuality,
    learnedStopFloorBps,
    softExitGraceSeconds,
    softExitConfirmations,
    source: exact ? "MARKET" : global ? "PATTERN" : "PRIOR",
  };
}
