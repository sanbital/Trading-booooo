// Trading-booooo v5.3 — scalp pWin calibration job.
//
// Reads closed LIVE scalp positions, reconstructs (predicted pWin -> realized outcome)
// pairs from `trading_positions.metadata.scalp_signal`, fits a Platt calibration on a
// chronological train split, and promotes it only if it beats the incumbent on a holdout
// it never saw.
//
// This exists because the scalp probability model has never been measured. The existing
// forward-learning job learns scoreThreshold / minNetRR / shortTargetAtrMult / stopAtrMult
// — all TREND parameters — and filters candidates on period_score and net_rr, which SCALP
// does not gate on. It cannot correct pWin, and never could.
//
// Read-only against trading data; the only write is the calibration profile.

import {
  DEFAULT_EDGE_PROPOSAL,
  measureEdge,
  proposeEdgeBudget,
  resolveBarrierOutcome,
  type Candle,
  type ShadowSample,
} from "../_shared/scalp/shadow.ts";
import {
  DEFAULT_CALIBRATION_FIT,
  evaluatePromotion,
  IDENTITY_CALIBRATION,
  realizedResolveRate,
  reliabilityBins,
  type CalibrationModel,
  type CalibrationSample,
} from "../_shared/scalp/calibration.ts";
import {
  DEFAULT_LATENCY_SLO,
  evaluateLatencySlo,
  summarize,
} from "../_shared/scalp/latency.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

