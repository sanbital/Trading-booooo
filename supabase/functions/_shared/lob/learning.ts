// Trading-booooo v6.2.0-HEAT — LOB_SCALP self-correction.
//
// WHY THIS EXISTS
// ---------------
// The existing calibration stack cannot correct this strategy. `scalp-calibration` reads
// `trading_positions.metadata.scalp_signal`; the LOB path writes `metadata.lob_signal`, so
// the job has been fitting a model that no longer trades. `shadow.ts` resolves barriers on
// 5-minute candles, which cannot resolve a 10–60bp barrier inside a 180-second hold. The
// result was a strategy whose every probability constant — the 0.34 base in `entry.ts`, the
// 0.45/0.18/0.15 weights inside each pattern — had never been compared to an outcome.
//
// This strategy is, however, far easier to measure than the one it replaced. Positions
// resolve in minutes, so realized outcomes accumulate from live trading fast enough to
// calibrate on directly. No shadow reconstruction is needed.
//
// TWO THINGS ARE LEARNED
// ----------------------
// 1. Per-pattern reliability. Does ABSORPTION_REVERSAL actually reach its target more often
//    than QUEUE_DEPLETION_BREAKOUT, and are either of them anywhere near their predicted
//    probability?
//
// 2. Per-trap lift — whether each veto earns its place. A filter that blocks trades without
//    the blocked trades being measurably worse is not caution, it is throughput thrown away
//    for nothing. Because vetoed trades are never taken, this is measured from the traps
//    that fired *without* vetoing plus the exploration budget, which is the only reason the
//    exploration path is worth keeping.
//
// Pure functions only — no I/O.

import type { LobPatternName } from "./types.ts";
import type { LobTrapName } from "./traps.ts";
import {
  payoffAwareDeployment,
  summarizeRealizedPayoff,
} from "./payoff-governor.ts";

export interface LobOutcomeSample {
  pattern: LobPatternName;
  /** pTarget the model predicted at order time. */
  predicted: number;
  /** Neutral win rate the barriers implied at order time: stop / (target + stop). */
  neutral: number;
  /** 1 when the target was reached first, 0 when the stop or a signal exit resolved first. */
  outcome: 0 | 1;
  /** Net return actually realized, in bps, after fees. */
  netBps: number;
  /** Wall-clock slot occupancy from opened_at to closed_at. */
  heldSeconds?: number;
  /** Traps that were flagged at entry but did not veto. */
  traps: LobTrapName[];
  /** True when the trade was taken by the exploration budget rather than the EV gate. */
  exploration: boolean;
  closedAtMs: number;
}

export interface LobPatternStat {
  pattern: LobPatternName;
  samples: number;
  realizedHitRate: number;
  predictedHitRate: number;
  /** Mean neutral win rate the barriers implied. The part of the prediction that is arithmetic. */
  neutralWinRate: number;
  /** realizedHitRate - neutralWinRate. The edge the signal actually delivered. */
  measuredEdge: number;
  /** predictedHitRate - neutralWinRate. The edge the model claimed. */
  predictedEdge: number;
  meanNetBps: number;
  meanWinBps?: number | null;
  meanLossBps?: number | null;
  payoffRatio?: number | null;
  profitFactor?: number | null;
  netBpsStdDev?: number | null;
  meanNetLowerBoundBps?: number | null;
  /** Share of trades with positive realized net P&L, including profitable early exits. */
  profitableRate?: number;
  /** Median slot occupancy. Used for capital-turnover ranking, never as a trade veto. */
  medianHoldSeconds?: number;
  /** Multiplier applied to the model's *signal edge*, never to the geometric term. Shrunk toward 1. */
  probabilityMultiplier: number;
  /** Lower bound of the Wilson interval on the realized hit rate. */
  hitRateLowerBound: number;
}

