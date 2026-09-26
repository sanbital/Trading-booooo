// Trading-booooo v6.5.0-LATENCY — capital rotation between held and available books.
//
// WHY THIS EXISTS
// ---------------
// Through v6.4 the entry path answers exactly one question per candidate: does this book
// clear the cost floor on its own? Capital that is already committed never enters the
// comparison. If every slot is occupied by positions earning 0.2bp per second and a book
// appears offering 3bp per second, the engine declines it — not because it judged the
// trade worse, but because it never looked.
//
// That is the wrong objective for a strategy whose stated goal is capital turnover. The
// scarce resource is not opportunity, it is a slot-second. A slot is worth what the best
// thing available to it earns, so the decision is comparative:
//
//     rate = expected net bps / expected seconds to resolve
//
// and rotating is justified when the candidate's rate, AFTER paying to close the old
// position and open the new one, beats the held position's remaining rate by enough to be
// worth the certainty of the switching cost.
//
// WHY HYSTERESIS IS NOT OPTIONAL
// ------------------------------
// Both rates are estimates with error bars. Rotating on any positive difference means
// rotating on noise, and each rotation pays a real, certain round-trip cost to chase an
// uncertain improvement — a machine for converting estimation error into fees. The
// required improvement therefore scales with the incumbent's own rate and never falls
// below an absolute floor, and a position must have had a fair chance to work before it
// can be displaced at all.
//
// Pure functions only — no I/O.

export interface HeldPositionRate {
  positionId: string;
  exchange: string;
  market: string;
  /**
   * Expected net bps still to be earned by continuing to hold, from the same hold-time
   * evaluation the exit path uses. Entry cost is sunk and must NOT appear here.
   */
  remainingEvBps: number;
  /** Expected seconds until this position resolves at a barrier. */
  expectedSecondsToResolve: number;
  /** One-way cost, in bps, of closing this position right now. */
  exitCostBps: number;
  /** How long the position has been open. Young positions are protected. */
  ageSeconds: number;
  /** Only OPEN positions may be displaced; anything mid-flight is excluded upstream. */
  state: string;
}

export interface RotationCandidate {
  exchange: string;
  market: string;
  /** Conservative (lower-bound) expected net bps, already net of its own round-trip costs. */
  evLowerBoundBps: number;
  /** Expected seconds until this candidate resolves at a barrier. */
  expectedSecondsToResolve: number;
}

export interface RotationConfig {
  /** Fractional improvement over the incumbent's rate required to rotate. */
  hysteresisFraction: number;
  /** Absolute floor on the required improvement, in bps per second. */
  minImprovementBpsPerSecond: number;
  /** A position younger than this is never displaced. */
  minHoldSeconds: number;
  /** Ceiling on rotations per hour, system-wide. */
  maxRotationsPerHour: number;
  /** States that may be displaced. Anything else is mid-flight. */
  rotatableStates: string[];
}

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  // 40% better, not 1% better. The rate estimates are not precise enough for anything
  // tighter to mean what it appears to mean.
  hysteresisFraction: 0.40,
  minImprovementBpsPerSecond: 0.02,
  // Roughly a third of the 180s LOB horizon: long enough for the thesis to have had a
  // chance, short enough that a dead position is not held out of politeness.
  minHoldSeconds: 60,
  maxRotationsPerHour: 6,
  rotatableStates: ["OPEN"],
};

