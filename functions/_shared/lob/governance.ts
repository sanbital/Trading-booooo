import type { LobLearningProfile } from "./learning.ts";
import type { LobOnlineProfileRow } from "./online.ts";
import {
  DEFAULT_LOB_ADAPTIVE_POLICY,
  normalizeLobAdaptivePolicy,
  type LobAdaptivePolicyDefinition,
} from "./adaptive-policy.ts";

export type LobPolicyStatus =
  | "CHAMPION"
  | "CHALLENGER"
  | "CONTROL"
  | "REJECTED"
  | "RETIRED"
  | "ROLLED_BACK";

export type LobPolicyLane = "CHAMPION" | "CHALLENGER" | "CONTROL" | "LEGACY";
export type LobPolicyPhase = "CHALLENGE" | "CONFIRMATION" | "IDLE";

export interface LobPolicyVersionRow {
  version: number;
  status: LobPolicyStatus;
  parent_version?: number | null;
  engine_version?: string | null;
  fingerprint?: string | null;
  source_online_version?: number | null;
  traffic_fraction?: number | null;
  evaluation_started_at?: string | null;
  created_at?: string | null;
  confirmed_at?: string | null;
  online_profiles?: LobOnlineProfileRow[] | null;
  pattern_profile?: Record<string, unknown> | null;
  metrics?: Record<string, unknown> | null;
  decision_reason?: string | null;
  policy_definition?: Partial<LobAdaptivePolicyDefinition> | null;
}

export interface LobPolicyBundle {
  version: number;
  lane: LobPolicyLane;
  status: LobPolicyStatus;
  phase: LobPolicyPhase;
  parentVersion: number | null;
  onlineProfiles: LobOnlineProfileRow[];
  patternProfile: LobLearningProfile | null;
  evaluationStartedAt: string | null;
  policyDefinition: LobAdaptivePolicyDefinition;
}

export interface LobPolicyRuntime {
  champion: LobPolicyVersionRow | null;
  alternate: LobPolicyVersionRow | null;
  phase: LobPolicyPhase;
}

export interface LobPolicyTrade {
  id?: string;
  policyVersion: number;
  exchange?: string;
  market?: string;
  pattern?: string;
  netBps: number;
  profitable?: boolean;
  heldSeconds: number;
  notionalQuote: number;
  closedAtMs: number;
  /** True only for accounting-verified real fills; backtest/shadow rows cannot vote. */
  liveVerified?: boolean;
  accountingQuality?: string;
}

export interface LobPolicyExposure {
  policyVersion: number;
  assignedAtMs?: number;
  candidateCount: number;
  entryAttempts: number;
  reservations: number;
}

export interface LobPolicyMetrics {
  samples: number;
  wins: number;
  winRate: number;
  meanNetBps: number;
  netStdDevBps: number;
  notionalWeightedNetBps: number;
  geometricMeanBps: number;
  profitFactor: number;
  maxDrawdownBps: number;
  meanHeldSeconds: number;
  meanNotionalQuote: number;
  tradesPerSlotHour: number;
  capitalTurnsPerHour: number;
  assignedScans: number;
  candidatesSeen: number;
  entryAttempts: number;
  reservations: number;
  tradesPerAssignedScan: number;
  reservationsPerAssignedScan: number;
  fillPerReservation: number;
  liveVerifiedSamples: number;
  liveVerifiedFraction: number;
  distinctMarkets: number;
  independentTimeBlocks: number;
}

export interface LobPolicyPromotionConfig {
  minSamplesPerArm: number;
  earlyStopSamplesPerArm: number;
  maxSamplesPerArm: number;
  minAssignedScansPerArm: number;
  /** One-sided confidence multiplier. 1.28155 is a 90% lower confidence bound. */
  zScore: number;
  minProfitFactor: number;
  minNotionalRatio: number;
  maxDrawdownRatio: number;
  minCommonMixCoverage: number;
  minLiveVerifiedFraction: number;
  minDistinctMarketsPerArm: number;
  minIndependentBlocksPerArm: number;
  netNonInferiorityBps: number;
  winRateNonInferiority: number;
  turnoverNonInferiorityRatio: number;
  currentTrafficFraction: number;
  expandedTrafficFraction: number;
  canaryMinBaselineSamples: number;
  canaryMinCandidateSamples: number;
}

