// Scan funnel diagnostics (Stage 2 — pure, additive to the scan response).
//
// Problem this solves (raised in GPT review): a single NO_BUY banner cannot tell
// apart "scanned everything, no candidate" from "candles empty", "websocket stale",
// "one hard gate blocked all", or "an exception skipped a stage". This records how
// many instruments pass/drop at EACH pipeline stage plus data-freshness signals, so
// a 0-trade state is diagnosable at a glance.
//
// Pure: no side effects, no decision changes. The caller assembles counts from
// existing pipeline variables and attaches the result to the scan response.

export interface ScanFunnel {
  total_instruments: number; // markets/tickers fetched from the exchange
  universe: number;          // after building the tradable universe
  eligible: number;          // safety filter pass (liquidity/turnover/etc.)
  shortlist: number;         // precision shortlist (deep-scan set)
  analyzed: number;          // period/trend analysis produced
  finalists: number;         // orderflow-analysis input set
  final_candidates: number;  // fully finalized candidates
  buy: number;               // decision === BUY
}

export interface WebsocketHealth {
  markets_with_ws: number;       // markets that received live book/trade events
  observation_ms: number;        // dynamic observation window used
  newest_snapshot_age_ms: number | null; // freshest book age vs scan end (lower = fresher)
  stale_markets: number;         // markets whose freshest book exceeded the stale threshold
  stale_threshold_ms: number;
}

export interface ScanDiagnostics {
  scanned_at: string;
  duration_ms: number;
  exchange: string;
  status: string;
  funnel: ScanFunnel;
  decisions: Record<string, number>;   // BUY / WAIT / AVOID tallies
  drop_reasons: Record<string, number>; // failed_gates tallied across finalists
  websocket: WebsocketHealth;
}

export const DEFAULT_STALE_THRESHOLD_MS = 5_000;

/** Tally decision labels across finalized candidates. */
export function tallyDecisions(candidates: Array<{ decision: string }>): Record<string, number> {
  const out: Record<string, number> = { BUY: 0, WAIT: 0, AVOID: 0 };
  for (const c of candidates) out[c.decision] = (out[c.decision] || 0) + 1;
  return out;
}

/** Tally failed-gate keys across finalized candidates (why they were not BUY). */
export function tallyDropReasons(candidates: Array<{ failed_gates?: string[] }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) {
    for (const key of c.failed_gates || []) out[key] = (out[key] || 0) + 1;
  }
  // Sort by frequency (desc) into a new ordered object.
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/**
 * Compute websocket freshness from the collected snapshot buckets.
 * `snapshots` maps market -> array of { timestamp } (ms epoch or parseable).
 * A market is "stale" if its freshest snapshot is older than the threshold, or absent.
 */
export function websocketHealth(
  snapshots: Map<string, Array<{ timestamp?: number | string }>>,
  markets: string[],
  scanEndMs: number,
  websocketMarkets: number,
  observationMs: number,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): WebsocketHealth {
  let newestAge: number | null = null;
  let stale = 0;
  for (const market of markets) {
    const bucket = snapshots.get(market) || [];
    let freshest = -Infinity;
    for (const s of bucket) {
      const t = typeof s.timestamp === "string" ? Number(s.timestamp) : (s.timestamp ?? NaN);
      if (Number.isFinite(t) && t > freshest) freshest = t;
    }
    if (freshest === -Infinity) {
      stale += 1;
      continue;
    }
    const age = scanEndMs - freshest;
    if (age > staleThresholdMs) stale += 1;
    if (newestAge === null || age < newestAge) newestAge = age;
  }
  return {
    markets_with_ws: websocketMarkets,
    observation_ms: observationMs,
    newest_snapshot_age_ms: newestAge,
    stale_markets: stale,
    stale_threshold_ms: staleThresholdMs,
  };
}

export function buildScanDiagnostics(args: {
  startedMs: number;
  endMs: number;
  exchange: string;
  status: string;
  funnel: ScanFunnel;
  candidates: Array<{ decision: string; failed_gates?: string[] }>;
  websocket: WebsocketHealth;
}): ScanDiagnostics {
  return {
    scanned_at: new Date(args.endMs).toISOString(),
    duration_ms: args.endMs - args.startedMs,
    exchange: args.exchange,
    status: args.status,
    funnel: args.funnel,
    decisions: tallyDecisions(args.candidates),
    drop_reasons: tallyDropReasons(args.candidates),
    websocket: args.websocket,
  };
}