export interface LobTrapStat {
  trap: LobTrapName;
  flagged: number;
  clean: number;
  flaggedHitRate: number;
  cleanHitRate: number;
  /** flaggedHitRate − cleanHitRate. Negative means the trap correctly marks worse trades. */
  lift: number;
  verdict: "HARMFUL" | "NEUTRAL" | "UNMEASURED";
}

export interface LobLearningProfile {
  generatedAtMs: number;
  samples: number;
  patterns: LobPatternStat[];
  traps: LobTrapStat[];
  /** Overall realized hit rate across every closed LOB position in the window. */
  baseHitRate: number;
  notes: string[];
}

export interface LobLearningConfig {
  /** Samples at which a pattern's own measurement carries half the weight. */
  priorStrength: number;
  /** Nothing is emitted for a pattern below this count. */
  minPatternSamples: number;
  /** A trap verdict is UNMEASURED below this count on either arm. */
  minTrapSamples: number;
  /** Hard bounds on how far one calibration round may move a probability. */
  minMultiplier: number;
  maxMultiplier: number;
  /** A trap whose lift is no worse than this is not doing anything. */
  neutralLiftThreshold: number;
}

export const DEFAULT_LOB_LEARNING_CONFIG: LobLearningConfig = {
  priorStrength: 120,
  // A high-frequency strategy can collect a useful same-day pattern sample quickly.
  // Twelve starts the correction, while the 120-sample prior limits one day to a small
  // move. Waiting for 25 left every pattern except ABSORPTION_REVERSAL unmeasured today.
  minPatternSamples: 12,
  minTrapSamples: 20,
  // The old 0.65 floor discarded adverse evidence: today's live ABSORPTION multiplier
  // shrinks to 0.24, yet the floor forced it back to 0.65. A 0.30 floor remains
  // conservative without claiming that a measured losing signal still owns most of its
  // hand-written edge.
  minMultiplier: 0.30,
  maxMultiplier: 1.35,
  neutralLiftThreshold: -0.03,
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Wilson score interval lower bound — honest at the sample counts this will actually see. */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const centre = p + z * z / (2 * total);
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
  return clamp((centre - margin) / denominator, 0, 1);
}

