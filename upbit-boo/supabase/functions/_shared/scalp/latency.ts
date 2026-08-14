// Trading-booooo v6.5.1-GUARD — end-to-end execution latency measurement.
//
// WHY THIS EXISTS
// ---------------
// `cost-model.ts` has carried `latencyPenalty: 0.0001` since v5.2. One basis point, flat,
// for every symbol on both exchanges, chosen before a single millisecond was ever measured.
// It is subtracted from the edge of every trade and it therefore decides which trades are
// taken — a constant with no measurement behind it sitting inside the gate.
//
// The same gap shows up from the other direction. `lob_max_book_age_ms` defaults to 2500
// and rejects a book older than that, but nothing records how old the book actually was by
// the time the order left, so the engine cannot distinguish "the signal was wrong" from
// "the signal was right two seconds ago".
//
// This module measures the path instead of assuming it, in five stamps:
//
//   book_captured  -> the exchange's own timestamp on the orderbook
//   quote_received -> the gateway response is in the autotrader's hands
//   decision_made  -> the entry decision has been computed
//   order_submitted-> the order request has left the autotrader
//   order_acked    -> the gateway reports the exchange accepted it
//
// From those, three intervals matter:
//
//   tick-to-decision  book_captured -> decision_made   (is the signal stale when we act?)
//   tick-to-order     book_captured -> order_submitted (how old is the book we traded on?)
//   order round trip  order_submitted -> order_acked   (transport + exchange)
//
// LATENCY AS A COST, NOT A CONSTANT
// ---------------------------------
// Waiting t seconds before the order lands exposes the fill to whatever the price does in
// the meantime. Under a driftless random walk the price at t has standard deviation
// sigma*sqrt(t), and the part that moves against a buyer has expectation
//
//     E[max(0, -X)] = sigma * sqrt(t) / sqrt(2*pi)
//
// so the penalty grows with the SQUARE ROOT of latency and scales with the symbol's own
// volatility. A flat constant is wrong in both directions at once: far too large for a
// quiet book reached in 300ms, far too small for a hot one reached in four seconds.
//
// Pure functions only — no I/O.

/** Points on the execution path, in the order they occur. */
export type LatencyStage =
  | "book_captured"
  | "quote_received"
  | "decision_made"
  | "order_submitted"
  | "order_acked";

export const LATENCY_STAGES: LatencyStage[] = [
  "book_captured",
  "quote_received",
  "decision_made",
  "order_submitted",
  "order_acked",
];

/** Epoch-millisecond stamps collected along one decision. Any stage may be missing. */
export type LatencyStamps = Partial<Record<LatencyStage, number>>;