export const DEFAULT_LOB_POLICY_PROMOTION_CONFIG: LobPolicyPromotionConfig = {
  // The supplied live cohort reached 67 closes in one day. Forty per lane balances
  // same-day response with enough observations to reject obvious noise.
  minSamplesPerArm: 40,
  earlyStopSamplesPerArm: 20,
  maxSamplesPerArm: 120,
  minAssignedScansPerArm: 20,
  zScore: 1.281551565545,
  minProfitFactor: 1,
  // A challenger may never create cosmetic performance by silently shrinking the order.
  minNotionalRatio: 0.98,
  // Drawdown is a safety invariant, not a substitute objective. Five percent tolerance
  // prevents one ordering accident from blocking an otherwise strict Pareto improvement.
  maxDrawdownRatio: 1.05,
  // Promotion must be supported by the exchange × pattern cells shared by both arms.
  // This prevents a favourable market mix from masquerading as model improvement.
  minCommonMixCoverage: 0.65,
  minLiveVerifiedFraction: 1,
  minDistinctMarketsPerArm: 2,
  minIndependentBlocksPerArm: 2,
  // Candidate may be statistically indistinguishable on secondary metrics while net return
  // improves. These are non-inferiority margins, not permission for material degradation.
  netNonInferiorityBps: 2,
  winRateNonInferiority: 0.03,
  turnoverNonInferiorityRatio: 0.90,
  currentTrafficFraction: 0.50,
  expandedTrafficFraction: 0.50,
  canaryMinBaselineSamples: 20,
  canaryMinCandidateSamples: 10,
};

export type LobPolicyDecision =
  | "HOLD"
  | "EXPAND"
  | "PROMOTE"
  | "REJECT"
  | "CONFIRM"
  | "ROLLBACK";