export function buildLobLearningProfile(
  samples: LobOutcomeSample[],
  overrides: Partial<LobLearningConfig> = {},
): LobLearningProfile {
  const cfg = { ...DEFAULT_LOB_LEARNING_CONFIG, ...overrides };
  const notes: string[] = [];
  const usable = samples.filter((sample) =>
    Number.isFinite(sample.predicted) && (sample.outcome === 0 || sample.outcome === 1)
  );
  const baseHitRate = usable.length
    ? usable.filter((sample) => sample.outcome === 1).length / usable.length
    : 0;

  const byPattern = new Map<LobPatternName, LobOutcomeSample[]>();
  for (const sample of usable) {
    const bucket = byPattern.get(sample.pattern);
    if (bucket) bucket.push(sample);
    else byPattern.set(sample.pattern, [sample]);
  }

  const patterns: LobPatternStat[] = [];
  for (const [pattern, rows] of byPattern) {
    if (rows.length < cfg.minPatternSamples) {
      notes.push(
        `${pattern}: ${rows.length}표본 — 최소 ${cfg.minPatternSamples}표본 미달로 미반영`,
      );
      continue;
    }
    const hits = rows.filter((row) => row.outcome === 1).length;
    const realized = hits / rows.length;
    const predicted = mean(rows.map((row) => row.predicted));
    const neutral = mean(rows.map((row) => row.neutral));
    // Correct the edge, not the probability. The neutral term is arithmetic forced by the
    // barrier widths and cannot be miscalibrated; only the signal's claimed edge over it can
    // be. Dividing whole probabilities would let a wide-stop trade's high neutral rate
    // masquerade as predictive skill.
    const measuredEdge = realized - neutral;
    const predictedEdge = predicted - neutral;
    const rawMultiplier = Math.abs(predictedEdge) > 0.005 ? measuredEdge / predictedEdge : 1;
    const weight = rows.length / (rows.length + cfg.priorStrength);
    const shrunk = 1 + (rawMultiplier - 1) * weight;
    const payoff = summarizeRealizedPayoff(rows.map((row) => row.netBps));
    patterns.push({
      pattern,
      samples: rows.length,
      realizedHitRate: realized,
      predictedHitRate: predicted,
      neutralWinRate: neutral,
      measuredEdge,
      predictedEdge,
      meanNetBps: payoff.meanNetBps ?? 0,
      meanWinBps: payoff.meanWinBps,
      meanLossBps: payoff.meanLossBps,
      payoffRatio: payoff.payoffRatio,
      profitFactor: payoff.profitFactor,
      netBpsStdDev: payoff.standardDeviationBps,
      meanNetLowerBoundBps: payoff.meanLowerBoundBps,
      profitableRate: rows.filter((row) => row.netBps > 0).length / rows.length,
      medianHoldSeconds: median(rows.map((row) => Number(row.heldSeconds))),
      probabilityMultiplier: clamp(shrunk, cfg.minMultiplier, cfg.maxMultiplier),
      hitRateLowerBound: wilsonLowerBound(hits, rows.length),
    });
  }
  patterns.sort((left, right) => right.samples - left.samples);

  const trapNames: LobTrapName[] = [
    "ASK_ICEBERG",
    "BID_SPOOF",
    "ASK_SPOOF",
    "CHOP_NO_VIABLE_STOP",
    "QUOTE_FLICKER",
  ];
  const traps: LobTrapStat[] = trapNames.map((trap) => {
    const flaggedRows = usable.filter((sample) => sample.traps.includes(trap));
    const cleanRows = usable.filter((sample) => !sample.traps.includes(trap));
    const flaggedHitRate = flaggedRows.length
      ? flaggedRows.filter((row) => row.outcome === 1).length / flaggedRows.length
      : 0;
    const cleanHitRate = cleanRows.length
      ? cleanRows.filter((row) => row.outcome === 1).length / cleanRows.length
      : 0;
    const measured = flaggedRows.length >= cfg.minTrapSamples &&
      cleanRows.length >= cfg.minTrapSamples;
    const lift = flaggedHitRate - cleanHitRate;
    return {
      trap,
      flagged: flaggedRows.length,
      clean: cleanRows.length,
      flaggedHitRate,
      cleanHitRate,
      lift,
      verdict: !measured ? "UNMEASURED" : lift <= cfg.neutralLiftThreshold ? "HARMFUL" : "NEUTRAL",
    };
  });

  for (const trap of traps) {
    if (trap.verdict === "NEUTRAL") {
      notes.push(
        `${trap.trap}: 표본 ${trap.flagged}건에서 승률차 ${(trap.lift * 100).toFixed(1)}pp — ` +
          `해당 조건이 결과를 악화시킨다는 증거 없음. 문턱 완화 검토 대상`,
      );
    }
  }
  if (!usable.length) notes.push("종료된 LOB 포지션 표본이 없어 교정할 대상이 없습니다.");

  return {
    generatedAtMs: Date.now(),
    samples: usable.length,
    patterns,
    traps,
    baseHitRate,
    notes,
  };
}

/**
 * Look up the live multiplier for one pattern. Returns 1 — i.e. leave the model alone —
 * whenever the pattern has not been measured, so an unmeasured pattern is never silently
 * penalised into never trading again.
 */
export function patternMultiplier(
  profile: LobLearningProfile | null | undefined,
  pattern: LobPatternName | null,
): number {
  if (!profile || !pattern) return 1;
  const row = profile.patterns.find((entry) => entry.pattern === pattern);
  return row ? row.probabilityMultiplier : 1;
}