export interface LatencySegments {
  /** Exchange book timestamp -> gateway response in hand. Transport + gateway fetch. */
  bookToQuoteMs: number | null;
  /** Quote in hand -> decision computed. Our own compute time. */
  quoteToDecisionMs: number | null;
  /** Decision computed -> order request sent. Sizing, rules lookup, record creation. */
  decisionToOrderMs: number | null;
  /** Order sent -> exchange acknowledged. Transport + matching engine. */
  orderRoundTripMs: number | null;
  /** book_captured -> decision_made. The age of the evidence at the moment of choosing. */
  tickToDecisionMs: number | null;
  /** book_captured -> order_submitted. The age of the evidence at the moment of acting. */
  tickToOrderMs: number | null;
  /** book_captured -> order_acked. Total exposure of the decision to a moving market. */
  tickToAckMs: number | null;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export const EMPTY_SUMMARY: LatencySummary = {
  count: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  max: 0,
  mean: 0,
};

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function delta(stamps: LatencyStamps, from: LatencyStage, to: LatencyStage): number | null {
  const a = finite(stamps[from]);
  const b = finite(stamps[to]);
  if (a === null || b === null) return null;
  // Clock skew between the exchange's stamp and ours can make this negative. Report it as
  // zero rather than dropping the sample: a negative interval is a clock problem, not a
  // measurement of speed, and silently discarding it would bias the percentiles downward.
  return Math.max(0, b - a);
}

/** Derive every interval from whatever stamps are present. */
export function segmentsOf(stamps: LatencyStamps): LatencySegments {
  return {
    bookToQuoteMs: delta(stamps, "book_captured", "quote_received"),
    quoteToDecisionMs: delta(stamps, "quote_received", "decision_made"),
    decisionToOrderMs: delta(stamps, "decision_made", "order_submitted"),
    orderRoundTripMs: delta(stamps, "order_submitted", "order_acked"),
    tickToDecisionMs: delta(stamps, "book_captured", "decision_made"),
    tickToOrderMs: delta(stamps, "book_captured", "order_submitted"),
    tickToAckMs: delta(stamps, "book_captured", "order_acked"),
  };
}

/**
 * Nearest-rank percentile.
 *
 * Deliberately not interpolated: at the sample counts this will see in its first days
 * (tens, not thousands) an interpolated p99 invents a number that lies between two
 * observations and was never observed. The nearest rank is always a real measurement.
 */
export function percentile(values: number[], quantile: number): number {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const q = Math.max(0, Math.min(1, quantile));
  const rank = Math.ceil(q * clean.length);
  return clean[Math.max(0, Math.min(clean.length - 1, rank - 1))];
}

export function summarize(values: number[]): LatencySummary {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return { ...EMPTY_SUMMARY };
  return {
    count: clean.length,
    p50: percentile(clean, 0.50),
    p95: percentile(clean, 0.95),
    p99: percentile(clean, 0.99),
    max: Math.max(...clean),
    mean: clean.reduce((sum, v) => sum + v, 0) / clean.length,
  };
}

// ---------------------------------------------------------------------------
// Latency as a cost
// ---------------------------------------------------------------------------

export interface LatencyCostInput {
  /** Latency to charge for, in milliseconds. Use p95, not the mean — see below. */
  latencyMs: number;
  /**
   * The symbol's volatility, as a fraction of price, over `sigmaHorizonSeconds`.
   * ATR is a mean range rather than a standard deviation, so callers converting from ATR
   * should apply the same 0.625 factor the geometry module uses.
   */
  sigma: number;
  /** The horizon `sigma` was measured over. 5-minute candles => 300. */
  sigmaHorizonSeconds: number;
}

export interface LatencyCostConfig {
  /** Charged even at zero measured latency: clock granularity and unmodelled hops. */
  floorBps: number;
  /** Nothing may charge more than this, however bad a single measurement looks. */
  ceilingBps: number;
  /** Used until a measurement exists. Zero means observe first and charge only measured cost. */
  unmeasuredBps: number;
  /** Below this many samples the measurement is not trusted on its own. */
  minSamples: number;
  /** Samples at which the measurement carries half the weight against `unmeasuredBps`. */
  priorStrength: number;
}

export const DEFAULT_LATENCY_COST: LatencyCostConfig = {
  floorBps: 0.05,
  ceilingBps: 15,
  unmeasuredBps: 0,
  minSamples: 20,
  priorStrength: 60,
};

/**
 * Expected adverse price move over `latencyMs`, in basis points.
 *
 * p95 rather than p50 is deliberate. The cost is not the typical delay, it is the delay
 * that is bad enough to matter, and a scalper that sizes to its median latency is
 * systematically underpricing its own tail.
 */
export function latencyCostBps(
  input: LatencyCostInput,
  config: Partial<LatencyCostConfig> = {},
): number {
  const cfg = { ...DEFAULT_LATENCY_COST, ...config };
  const ms = finite(input.latencyMs);
  const sigma = finite(input.sigma);
  const horizon = finite(input.sigmaHorizonSeconds);
  if (ms === null || sigma === null || horizon === null || horizon <= 0 || sigma <= 0) {
    return cfg.unmeasuredBps;
  }
  const seconds = Math.max(0, ms) / 1000;
  // sigma scales with sqrt(time), so rebase from the measurement horizon to one second.
  const sigmaPerRootSecond = sigma / Math.sqrt(horizon);
  // E[max(0, -X)] for X ~ N(0, s^2) is s / sqrt(2*pi).
  const adverse = sigmaPerRootSecond * Math.sqrt(seconds) / Math.sqrt(2 * Math.PI);
  return Math.max(cfg.floorBps, Math.min(cfg.ceilingBps, adverse * 10_000));
}

/**
 * Blend a measured latency cost toward the unmeasured default by sample count.
 *
 * A single slow morning must not be allowed to widen every barrier in the system, and
 * twenty samples must not be treated as if they were two thousand. The weight is
 * n/(n+priorStrength), which is the same shrinkage the edge-budget calibration uses.
 */
export function shrunkLatencyCostBps(
  measuredBps: number,
  samples: number,
  config: Partial<LatencyCostConfig> = {},
): number {
  const cfg = { ...DEFAULT_LATENCY_COST, ...config };
  const n = Math.max(0, Math.floor(finite(samples) ?? 0));
  if (n < cfg.minSamples) return cfg.unmeasuredBps;
  const measured = finite(measuredBps);
  if (measured === null) return cfg.unmeasuredBps;
  const weight = n / (n + cfg.priorStrength);
  const blended = measured * weight + cfg.unmeasuredBps * (1 - weight);
  return Math.max(cfg.floorBps, Math.min(cfg.ceilingBps, blended));
}

/**
 * Latency cost derived from the book's own measured noise band.
 *
 * The LOB path already measures `noiseBandBps` — the median distance price travels
 * against a long opened at an arbitrary moment during the observation window. That is the
 * same quantity a late order is exposed to, measured on the same book, so no normality
 * assumption and no ATR conversion is needed. Only the horizon differs, and excursion
 * scales with the square root of time:
 *
 *     penalty(t) = noiseBand * sqrt(t / observationWindow)
 *
 * At 300ms against an 8s window this is about a fifth of the band; at 4s it is about
 * seventy percent of it. Both are far more informative than one basis point.
 */
export function latencyCostFromNoiseBandBps(
  input: { noiseBandBps: number; latencyMs: number; observationWindowMs: number },
  config: Partial<LatencyCostConfig> = {},
): number {
  const cfg = { ...DEFAULT_LATENCY_COST, ...config };
  const band = finite(input.noiseBandBps);
  const ms = finite(input.latencyMs);
  const window = finite(input.observationWindowMs);
  if (band === null || ms === null || window === null || !(band > 0) || !(window > 0)) {
    return cfg.unmeasuredBps;
  }
  const scaled = band * Math.sqrt(Math.max(0, ms) / window);
  return Math.max(cfg.floorBps, Math.min(cfg.ceilingBps, scaled));
}

export interface ResolvedLatencyPenaltyInput {
  noiseBandBps: number;
  observationWindowMs: number;
  measured: boolean;
  measuredP95Ms: number;
  measuredSamples: number;
  operatorPriorBps: number;
  assumedP95Ms: number;
  unmeasuredFloorBps: number;
  penaltyMultiplier?: number;
}

export interface ResolvedLatencyPenalty {
  bps: number;
  source:
    | "NOISE_BAND_X_MEASURED_P95_SHRUNK"
    | "NOISE_BAND_X_ASSUMED_P95"
    | "CONSERVATIVE_UNMEASURED_FLOOR";
}

/**
 * Resolve a latency charge even before the measurement loop matures.
 *
 * The previous runtime returned zero whenever `scalp_latency_source` was UNMEASURED. That
 * made the shortest-horizon strategy assume instantaneous execution exactly when it knew
 * least about the path. The fallback now uses the same book noise model with a bounded
 * assumed p95, or a small operator floor when the book cannot price itself.
 */
export function resolveLatencyPenaltyBps(
  input: ResolvedLatencyPenaltyInput,
): ResolvedLatencyPenalty {
  const prior = Math.max(0, Number(input.operatorPriorBps) || 0);
  const floor = Math.max(0.25, Number(input.unmeasuredFloorBps) || 0, prior);
  const multiplier = Math.max(0.75, Math.min(1.75, Number(input.penaltyMultiplier) || 1));
  if (input.measured && input.measuredP95Ms > 0 && input.noiseBandBps > 0 && input.observationWindowMs > 0) {
    const raw = latencyCostFromNoiseBandBps({
      noiseBandBps: input.noiseBandBps,
      latencyMs: input.measuredP95Ms,
      observationWindowMs: input.observationWindowMs,
    }, { floorBps: 0, unmeasuredBps: floor });
    return {
      bps: Math.min(15, shrunkLatencyCostBps(raw, input.measuredSamples, {
        floorBps: floor,
        unmeasuredBps: floor,
      }) * multiplier),
      source: "NOISE_BAND_X_MEASURED_P95_SHRUNK",
    };
  }
  if (input.noiseBandBps > 0 && input.observationWindowMs > 0) {
    const raw = latencyCostFromNoiseBandBps({
      noiseBandBps: input.noiseBandBps,
      latencyMs: Math.max(250, input.assumedP95Ms),
      observationWindowMs: input.observationWindowMs,
    }, { floorBps: floor, unmeasuredBps: floor });
    return {
      bps: Math.min(15, Math.max(floor, raw) * multiplier),
      source: "NOISE_BAND_X_ASSUMED_P95",
    };
  }
  return {
    bps: Math.min(15, floor * multiplier),
    source: "CONSERVATIVE_UNMEASURED_FLOOR",
  };
}

// ---------------------------------------------------------------------------
// Service level
// ---------------------------------------------------------------------------

export interface LatencySloConfig {
  /** p95 tick-to-order above this means the book we act on is materially stale. */
  maxTickToOrderP95Ms: number;
  /** p99 tick-to-order above this is a hard breach regardless of the p95. */
  maxTickToOrderP99Ms: number;
  /** Our own compute time. Anything large here is ours to fix, not the network's. */
  maxQuoteToDecisionP95Ms: number;
  /** Fraction of decisions that must carry a usable book timestamp. */
  minCoverage: number;
  /** No verdict is issued below this many samples. */
  minSamples: number;
}

export const DEFAULT_LATENCY_SLO: LatencySloConfig = {
  // The entry gate rejects a book older than lob_max_book_age_ms (2500 by default).
  // Acting on a book that is already older than the freshness the gate claims to enforce
  // is the specific failure this measures, so the SLO is anchored to that number.
  maxTickToOrderP95Ms: 2500,
  maxTickToOrderP99Ms: 5000,
  maxQuoteToDecisionP95Ms: 400,
  minCoverage: 0.80,
  minSamples: 30,
};

export interface LatencySloVerdict {
  verdict: "OK" | "BREACHED" | "INSUFFICIENT_DATA";
  breaches: string[];
  /** Fraction of decisions for which a book timestamp was available at all. */
  coverage: number;
}

export function evaluateLatencySlo(
  input: {
    tickToOrder: LatencySummary;
    quoteToDecision: LatencySummary;
    decisionsSeen: number;
  },
  config: Partial<LatencySloConfig> = {},
): LatencySloVerdict {
  const cfg = { ...DEFAULT_LATENCY_SLO, ...config };
  const decisions = Math.max(0, finite(input.decisionsSeen) ?? 0);
  const coverage = decisions > 0 ? input.tickToOrder.count / decisions : 0;
  if (input.tickToOrder.count < cfg.minSamples) {
    return { verdict: "INSUFFICIENT_DATA", breaches: [], coverage };
  }
  const breaches: string[] = [];
  if (input.tickToOrder.p95 > cfg.maxTickToOrderP95Ms) {
    breaches.push(
      `tick_to_order_p95 ${Math.round(input.tickToOrder.p95)}ms > ${cfg.maxTickToOrderP95Ms}ms`,
    );
  }
  if (input.tickToOrder.p99 > cfg.maxTickToOrderP99Ms) {
    breaches.push(
      `tick_to_order_p99 ${Math.round(input.tickToOrder.p99)}ms > ${cfg.maxTickToOrderP99Ms}ms`,
    );
  }
  if (input.quoteToDecision.count >= cfg.minSamples &&
    input.quoteToDecision.p95 > cfg.maxQuoteToDecisionP95Ms
  ) {
    breaches.push(
      `quote_to_decision_p95 ${Math.round(input.quoteToDecision.p95)}ms > ${cfg.maxQuoteToDecisionP95Ms}ms`,
    );
  }
  // Missing book timestamps are themselves a finding: it means most decisions cannot be
  // audited for staleness at all, which is the state the system was in before v6.5.
  if (coverage < cfg.minCoverage) {
    breaches.push(`book timestamp coverage ${(coverage * 100).toFixed(0)}% < ${(cfg.minCoverage * 100).toFixed(0)}%`);
  }
  return { verdict: breaches.length ? "BREACHED" : "OK", breaches, coverage };
}

// ---------------------------------------------------------------------------
// Trace construction
// ---------------------------------------------------------------------------

/**
 * Collects stamps for one decision. Deliberately tolerant: a stage that is never stamped
 * simply yields a null interval. Instrumentation must never be able to break execution,
 * which is exactly the mistake the swallowed `.catch` made in v6.3.
 */
export class LatencyTrace {
  readonly decisionId: string;
  readonly exchange: string;
  readonly market: string;
  private readonly stamps: LatencyStamps = {};

