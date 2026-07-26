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
  DEFAULT_CALIBRATION_FIT,
  evaluatePromotion,
  IDENTITY_CALIBRATION,
  realizedResolveRate,
  reliabilityBins,
  type CalibrationModel,
  type CalibrationSample,
} from "../_shared/scalp/calibration.ts";

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

async function runCalibration(dryRun: boolean) {
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