export interface LobPatternDeployment {
  samples: number;
  observedMultiplier: number;
  /**
   * Multiplier allowed to affect the hard EV gate. Low-sample evidence is deliberately
   * ranking-only: otherwise the model can "improve" win rate by taking no trades.
   */
  gateMultiplier: number;
  gateWeight: number;
  /** Joint quality term for candidate ordering. It never changes EV's sign. */
  rankingQuality: number;
  profitableRate: number | null;
  meanNetBps: number | null;
  medianHoldSeconds: number | null;
  profitFactor: number | null;
  payoffRatio: number | null;
  meanNetLowerBoundBps: number | null;
  deploymentReason: string;
}

/**
 * Split learning into two jobs:
 *
 * 1. Ranking reacts immediately, so the scarce slot-second moves toward patterns with
 *    better realized win rate, net return and holding time.
 * 2. Adverse pattern evidence never owns the hard gate, because that improves measured
 *    win rate by deleting turnover. Mature positive evidence may lift the gate estimate
 *    after 120 samples and reaches full influence at 360; adverse evidence continues to
 *    act through priority and rotation.
 */
export function patternDeployment(
  profile: LobLearningProfile | null | undefined,
  pattern: LobPatternName | null,
  gateStartSamples = 120,
  gateFullSamples = 360,
): LobPatternDeployment {
  const row = profile && pattern
    ? profile.patterns.find((entry) => entry.pattern === pattern)
    : null;
  if (!row) {
    return {
      samples: 0,
      observedMultiplier: 1,
      gateMultiplier: 1,
      gateWeight: 0,
      rankingQuality: 1,
      profitableRate: null,
      meanNetBps: null,
      medianHoldSeconds: null,
      profitFactor: null,
      payoffRatio: null,
      meanNetLowerBoundBps: null,
      deploymentReason: "no verified pattern evidence",
    };
  }

  const samples = Math.max(0, Number(row.samples) || 0);
  const observedMultiplier = clamp(Number(row.probabilityMultiplier), 0.30, 1.35);
  const profitableRate = Number.isFinite(Number(row.profitableRate))
    ? clamp(Number(row.profitableRate), 0, 1)
    : null;
  const meanNetBps = Number.isFinite(Number(row.meanNetBps)) ? Number(row.meanNetBps) : null;
  const medianHoldSeconds = Number.isFinite(Number(row.medianHoldSeconds)) &&
      Number(row.medianHoldSeconds) > 0
    ? Number(row.medianHoldSeconds)
    : null;
  const profitFactor = Number.isFinite(Number(row.profitFactor))
    ? Number(row.profitFactor)
    : null;
  const payoffRatio = Number.isFinite(Number(row.payoffRatio))
    ? Number(row.payoffRatio)
    : null;
  const meanNetLowerBoundBps = Number.isFinite(Number(row.meanNetLowerBoundBps))
    ? Number(row.meanNetLowerBoundBps)
    : null;

  const deployment = payoffAwareDeployment({
    samples,
    observedMultiplier,
    profitableRate,
    meanNetBps,
    profitFactor,
    payoffRatio,
    meanLowerBoundBps: meanNetLowerBoundBps,
    medianHoldSeconds,
    gateStartSamples,
    gateFullSamples,
  });

  return {
    samples,
    observedMultiplier,
    gateMultiplier: deployment.gateMultiplier,
    gateWeight: deployment.gateWeight,
    rankingQuality: deployment.rankingQuality,
    profitableRate,
    meanNetBps,
    medianHoldSeconds,
    profitFactor,
    payoffRatio,
    meanNetLowerBoundBps,
    deploymentReason: deployment.reason,
  };
}

/**
 * Traps that measurement says are not earning their veto. The caller downgrades these from
 * hard blocks to confidence penalties, which is how the filter stops being self-sealing:
 * a veto that never gets tested can never be shown wrong, so it must be able to lose.
 */
export function unearnedVetoes(
  profile: LobLearningProfile | null | undefined,
): LobTrapName[] {
  if (!profile) return [];
  return profile.traps.filter((trap) => trap.verdict === "NEUTRAL").map((trap) => trap.trap);
}