  constructor(decisionId: string, exchange: string, market: string) {
    this.decisionId = decisionId;
    this.exchange = exchange;
    this.market = market;
  }

  /** Record a stage. `at` defaults to now; pass an exchange timestamp where one exists. */
  mark(stage: LatencyStage, at?: number | null): this {
    const value = finite(at ?? Date.now());
    if (value !== null && value > 0) this.stamps[stage] = value;
    return this;
  }

  has(stage: LatencyStage): boolean {
    return finite(this.stamps[stage]) !== null;
  }

  segments(): LatencySegments {
    return segmentsOf(this.stamps);
  }

  /** Row shape for `trading_latency_samples`. */
  toRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const segments = this.segments();
    return {
      decision_id: this.decisionId,
      exchange: this.exchange,
      market: this.market,
      book_captured_at: this.stamps.book_captured
        ? new Date(this.stamps.book_captured).toISOString()
        : null,
      book_to_quote_ms: segments.bookToQuoteMs,
      quote_to_decision_ms: segments.quoteToDecisionMs,
      decision_to_order_ms: segments.decisionToOrderMs,
      order_round_trip_ms: segments.orderRoundTripMs,
      tick_to_decision_ms: segments.tickToDecisionMs,
      tick_to_order_ms: segments.tickToOrderMs,
      tick_to_ack_ms: segments.tickToAckMs,
      ...extra,
    };
  }
}

/**
 * Pull the exchange's own book timestamp out of a gateway quote.
 *
 * Upbit returns `timestamp` on the orderbook payload; Binance's depth endpoint has no
 * timestamp at all, so the gateway stamps the moment the response was received and that
 * is the best available anchor. Returning null when neither exists is correct — a
 * fabricated timestamp would make the staleness measurement look perfect.
 */
export function bookTimestampOf(quote: unknown): number | null {
  const q = quote as Record<string, any> | null;
  if (!q) return null;
  const candidates = [
    q.timing?.book_captured_at_ms,
    q.raw?.book?.timestamp,
    q.raw?.ticker?.timestamp,
    q.timing?.received_at_ms,
  ];
  for (const value of candidates) {
    const n = finite(value);
    // Reject anything that is not a plausible epoch-millisecond value in this era.
    if (n !== null && n > 1_600_000_000_000 && n < 4_000_000_000_000) return n;
  }
  return null;
}
