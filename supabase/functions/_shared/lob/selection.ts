import { expectedResolutionSeconds } from "../scalp/rotation.ts";

export interface LobSelectionSnapshot {
  ev_lower_bound_bps?: unknown;
  target_bps?: unknown;
  stop_bps?: unknown;
  max_holding_seconds?: unknown;
  hotness_score?: unknown;
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
  expectedSecondsToResolve: number;
  profitRateBpsPerSecond: number;
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
  const expectedSecondsToResolve = expectedResolutionSeconds(
    targetBps,
    stopBps,
    sigmaPerRootSecond,
    { min: 5, max: maxHoldingSeconds },
  );
  const profitRateBpsPerSecond = Number.isFinite(evLowerBoundBps)
    ? evLowerBoundBps / expectedSecondsToResolve
    : Number.NEGATIVE_INFINITY;
  const hotnessScore = finite(
    snapshot.hotness?.hotnessScore,
    finite(snapshot.hotness_score),
  );
  return {
    evLowerBoundBps,
    expectedSecondsToResolve,
    profitRateBpsPerSecond,
    hotnessScore,
  };
}

export function compareLobSelection(
  left: LobSelectionMetrics,
  right: LobSelectionMetrics,
  evUncertaintyBps = 0.25,
): number {
  const evGap = right.evLowerBoundBps - left.evLowerBoundBps;
  if (Math.abs(evGap) > Math.max(0, evUncertaintyBps)) return evGap;

  const rateGap = right.profitRateBpsPerSecond - left.profitRateBpsPerSecond;
  if (Math.abs(rateGap) > 1e-12) return rateGap;
  return right.hotnessScore - left.hotnessScore;
}