function finite(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** bps earned per second of slot occupancy. The quantity a slot is actually optimizing. */
export function rateBpsPerSecond(evBps: number, seconds: number): number {
  const s = finite(seconds);
  if (!(s > 0)) return 0;
  return finite(evBps) / s;
}

export interface RotationDecision {
  rotate: boolean;
  reason: string;
  /** The position that would be closed, when rotating. */
  displace: HeldPositionRate | null;
  candidateRateBpsPerSecond: number;
  incumbentRateBpsPerSecond: number;
  improvementBpsPerSecond: number;
  requiredImprovementBpsPerSecond: number;
  switchingCostBps: number;
  netCandidateEvBps: number;
}

const NO_ROTATION = (reason: string): RotationDecision => ({
  rotate: false,
  reason,
  displace: null,
  candidateRateBpsPerSecond: 0,
  incumbentRateBpsPerSecond: 0,
  improvementBpsPerSecond: 0,
  requiredImprovementBpsPerSecond: 0,
  switchingCostBps: 0,
  netCandidateEvBps: 0,
});

/**
 * Decide whether `candidate` should displace one of `held`.
 *
 * Only called when no free slot exists — a free slot is always better than a rotation,
 * because it costs nothing to fill.
 */
export function evaluateRotation(
  candidate: RotationCandidate,
  held: HeldPositionRate[],
  input: {
    /** Cost in bps of opening the candidate: fees plus expected entry slippage. */
    candidateEntryCostBps: number;
    /** Rotations already performed in the trailing hour. */
    rotationsInLastHour: number;
  },
  config: Partial<RotationConfig> = {},
): RotationDecision {
  const cfg = { ...DEFAULT_ROTATION_CONFIG, ...config };

  if (finite(input.rotationsInLastHour) >= cfg.maxRotationsPerHour) {
    return NO_ROTATION("rotation budget exhausted for this hour");
  }
  if (!(finite(candidate.evLowerBoundBps) > 0)) {
    return NO_ROTATION("candidate EV is not positive before switching costs");
  }
  if (!(finite(candidate.expectedSecondsToResolve) > 0)) {
    return NO_ROTATION("candidate has no expected resolution time");
  }

  const eligible = held.filter((position) =>
    cfg.rotatableStates.includes(String(position.state)) &&
    finite(position.ageSeconds) >= cfg.minHoldSeconds
  );
  if (!eligible.length) {
    return NO_ROTATION("no held position is both settled and old enough to displace");
  }

  // Displace the WORST slot, not the first one that qualifies. Ordering by rate is the
  // whole point: rotating out of a merely mediocre position while a dead one sits
  // untouched spends the switching cost on the wrong slot.
  const ranked = [...eligible].sort((a, b) =>
    rateBpsPerSecond(a.remainingEvBps, a.expectedSecondsToResolve) -
    rateBpsPerSecond(b.remainingEvBps, b.expectedSecondsToResolve)
  );
  const worst = ranked[0];

  const incumbentRate = rateBpsPerSecond(worst.remainingEvBps, worst.expectedSecondsToResolve);
  const switchingCostBps = Math.max(0, finite(worst.exitCostBps)) +
    Math.max(0, finite(input.candidateEntryCostBps));
  const netCandidateEvBps = finite(candidate.evLowerBoundBps) - switchingCostBps;

  if (!(netCandidateEvBps > 0)) {
    return {
      ...NO_ROTATION("switching cost exceeds the candidate's entire edge"),
      displace: null,
      incumbentRateBpsPerSecond: incumbentRate,
      switchingCostBps,
      netCandidateEvBps,
    };
  }

  const candidateRate = rateBpsPerSecond(
    netCandidateEvBps,
    candidate.expectedSecondsToResolve,
  );
  const improvement = candidateRate - incumbentRate;
  // A negative incumbent rate is a position expected to lose more by being held. The
  // required improvement is measured against the magnitude of what we are escaping, so
  // this stays positive and meaningful in that case too.
  const required = Math.max(
    cfg.minImprovementBpsPerSecond,
    Math.abs(incumbentRate) * cfg.hysteresisFraction,
  );

  const rotate = improvement > required;
  return {
    rotate,
    reason: rotate
      ? `candidate earns ${improvement.toFixed(3)}bp/s more than ${worst.market} after ${switchingCostBps.toFixed(1)}bp switching cost`
      : `improvement ${improvement.toFixed(3)}bp/s below required ${required.toFixed(3)}bp/s`,
    displace: rotate ? worst : null,
    candidateRateBpsPerSecond: candidateRate,
    incumbentRateBpsPerSecond: incumbentRate,
    improvementBpsPerSecond: improvement,
    requiredImprovementBpsPerSecond: required,
    switchingCostBps,
    netCandidateEvBps,
  };
}

/**
 * What a held position is still worth, in bps, from where price is now.
 *
 * Entry cost is sunk and does not appear. The barriers are the REMAINING distances to
 * target and stop, not the original ones — a position halfway to its target has a
 * different geometry from the one it opened with, and comparing it on entry-time numbers
 * would systematically overvalue winners and undervalue losers.
 *
 * The probability is the neutral win rate of the remaining barriers plus whatever edge the
 * entry signal claimed, decayed by how long the position has been open. Only the decayed
 * edge is a belief; the rest is arithmetic. A signal that has aged past its half-life
 * several times contributes essentially nothing, which is the correct treatment: at that
 * point the position is just a coin flip paying a spread.
 */
export function remainingValueBps(input: {
  currentPrice: number;
  targetPrice: number;
  stopPrice: number;
  /** pTarget recorded at entry. */
  entryPTarget: number;
  /** Neutral win rate the entry barriers implied. */
  entryNeutralWinRate: number;
  heldSeconds: number;
  /** Seconds at which the entry edge is worth half of what it was. */
  edgeHalfLifeSeconds: number;
}): { remainingEvBps: number; remainingUpsideBps: number; remainingDownsideBps: number; pTargetNow: number } {
  const price = finite(input.currentPrice);
  const target = finite(input.targetPrice);
  const stop = finite(input.stopPrice);
  if (!(price > 0) || !(target > 0) || !(stop > 0)) {
    return { remainingEvBps: 0, remainingUpsideBps: 0, remainingDownsideBps: 0, pTargetNow: 0 };
  }
  // Clamped at zero: price through a barrier means that side is already resolved, and a
  // negative distance would flip the arithmetic into nonsense.
  const upBps = Math.max(0, (target - price) / price) * 10_000;
  const downBps = Math.max(0, (price - stop) / price) * 10_000;
  const neutralNow = upBps + downBps > 0 ? downBps / (upBps + downBps) : 0.5;

  const entryEdge = finite(input.entryPTarget) - finite(input.entryNeutralWinRate);
  const halfLife = Math.max(1, finite(input.edgeHalfLifeSeconds, 90));
  const decay = Math.pow(0.5, Math.max(0, finite(input.heldSeconds)) / halfLife);
  const pTargetNow = Math.max(0.02, Math.min(0.98, neutralNow + entryEdge * decay));

  return {
    remainingEvBps: pTargetNow * upBps - (1 - pTargetNow) * downBps,
    remainingUpsideBps: upBps,
    remainingDownsideBps: downBps,
    pTargetNow,
  };
}

/**
 * Expected seconds for a barrier pair to resolve.
 *
 * For a driftless random walk with per-second volatility `sigmaPerRootSecond`, the
 * expected time to touch either of two barriers at distances T and S is T*S/sigma^2.
 * This is the same W^2 relationship the geometry module optimizes against — stated here
 * per candidate so the ranking uses each book's own volatility rather than one horizon
 * constant applied to every symbol.
 */
export function expectedResolutionSeconds(
  targetBps: number,
  stopBps: number,
  sigmaPerRootSecondBps: number,
  bounds: { min: number; max: number } = { min: 5, max: 600 },
): number {
  const t = finite(targetBps);
  const s = finite(stopBps);
  const sigma = finite(sigmaPerRootSecondBps);
  if (!(t > 0) || !(s > 0) || !(sigma > 0)) return bounds.max;
  const seconds = (t * s) / (sigma * sigma);
  return Math.max(bounds.min, Math.min(bounds.max, seconds));
}