export interface LobPolicyEvaluation {
  decision: LobPolicyDecision;
  phase: Exclude<LobPolicyPhase, "IDLE">;
  reason: string;
  baseline: LobPolicyMetrics;
  candidate: LobPolicyMetrics;
  deltas: {
    winRate: number;
    winRateLowerBound: number;
    winRateUpperBound: number;
    meanNetBps: number;
    meanNetBpsLowerBound: number;
    meanNetBpsUpperBound: number;
    tradesPerAssignedScanRatio: number;
    tradesPerSlotHourRatio: number;
    capitalTurnsPerHourRatio: number;
    meanNotionalRatio: number;
    maxDrawdownRatio: number;
    commonMixCoverage: number;
    mixAdjustedWinRate: number;
    mixAdjustedMeanNetBps: number;
  };
  gates: Record<string, boolean>;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function ratio(left: number, right: number): number {
  if (right > 0) return left / right;
  return left > 0 ? Number.POSITIVE_INFINITY : 1;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStdDev(values: number[], average: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function policyLearningProfile(raw: Record<string, unknown> | null | undefined) {
  if (!raw || !Array.isArray(raw.patterns)) return null;
  const generatedAt = String(raw.generated_at ?? raw.generatedAt ?? "");
  return {
    generatedAtMs: Date.parse(generatedAt) || finite(raw.generatedAtMs, Date.now()),
    samples: Math.max(0, finite(raw.samples)),
    baseHitRate: clamp(finite(raw.base_hit_rate ?? raw.baseHitRate), 0, 1),
    patterns: raw.patterns as LobLearningProfile["patterns"],
    traps: Array.isArray(raw.traps) ? raw.traps as LobLearningProfile["traps"] : [],
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
  } satisfies LobLearningProfile;
}

/**
 * Stable FNV-1a-derived fraction. It makes scan assignment reproducible across isolates,
 * so retries cannot switch a scan from champion to challenger after seeing its candidates.
 */
export function stablePolicyFraction(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function resolveLobPolicyRuntime(rows: LobPolicyVersionRow[]): LobPolicyRuntime {
  const champion = rows
    .filter((row) => row.status === "CHAMPION")
    .sort((left, right) => finite(right.version) - finite(left.version))[0] ?? null;
  const alternate = rows
    .filter((row) => row.status === "CHALLENGER" || row.status === "CONTROL")
    .sort((left, right) => finite(right.version) - finite(left.version))[0] ?? null;
  return {
    champion,
    alternate,
    phase: alternate?.status === "CHALLENGER"
      ? "CHALLENGE"
      : alternate?.status === "CONTROL"
      ? "CONFIRMATION"
      : "IDLE",
  };
}

export function assignLobPolicy(
  runtime: LobPolicyRuntime,
  seed: string,
): LobPolicyBundle | null {
  const champion = runtime.champion;
  if (!champion) return null;
  const alternateFraction = clamp(finite(runtime.alternate?.traffic_fraction, 0.5), 0, 0.5);
  const selected = runtime.alternate && stablePolicyFraction(seed) < alternateFraction
    ? runtime.alternate
    : champion;
  const lane: LobPolicyLane = selected.status === "CHALLENGER"
    ? "CHALLENGER"
    : selected.status === "CONTROL"
    ? "CONTROL"
    : "CHAMPION";
  return {
    version: Math.max(0, Math.floor(finite(selected.version))),
    lane,
    status: selected.status,
    phase: runtime.phase,
    parentVersion: selected.parent_version == null
      ? null
      : Math.max(0, Math.floor(finite(selected.parent_version))),
    onlineProfiles: Array.isArray(selected.online_profiles)
      ? selected.online_profiles as LobOnlineProfileRow[]
      : [],
    patternProfile: policyLearningProfile(selected.pattern_profile),
    evaluationStartedAt: selected.evaluation_started_at
      ? String(selected.evaluation_started_at)
      : null,
    policyDefinition: normalizeLobAdaptivePolicy(
      selected.policy_definition || DEFAULT_LOB_ADAPTIVE_POLICY,
    ),
  };
}

export function policyBundleByVersion(
  runtime: LobPolicyRuntime,
  version: number,
): LobPolicyBundle | null {
  const selected = [runtime.champion, runtime.alternate].find((row) =>
    row && finite(row.version) === finite(version)
  );
  if (!selected || !runtime.champion) return null;
  const lane: LobPolicyLane = selected.status === "CHALLENGER"
    ? "CHALLENGER"
    : selected.status === "CONTROL"
    ? "CONTROL"
    : "CHAMPION";
  return {
    version: Math.max(0, Math.floor(finite(selected.version))),
    lane,
    status: selected.status,
    phase: runtime.phase,
    parentVersion: selected.parent_version == null
      ? null
      : Math.max(0, Math.floor(finite(selected.parent_version))),
    onlineProfiles: Array.isArray(selected.online_profiles)
      ? selected.online_profiles as LobOnlineProfileRow[]
      : [],
    patternProfile: policyLearningProfile(selected.pattern_profile),
    evaluationStartedAt: selected.evaluation_started_at
      ? String(selected.evaluation_started_at)
      : null,
    policyDefinition: normalizeLobAdaptivePolicy(
      selected.policy_definition || DEFAULT_LOB_ADAPTIVE_POLICY,
    ),
  };
}

export function calculateLobPolicyMetrics(
  trades: LobPolicyTrade[],
  exposures: LobPolicyExposure[] = [],
): LobPolicyMetrics {
  const usable = trades
    .filter((trade) =>
      Number.isFinite(finite(trade.netBps, Number.NaN)) &&
      finite(trade.heldSeconds) >= 0 &&
      finite(trade.notionalQuote) > 0
    )
    .map((trade) => ({
      ...trade,
      netBps: finite(trade.netBps),
      heldSeconds: Math.max(0.001, finite(trade.heldSeconds)),
      notionalQuote: Math.max(0.000001, finite(trade.notionalQuote)),
      closedAtMs: finite(trade.closedAtMs),
    }))
    .sort((left, right) => left.closedAtMs - right.closedAtMs);
  const nets = usable.map((trade) => trade.netBps);
  const samples = usable.length;
  const wins =
    usable.filter((trade) =>
      trade.profitable == null ? trade.netBps > 0 : Boolean(trade.profitable)
    ).length;
  const meanNetBps = mean(nets);
  const totalNotional = usable.reduce((sum, trade) => sum + trade.notionalQuote, 0);
  const totalHeldSeconds = usable.reduce((sum, trade) => sum + trade.heldSeconds, 0);
  type CurrencyCell = {
    samples: number;
    notional: number;
    capitalSeconds: number;
    weightedNet: number;
  };
  const currencyCells = new Map<string, CurrencyCell>();
  for (const trade of usable) {
    const key = String(trade.exchange || "__ALL__").toLowerCase();
    const cell = currencyCells.get(key) ??
      { samples: 0, notional: 0, capitalSeconds: 0, weightedNet: 0 };
    cell.samples++;
    cell.notional += trade.notionalQuote;
    cell.capitalSeconds += trade.notionalQuote * trade.heldSeconds;
    cell.weightedNet += trade.notionalQuote * trade.netBps;
    currencyCells.set(key, cell);
  }
  // KRW and USDT are incomparable quote units. Normalize inside each exchange first,
  // then sample-weight the rates; directly summing quote notionals would let the KRW lane
  // dominate every cross-exchange metric by several orders of magnitude.
  const notionalWeightedNetBps = samples
    ? [...currencyCells.values()].reduce(
      (sum, cell) =>
        sum + cell.samples * (cell.notional > 0 ? cell.weightedNet / cell.notional : 0),
      0,
    ) / samples
    : 0;
  const capitalTurnsPerHour = samples
    ? [...currencyCells.values()].reduce(
      (sum, cell) =>
        sum + cell.samples *
          (cell.capitalSeconds > 0 ? cell.notional / (cell.capitalSeconds / 3600) : 0),
      0,
    ) / samples
    : 0;
  // Profit factor is computed in return space for the same reason. Normal-size protection
  // is enforced separately by exchange, so quote-currency scale cannot fake PF.
  const grossProfitBps = usable.reduce((sum, trade) => sum + Math.max(0, trade.netBps), 0);
  const grossLossBps = usable.reduce((sum, trade) => sum + Math.max(0, -trade.netBps), 0);
  const logReturns = usable.map((trade) => Math.log1p(clamp(trade.netBps / 10_000, -0.9999, 100)));
  const geometricMeanBps = samples ? Math.expm1(mean(logReturns)) * 10_000 : 0;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const trade of usable) {
    equity *= 1 + clamp(trade.netBps / 10_000, -0.9999, 100);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? 1 - equity / peak : 0);
  }
  const exposureTotals = exposures.reduce((total, exposure) => ({
    scans: total.scans + 1,
    candidates: total.candidates + Math.max(0, Math.floor(finite(exposure.candidateCount))),
    attempts: total.attempts + Math.max(0, Math.floor(finite(exposure.entryAttempts))),
    reservations: total.reservations + Math.max(0, Math.floor(finite(exposure.reservations))),
  }), { scans: 0, candidates: 0, attempts: 0, reservations: 0 });
  const liveVerifiedSamples = usable.filter((trade) =>
    trade.liveVerified === true && String(trade.accountingQuality || "") !== "LEGACY_UNVERIFIED"
  ).length;
  const distinctMarkets = new Set(usable.map((trade) =>
    `${String(trade.exchange || "").toLowerCase()}:${String(trade.market || "").toUpperCase()}`
  ).filter((key) => key !== ":")).size;
  const independentTimeBlocks = new Set(usable.map((trade) =>
    Math.floor(Math.max(0, finite(trade.closedAtMs)) / 3_600_000)
  )).size;
  return {
    samples,
    wins,
    winRate: samples ? wins / samples : 0,
    meanNetBps,
    netStdDevBps: sampleStdDev(nets, meanNetBps),
    notionalWeightedNetBps,
    geometricMeanBps,
    profitFactor: grossLossBps > 0
      ? grossProfitBps / grossLossBps
      : grossProfitBps > 0
      ? Number.POSITIVE_INFINITY
      : 0,
    maxDrawdownBps: maxDrawdown * 10_000,
    meanHeldSeconds: samples ? totalHeldSeconds / samples : 0,
    meanNotionalQuote: samples ? totalNotional / samples : 0,
    tradesPerSlotHour: totalHeldSeconds > 0 ? samples / (totalHeldSeconds / 3600) : 0,
    capitalTurnsPerHour,
    assignedScans: exposureTotals.scans,
    candidatesSeen: exposureTotals.candidates,
    entryAttempts: exposureTotals.attempts,
    reservations: exposureTotals.reservations,
    tradesPerAssignedScan: exposureTotals.scans > 0 ? samples / exposureTotals.scans : 0,
    reservationsPerAssignedScan: exposureTotals.scans > 0
      ? exposureTotals.reservations / exposureTotals.scans
      : 0,
    fillPerReservation: exposureTotals.reservations > 0 ? samples / exposureTotals.reservations : 0,
    liveVerifiedSamples,
    liveVerifiedFraction: samples > 0 ? liveVerifiedSamples / samples : 0,
    distinctMarkets,
    independentTimeBlocks,
  };
}

function differenceBounds(
  candidateMean: number,
  candidateStdDev: number,
  candidateSamples: number,
  baselineMean: number,
  baselineStdDev: number,
  baselineSamples: number,
  zScore: number,
) {
  const delta = candidateMean - baselineMean;
  const variance = candidateSamples > 0 ? candidateStdDev ** 2 / candidateSamples : 0;
  const baselineVariance = baselineSamples > 0 ? baselineStdDev ** 2 / baselineSamples : 0;
  const margin = Math.max(0, zScore) * Math.sqrt(Math.max(0, variance + baselineVariance));
  return { delta, lower: delta - margin, upper: delta + margin };
}

function winDifferenceBounds(
  candidate: LobPolicyMetrics,
  baseline: LobPolicyMetrics,
  zScore: number,
) {
  const candidateVariance = candidate.samples > 0
    ? candidate.winRate * (1 - candidate.winRate) / candidate.samples
    : 0;
  const baselineVariance = baseline.samples > 0
    ? baseline.winRate * (1 - baseline.winRate) / baseline.samples
    : 0;
  const delta = candidate.winRate - baseline.winRate;
  const margin = Math.max(0, zScore) *
    Math.sqrt(Math.max(0, candidateVariance + baselineVariance));
  return { delta, lower: delta - margin, upper: delta + margin };
}

function exchangePatternMixDeltas(
  baselineTrades: LobPolicyTrade[],
  candidateTrades: LobPolicyTrade[],
) {
  type Cell = { samples: number; wins: number; netTotal: number };
  const cells = (trades: LobPolicyTrade[]) => {
    const grouped = new Map<string, Cell>();
    for (const trade of trades) {
      if (
        !Number.isFinite(finite(trade.netBps, Number.NaN)) ||
        finite(trade.notionalQuote) <= 0
      ) continue;
      const exchange = String(trade.exchange || "__ALL__").toLowerCase();
      const pattern = String(trade.pattern || "__ALL__").toUpperCase();
      const key = `${exchange}|${pattern}`;
      const current = grouped.get(key) ?? { samples: 0, wins: 0, netTotal: 0 };
      current.samples++;
      current.wins += trade.profitable == null
        ? Number(finite(trade.netBps) > 0)
        : Number(Boolean(trade.profitable));
      current.netTotal += finite(trade.netBps);
      grouped.set(key, current);
    }
    return grouped;
  };
  const baseline = cells(baselineTrades);
  const candidate = cells(candidateTrades);
  const notionals = (trades: LobPolicyTrade[]) => {
    const grouped = new Map<string, { samples: number; total: number }>();
    for (const trade of trades) {
      const notional = finite(trade.notionalQuote);
      if (notional <= 0) continue;
      const key = String(trade.exchange || "__ALL__").toLowerCase();
      const current = grouped.get(key) ?? { samples: 0, total: 0 };
      current.samples++;
      current.total += notional;
      grouped.set(key, current);
    }
    return grouped;
  };
  const baselineNotionals = notionals(baselineTrades);
  const candidateNotionals = notionals(candidateTrades);
  const totalSamples = [...baseline.values(), ...candidate.values()]
    .reduce((sum, cell) => sum + cell.samples, 0);
  let commonSamples = 0;
  let baselineWinTotal = 0;
  let candidateWinTotal = 0;
  let baselineNetTotal = 0;
  let candidateNetTotal = 0;
  let minimumNotionalRatio = Number.POSITIVE_INFINITY;
  for (const [key, baselineCell] of baseline) {
    const candidateCell = candidate.get(key);
    if (!candidateCell) continue;
    const pooledSamples = baselineCell.samples + candidateCell.samples;
    commonSamples += pooledSamples;
    baselineWinTotal += pooledSamples * baselineCell.wins / baselineCell.samples;
    candidateWinTotal += pooledSamples * candidateCell.wins / candidateCell.samples;
    baselineNetTotal += pooledSamples * baselineCell.netTotal / baselineCell.samples;
    candidateNetTotal += pooledSamples * candidateCell.netTotal / candidateCell.samples;
  }
  for (const [key, baselineCell] of baselineNotionals) {
    const candidateCell = candidateNotionals.get(key);
    if (!candidateCell) continue;
    minimumNotionalRatio = Math.min(
      minimumNotionalRatio,
      ratio(
        candidateCell.total / candidateCell.samples,
        baselineCell.total / baselineCell.samples,
      ),
    );
  }
  return {
    coverage: totalSamples > 0 ? commonSamples / totalSamples : 0,
    winRateDelta: commonSamples > 0 ? (candidateWinTotal - baselineWinTotal) / commonSamples : 0,
    meanNetBpsDelta: commonSamples > 0 ? (candidateNetTotal - baselineNetTotal) / commonSamples : 0,
    minimumNotionalRatio: Number.isFinite(minimumNotionalRatio) ? minimumNotionalRatio : 0,
  };
}

/**
 * A policy begins at a bounded 15% canary, expands to 50% only when accounting-verified
 * live evidence is non-harmful, and promotes only after positive net expectancy plus
 * non-inferiority on win rate, turnover, order size, market mix and drawdown. The same
 * contract is reused after promotion against a live control, otherwise it is rolled back.
 */
export function evaluateLobPolicy(
  baselineTrades: LobPolicyTrade[],
  candidateTrades: LobPolicyTrade[],
  baselineExposures: LobPolicyExposure[],
  candidateExposures: LobPolicyExposure[],
  phase: Exclude<LobPolicyPhase, "IDLE">,
  overrides: Partial<LobPolicyPromotionConfig> = {},
): LobPolicyEvaluation {
  const cfg = { ...DEFAULT_LOB_POLICY_PROMOTION_CONFIG, ...overrides };
  const baseline = calculateLobPolicyMetrics(baselineTrades, baselineExposures);
  const candidate = calculateLobPolicyMetrics(candidateTrades, candidateExposures);
  const net = differenceBounds(
    candidate.meanNetBps,
    candidate.netStdDevBps,
    candidate.samples,
    baseline.meanNetBps,
    baseline.netStdDevBps,
    baseline.samples,
    cfg.zScore,
  );
  const win = winDifferenceBounds(candidate, baseline, cfg.zScore);
  const mix = exchangePatternMixDeltas(baselineTrades, candidateTrades);
  const deltas = {
    winRate: win.delta,
    winRateLowerBound: win.lower,
    winRateUpperBound: win.upper,
    meanNetBps: net.delta,
    meanNetBpsLowerBound: net.lower,
    meanNetBpsUpperBound: net.upper,
    tradesPerAssignedScanRatio: ratio(
      candidate.tradesPerAssignedScan,
      baseline.tradesPerAssignedScan,
    ),
    tradesPerSlotHourRatio: ratio(candidate.tradesPerSlotHour, baseline.tradesPerSlotHour),
    capitalTurnsPerHourRatio: ratio(
      candidate.capitalTurnsPerHour,
      baseline.capitalTurnsPerHour,
    ),
    meanNotionalRatio: mix.minimumNotionalRatio,
    maxDrawdownRatio: ratio(candidate.maxDrawdownBps, baseline.maxDrawdownBps),
    commonMixCoverage: mix.coverage,
    mixAdjustedWinRate: mix.winRateDelta,
    mixAdjustedMeanNetBps: mix.meanNetBpsDelta,
  };
  const enoughSamples = baseline.samples >= cfg.minSamplesPerArm &&
    candidate.samples >= cfg.minSamplesPerArm;
  const enoughScans = baseline.assignedScans >= cfg.minAssignedScansPerArm &&
    candidate.assignedScans >= cfg.minAssignedScansPerArm;
  const gates = {
    enough_samples: enoughSamples,
    enough_assigned_scans: enoughScans,
    live_verified_labels: baseline.liveVerifiedFraction >= cfg.minLiveVerifiedFraction &&
      candidate.liveVerifiedFraction >= cfg.minLiveVerifiedFraction,
    live_market_breadth: baseline.distinctMarkets >= cfg.minDistinctMarketsPerArm &&
      candidate.distinctMarkets >= cfg.minDistinctMarketsPerArm,
    live_time_breadth: baseline.independentTimeBlocks >= cfg.minIndependentBlocksPerArm &&
      candidate.independentTimeBlocks >= cfg.minIndependentBlocksPerArm,
    positive_net_after_costs: candidate.meanNetBps > 0 &&
      candidate.notionalWeightedNetBps > 0 &&
      candidate.geometricMeanBps > 0 &&
      candidate.profitFactor > cfg.minProfitFactor,
    net_return_improved: net.delta > 0 && net.lower >= -cfg.netNonInferiorityBps,
    win_rate_improved: win.lower >= -cfg.winRateNonInferiority,
    completed_trade_rate_preserved: deltas.tradesPerAssignedScanRatio >=
      cfg.turnoverNonInferiorityRatio,
    slot_turnover_preserved: deltas.tradesPerSlotHourRatio >= cfg.turnoverNonInferiorityRatio,
    capital_turnover_preserved: deltas.capitalTurnsPerHourRatio >=
      cfg.turnoverNonInferiorityRatio,
    notional_preserved: deltas.meanNotionalRatio >= cfg.minNotionalRatio,
    exchange_pattern_mix_preserved: mix.coverage >= cfg.minCommonMixCoverage &&
      mix.winRateDelta >= -Math.min(0.01, cfg.winRateNonInferiority) &&
      mix.meanNetBpsDelta >= 0,
    drawdown_not_materially_worse: baseline.maxDrawdownBps <= 0
      ? candidate.maxDrawdownBps <= cfg.netNonInferiorityBps
      : deltas.maxDrawdownRatio <= cfg.maxDrawdownRatio,
    meaningful_improvement: net.lower > 0 || win.lower > 0 ||
      deltas.capitalTurnsPerHourRatio >= 1.05 ||
      deltas.tradesPerAssignedScanRatio >= 1.05,
  };
  const canaryReady = cfg.currentTrafficFraction < cfg.expandedTrafficFraction &&
    baseline.samples >= cfg.canaryMinBaselineSamples &&
    candidate.samples >= cfg.canaryMinCandidateSamples;
  const canarySafe = canaryReady &&
    gates.live_verified_labels &&
    gates.live_market_breadth &&
    gates.live_time_breadth &&
    candidate.meanNetBps > 0 && candidate.profitFactor >= 0.90 &&
    net.upper >= -cfg.netNonInferiorityBps &&
    win.upper >= -cfg.winRateNonInferiority &&
    deltas.tradesPerAssignedScanRatio >= 0.75 &&
    deltas.capitalTurnsPerHourRatio >= 0.75 &&
    gates.drawdown_not_materially_worse;
  if (canarySafe) {
    return {
      decision: "EXPAND",
      phase,
      reason: "canary is live-verified and non-harmful; expanding traffic for decisive comparison",
      baseline,
      candidate,
      deltas,
      gates,
    };
  }

  const passed = Object.values(gates).every(Boolean);
  if (passed) {
    return {
      decision: phase === "CHALLENGE" ? "PROMOTE" : "CONFIRM",
      phase,
      reason: phase === "CHALLENGE"
        ? "challenger improved net return and win rate without reducing trade or capital turnover"
        : "provisional champion repeated the joint improvement against its live control",
      baseline,
      candidate,
      deltas,
      gates,
    };
  }

  const earlySamples = baseline.samples >= cfg.earlyStopSamplesPerArm &&
    candidate.samples >= cfg.earlyStopSamplesPerArm;
  const clearlyHarmful = earlySamples && (
    net.upper < 0 ||
    win.upper < 0 ||
    (candidate.meanNetBps < 0 && candidate.profitFactor < 0.8)
  );
  const exhausted = baseline.samples >= cfg.maxSamplesPerArm &&
    candidate.samples >= cfg.maxSamplesPerArm;
  const exposureExhausted = baseline.assignedScans >= cfg.maxSamplesPerArm * 2 &&
    candidate.assignedScans >= cfg.maxSamplesPerArm * 2;
  if (clearlyHarmful || exhausted || exposureExhausted) {
    return {
      decision: phase === "CHALLENGE" ? "REJECT" : "ROLLBACK",
      phase,
      reason: clearlyHarmful
        ? "candidate is already statistically worse on return or win rate"
        : "candidate exhausted its evaluation budget without joint dominance",
      baseline,
      candidate,
      deltas,
      gates,
    };
  }
  return {
    decision: "HOLD",
    phase,
    reason: enoughSamples && enoughScans
      ? "joint dominance has not reached the confidence boundary"
      : "collecting contemporaneous accounting-verified live cohorts",
    baseline,
    candidate,
    deltas,
    gates,
  };
}
