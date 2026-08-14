import { expectedResolutionSeconds } from "../scalp/rotation.ts";

export interface LobSelectionSnapshot {
  ev_lower_bound_bps?: unknown;
  target_bps?: unknown;
  stop_bps?: unknown;
  max_holding_seconds?: unknown;
  hotness_score?: unknown;
  p_target?: unknown;
  pattern_quality?: unknown;
  empirical_profitable_rate?: unknown;
  empirical_hold_seconds?: unknown;
  hotness?: {
    hotnessScore?: unknown;
  };
  features?: {
    noiseBandBps?: unknown;
    observationMs?: unknown;
  };
}

export interface LobSelectionMetrics {
  evLowerBoundBps: number;
  qualityAdjustedEvBps: number;
  winProbability: number;
  expectedSecondsToResolve: number;
  profitRateBpsPerSecond: number;
  jointObjective: number;
  hotnessScore: number;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Candidate priority for the scarce slot-second.
 *
 * Live data showed the top EV-LCB quartile at 47.1% profitable versus 23.9% overall,
 * while hotness-first selection reached only 29.4%. EV therefore owns the first
 * comparison. Within a 0.25bp uncertainty band, profit per second breaks the tie so
 * turnover improves without allowing a slightly faster but materially weaker book to
 * jump the queue.
 */
export function lobSelectionMetrics(snapshot: LobSelectionSnapshot): LobSelectionMetrics {
  const evLowerBoundBps = finite(
    snapshot.ev_lower_bound_bps,
    Number.NEGATIVE_INFINITY,
  );
  const patternQuality = Math.max(0.01, finite(snapshot.pattern_quality, 1));
  const qualityAdjustedEvBps = Number.isFinite(evLowerBoundBps)
    ? evLowerBoundBps * patternQuality
    : Number.NEGATIVE_INFINITY;
  const modelWinProbability = Math.max(0, Math.min(1, finite(snapshot.p_target, 0.5)));
  const empiricalWin = snapshot.empirical_profitable_rate == null
    ? Number.NaN
    : finite(snapshot.empirical_profitable_rate, Number.NaN);
  const winProbability = Number.isFinite(empiricalWin)
    ? Math.max(0, Math.min(1, empiricalWin))
    : modelWinProbability;
  const targetBps = Math.max(0, finite(snapshot.target_bps));
  const stopBps = Math.max(0, finite(snapshot.stop_bps));
  const maxHoldingSeconds = Math.max(
    5,
    Math.min(300, finite(snapshot.max_holding_seconds, 180)),
  );
  const observationSeconds = Math.max(
    1,
    finite(snapshot.features?.observationMs, 8000) / 1000,
  );
  const sigmaPerRootSecond = Math.max(
    0,
    finite(snapshot.features?.noiseBandBps) / Math.sqrt(observationSeconds),
  );
  const physicalResolutionSeconds = expectedResolutionSeconds(
    targetBps,
    stopBps,
    sigmaPerRootSecond,
    { min: 5, max: maxHoldingSeconds },
  );
  const empiricalHoldSeconds = finite(snapshot.empirical_hold_seconds, Number.NaN);
  const expectedSecondsToResolve = Number.isFinite(empiricalHoldSeconds) &&
      empiricalHoldSeconds > 0
    ? Math.max(
      5,
      Math.min(maxHoldingSeconds, Math.sqrt(physicalResolutionSeconds * empiricalHoldSeconds)),
    )
    : physicalResolutionSeconds;
  const profitRateBpsPerSecond = Number.isFinite(qualityAdjustedEvBps)
    ? qualityAdjustedEvBps / expectedSecondsToResolve
    : Number.NEGATIVE_INFINITY;
  const jointObjective = qualityAdjustedEvBps > 0 && profitRateBpsPerSecond > 0
    ? Math.cbrt(
      qualityAdjustedEvBps * profitRateBpsPerSecond * Math.max(0.01, winProbability),
    )
    : Number.NEGATIVE_INFINITY;
  const hotnessScore = finite(
    snapshot.hotness?.hotnessScore,
    finite(snapshot.hotness_score),
  );
  return {
    evLowerBoundBps,
    qualityAdjustedEvBps,
    winProbability,
    expectedSecondsToResolve,
    profitRateBpsPerSecond,
    jointObjective,
    hotnessScore,
  };
}

function dominates(left: LobSelectionMetrics, right: LobSelectionMetrics): boolean {
  const noWorse = left.qualityAdjustedEvBps >= right.qualityAdjustedEvBps &&
    left.winProbability >= right.winProbability &&
    left.profitRateBpsPerSecond >= right.profitRateBpsPerSecond;
  const better = left.qualityAdjustedEvBps > right.qualityAdjustedEvBps ||
    left.winProbability > right.winProbability ||
    left.profitRateBpsPerSecond > right.profitRateBpsPerSecond;
  return noWorse && better;
}

export function compareLobSelection(
  left: LobSelectionMetrics,
  right: LobSelectionMetrics,
  evUncertaintyBps = 0.25,
): number {
  if (dominates(left, right)) return -1;
  if (dominates(right, left)) return 1;

  const jointGap = right.jointObjective - left.jointObjective;
  if (Math.abs(jointGap) > 1e-12) return jointGap;

  const evGap = right.evLowerBoundBps - left.evLowerBoundBps;
  if (Math.abs(evGap) > Math.max(0, evUncertaintyBps)) return evGap;

  const rateGap = right.profitRateBpsPerSecond - left.profitRateBpsPerSecond;
  if (Math.abs(rateGap) > 1e-12) return rateGap;
  return right.hotnessScore - left.hotnessScore;
}

/**
 * Non-dominated sorting for the user's three simultaneous objectives:
 * net EV, profitable-trade probability and EV per slot-second.
 *
 * A candidate that is worse on every objective can never jump a candidate that is better
 * on all three. Trade count is unchanged: this function orders the supplied candidates and
 * never removes one.
 */
export function rankLobSelections<T>(
  items: T[],
  metricsOf: (item: T) => LobSelectionMetrics,
): T[] {
  const rows = items.map((item, index) => ({ item, index, metrics: metricsOf(item), layer: 0 }));
  const remaining = new Set(rows.map((_, index) => index));
  let layer = 0;
  while (remaining.size) {
    const frontier: number[] = [];
    for (const index of remaining) {
      let dominated = false;
      for (const other of remaining) {
        if (index !== other && dominates(rows[other].metrics, rows[index].metrics)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) frontier.push(index);
    }
    // Equal metrics can leave every row non-dominating; the frontier is still non-empty,
    // but retain a defensive escape so malformed future metrics cannot loop forever.
    if (!frontier.length) frontier.push(...remaining);
    for (const index of frontier) {
      rows[index].layer = layer;
      remaining.delete(index);
    }
    layer++;
  }
  return rows.sort((left, right) =>
    left.layer - right.layer ||
    compareLobSelection(left.metrics, right.metrics) ||
    left.index - right.index
  ).map((row) => row.item);
}