function allowed(request: Request): boolean {
  const expected = (Deno.env.get("LEARNING_ACCESS_TOKEN") || "").trim();
  const supplied = (request.headers.get("x-learning-token") || "").trim();
  return expected.length >= 32 && supplied.length > 0 && constantTimeEqual(expected, supplied);
}

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`db ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
  return db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

interface ClosedPosition {
  id: string;
  closed_at: string;
  close_reason: string | null;
  t1_completed: boolean | null;
  realized_pnl_quote: number | null;
  metadata: Record<string, any> | null;
}

export interface ExtractedSample extends CalibrationSample {
  resolved: boolean;
  closedAt: string;
}

/**
 * Outcome definition.
 *
 *   win      = the first target was reached (t1_completed). This is exactly what pWin
 *              claims to predict, and it is independent of how the runner later closed —
 *              a position that took T1 and then trailed out is still a target hit.
 *   loss     = the stop resolved without the target ever being reached.
 *   unresolved = time exit, emergency liquidation, manual reconciliation. These are NOT
 *              pWin samples: pWin is conditional on the trade resolving at a barrier.
 *              They inform resolveProbability instead.
 */
export function extractSamples(rows: ClosedPosition[]): ExtractedSample[] {
  const out: ExtractedSample[] = [];
  for (const row of rows || []) {
    const signal = row.metadata?.scalp_signal;
    const predicted = Number(signal?.order_p_win);
    if (!Number.isFinite(predicted) || predicted <= 0 || predicted >= 1) continue;
    const reason = String(row.close_reason || "").toUpperCase();
    const won = row.t1_completed === true;
    const lost = !won && (reason === "STOP" || reason === "TRAIL");
    if (!won && !lost) {
      out.push({ predicted, outcome: 0, resolved: false, closedAt: row.closed_at });
      continue;
    }
    out.push({ predicted, outcome: won ? 1 : 0, resolved: true, closedAt: row.closed_at });
  }
  return out;
}

async function loadIncumbent(): Promise<CalibrationModel> {
  const rows = await db("scalp_calibration_profiles?active=eq.true&select=*&limit=1");
  const row = rows?.[0];
  if (!row) return { ...IDENTITY_CALIBRATION };
  return {
    a: Number(row.slope) || 1,
    b: Number(row.intercept) || 0,
    samples: Number(row.train_samples) || 0,
    brier: Number(row.train_brier) ?? Number.POSITIVE_INFINITY,
    logLoss: Number.POSITIVE_INFINITY,
    meanPredicted: Number(row.mean_predicted) || 0,
    meanRealized: Number(row.mean_realized) || 0,
  };
}

/** Public candle fetch. No credentials — these are the same endpoints the scanner uses. */
async function fetchCandles(exchange: string, market: string, sinceMs: number): Promise<Candle[]> {
  const minutes = Math.min(200, Math.max(1, Math.ceil((Date.now() - sinceMs) / 60_000) + 2));
  try {
    if (exchange === "upbit") {
      const res = await fetch(
        `https://api.upbit.com/v1/candles/minutes/1?market=${encodeURIComponent(market)}&count=${minutes}`,
      );
      if (!res.ok) return [];
      const rows = await res.json();
      // Upbit returns newest-first.
      return (Array.isArray(rows) ? rows : [])
        .map((r: any) => ({
          ts: Date.parse(r.candle_date_time_utc + "Z"),
          high: Number(r.high_price),
          low: Number(r.low_price),
          close: Number(r.trade_price),
        }))
        .filter((c: Candle) => Number.isFinite(c.ts) && c.ts >= sinceMs)
        .sort((a: Candle, b: Candle) => a.ts - b.ts);
    }
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(market)}&interval=1m&startTime=${Math.floor(sinceMs)}&limit=${minutes}`,
    );
    if (!res.ok) return [];
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map((r: any) => ({
      ts: Number(r[0]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
    }));
  } catch {
    return [];
  }
}

/**
 * Replay every scored candidate that has matured and record which barrier it would have
 * touched first. This is where the sample count comes from: all finalists, not just fills.
 */
async function evaluateShadowCandidates(settings: any) {
  const horizonMinutes = Math.max(5, Number(settings?.scalp_max_holding_minutes) || 45);
  // Only candidates old enough to have resolved, and recent enough for 1m candles.
  const matured = new Date(Date.now() - horizonMinutes * 60_000).toISOString();
  const floor = new Date(Date.now() - 6 * 3600_000).toISOString();
  const rows = await db(
    `scanner_candidates?created_at=lte.${encodeURIComponent(matured)}&created_at=gte.${encodeURIComponent(floor)}` +
      `&select=id,scan_id,exchange,market,created_at,decision,snapshot&order=created_at.asc&limit=400`,
  ) as any[];
  if (!rows?.length) return { evaluated: 0, inserted: 0 };

  const existing = new Set(
    ((await db(
      `scalp_shadow_outcomes?candidate_id=in.(${rows.map((r) => r.id).join(",")})&select=candidate_id`,
    ).catch(() => [])) as any[]).map((r) => r.candidate_id),
  );

  const inserts: any[] = [];
  for (const row of rows) {
    if (existing.has(row.id)) continue;
    const scalp = row.snapshot?.scalp;
    const targetPct = Number(scalp?.target_pct);
    const stopPct = Number(scalp?.stop_pct);
    const reference = Number(row.snapshot?.price_context?.live_reference_price ?? row.snapshot?.current_price);
    if (!(targetPct > 0 && stopPct > 0 && reference > 0)) continue;

    const scannedMs = Date.parse(row.created_at);
    const candles = await fetchCandles(row.exchange, row.market, scannedMs);
    if (!candles.length) continue;
    const result = resolveBarrierOutcome(candles, reference, targetPct, stopPct, horizonMinutes);
    inserts.push({
      candidate_id: row.id, scan_id: row.scan_id, exchange: row.exchange, market: row.market,
      scanned_at: row.created_at,
      predicted_p_win: Number(scalp?.pWin) || null,
      neutral_win_rate: Number(scalp?.geometry?.neutral_win_rate ?? scalp?.neutral_win_rate) || null,
      signal_edge: Number(scalp?.signal_edge) || null,
      target_pct: targetPct, stop_pct: stopPct, decision: row.decision,
      outcome: result.outcome, bars_to_resolve: result.barsToResolve, realized_return: result.realizedReturn,
      features: scalp?.features || {},
    });
    // Public endpoints; stay polite.
    await new Promise((r) => setTimeout(r, 60));
  }
  if (inserts.length) {
    await db("scalp_shadow_outcomes?on_conflict=candidate_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(inserts),
    }).catch(() => null);
  }
  return { evaluated: rows.length, inserted: inserts.length };
}

/**
 * v6.5: turn the raw latency samples into the number the entry gate actually charges.
 *
 * `cost-model.ts` has subtracted a flat 1bp for execution delay since v5.2 without one
 * millisecond ever being recorded. This closes that loop: p95 tick-to-order is measured
 * here, written to `scalp_latency_p95_ms`, and combined at order time with each book's own
 * noise band to price the delay per symbol instead of per system.
 *
 * The p95 is used rather than the median deliberately. The cost of being late is not the
 * typical delay, it is the delay bad enough to matter, and a scalper that sizes to its
 * median latency systematically underprices its own tail.
 */
async function measureLatency(): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = await db(
    `trading_latency_samples?created_at=gte.${encodeURIComponent(since)}&select=tick_to_order_ms,tick_to_decision_ms,quote_to_decision_ms,order_round_trip_ms,book_captured_at&order=created_at.desc&limit=20000`,
  ).catch(() => []) as any[];

  const list = Array.isArray(rows) ? rows : [];
  const pick = (key: string): number[] =>
    list.map((r) => Number(r[key])).filter((v) => Number.isFinite(v));

  const tickToOrder = summarize(pick("tick_to_order_ms"));
  const tickToDecision = summarize(pick("tick_to_decision_ms"));
  const quoteToDecision = summarize(pick("quote_to_decision_ms"));
  const orderRoundTrip = summarize(pick("order_round_trip_ms"));
  // Rows with no exchange book timestamp cannot be audited for staleness at all. Counting
  // them is the point: before v6.5 that was every row in the system.
  const anchored = list.filter((r) => r.book_captured_at).length;

  const slo = evaluateLatencySlo(
    { tickToOrder, quoteToDecision, decisionsSeen: list.length },
    DEFAULT_LATENCY_SLO,
  );

  return {
    samples: list.length,
    exchange_anchored_samples: anchored,
    tick_to_order: tickToOrder,
    tick_to_decision: tickToDecision,
    quote_to_decision: quoteToDecision,
    order_round_trip: orderRoundTrip,
    slo,
  };
}

async function runCalibration(dryRun: boolean) {
  const settings = (await db("trading_settings?id=eq.1&select=*&limit=1").catch(() => []))?.[0] || {};
  const shadow = await evaluateShadowCandidates(settings).catch(() => ({ evaluated: 0, inserted: 0 }));
  const latency = await measureLatency().catch(() => null);

  // Measure the signal's actual excess win rate. This is what edgeBudget means, and it has
  // never been measured — the value has been assumed since the strategy was written.
  const shadowRows = await db(
    "scalp_shadow_outcomes?select=neutral_win_rate,signal_edge,outcome,predicted_p_win&order=scanned_at.desc&limit=5000",
  ).catch(() => []) as any[];
  const shadowSamples: ShadowSample[] = (shadowRows || [])
    .filter((r) => Number.isFinite(Number(r.neutral_win_rate)))
    .map((r) => ({
      neutralWinRate: Number(r.neutral_win_rate),
      signalEdge: Number(r.signal_edge) || 0,
      outcome: r.outcome,
    }));
  const measurement = measureEdge(shadowSamples);
  const currentEdgeBudget = Number(settings.scalp_edge_budget) || 0.10;
  const edgeProposal = proposeEdgeBudget(measurement, currentEdgeBudget, DEFAULT_EDGE_PROPOSAL);

  const rows = await db(
    "trading_positions?state=eq.CLOSED&is_paper=eq.false&select=id,closed_at,close_reason,t1_completed,realized_pnl_quote,metadata&order=closed_at.asc&limit=5000",
  ) as ClosedPosition[];
  const all = extractSamples(rows);
  const resolved = all.filter((s) => s.resolved);
  const incumbent = await loadIncumbent();
  const decision = evaluatePromotion(resolved, incumbent, DEFAULT_CALIBRATION_FIT);
  const resolveRate = realizedResolveRate(all);
  const bins = reliabilityBins(resolved);

  const report = {
    latency,
    shadow: {
      ...shadow,
      stored_samples: shadowSamples.length,
      resolved: measurement.resolved,
      resolve_rate: measurement.resolveRate,
      realized_win_rate: measurement.realizedWinRate,
      neutral_win_rate: measurement.neutralWinRate,
      measured_edge: measurement.measuredEdge,
      edge_lower_bound: measurement.edgeLowerBound,
      predicted_edge: measurement.predictedEdge,
      standard_error: measurement.standardError,
    },
    edge_budget: {
      current: edgeProposal.current,
      proposed: edgeProposal.proposed,
      apply: edgeProposal.apply,
      reason: edgeProposal.reason,
      auto_tune_enabled: settings.scalp_auto_tune_edge_budget === true,
    },
    closed_positions: rows?.length || 0,
    usable_samples: all.length,
    resolved_samples: resolved.length,
    unresolved_samples: all.length - resolved.length,
    realized_resolve_rate: resolveRate,
    incumbent: { slope: incumbent.a, intercept: incumbent.b, samples: incumbent.samples },
    decision: {
      promote: decision.promote,
      reason: decision.reason,
      slope: decision.challenger.a,
      intercept: decision.challenger.b,
      train_samples: decision.trainSize,
      holdout_samples: decision.holdoutSize,
      train_brier: decision.challenger.brier,
      holdout_brier: decision.challengerHoldoutBrier,
      incumbent_holdout_brier: decision.incumbentHoldoutBrier,
      mean_predicted: decision.challenger.meanPredicted,
      mean_realized: decision.challenger.meanRealized,
    },
    reliability_bins: bins,
    dry_run: dryRun,
  };

  // Write the measured edge back only when the operator has enabled it. Reporting is
  // always on: knowing the number matters even when nothing is changed automatically.
  // v6.5.1: the measured p95 replaces the unearned constant. A thin sample is written too --
  // the shrinkage toward the zero-cost prior happens at read time in the autotrader, so the raw
  // measurement stays visible here instead of being pre-blended into something that cannot
  // be checked against the distribution it came from.
  const latencySamples = Number((latency as any)?.samples) || 0;
  if (
    latency && latencySamples >= DEFAULT_LATENCY_SLO.minSamples &&
    settings.scalp_auto_tune_latency !== false && !dryRun
  ) {
    await db("trading_settings?id=eq.1", {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        scalp_latency_p95_ms: Number((latency as any)?.tick_to_order?.p95) || 0,
        scalp_latency_samples: latencySamples,
        scalp_latency_source: "MEASURED",
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => null);
  }

  if (edgeProposal.apply && settings.scalp_auto_tune_edge_budget === true && !dryRun) {
    await db("trading_settings?id=eq.1", {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        scalp_edge_budget: edgeProposal.proposed,
        scalp_edge_budget_source: "MEASURED",
        scalp_edge_budget_measured_at: new Date().toISOString(),
        scalp_edge_budget_samples: measurement.resolved,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => null);
  }

  if (!decision.promote || dryRun) return { ...report, promoted: false };

  const promoted = await rpc("promote_scalp_calibration", {
    p_slope: decision.challenger.a,
    p_intercept: decision.challenger.b,
    p_train_samples: decision.trainSize,
    p_holdout_samples: decision.holdoutSize,
    p_train_brier: decision.challenger.brier,
    p_holdout_brier: decision.challengerHoldoutBrier,
    p_incumbent_brier: decision.incumbentHoldoutBrier,
    p_mean_predicted: decision.challenger.meanPredicted,
    p_mean_realized: decision.challenger.meanRealized,
    p_realized_resolve_rate: resolveRate,
    p_reliability_bins: bins,
    p_promotion_reason: decision.reason,
  });
  return { ...report, promoted: true, profile: promoted };
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!allowed(request)) return json({ error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "service credentials are not configured" }, 500);
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  try {
    return json(await runCalibration(body?.dry_run === true));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
