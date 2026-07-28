// Trading-booooo v6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE — LOB_SCALP calibration job.
//
// Reads closed LOB positions, reconstructs (predicted pTarget, neutral win rate, realized
// outcome) triples from `trading_positions.metadata.lob_signal`, and writes a profile that
// the scanner and the autotrader apply to the *signal edge* — never to the geometric term.
//
// This replaces nothing: `scalp-calibration` still fits the legacy SCALP model, which no
// longer trades. The two are separate on purpose so that switching strategies back does not
// require unpicking a merged calibration.
//
// Why this can work where the scalp version could not: a LOB position resolves in minutes,
// so realized outcomes accumulate from live trading at a rate that reaches a usable sample
// count in days rather than weeks. No candle-based shadow reconstruction is involved, and
// therefore none of its resolution limits apply.
//
// Closed-trade facts are read-only. Raw profiles are immutable challenger inputs, never
// automatic production releases. Promotion is owned by the full-size live cohort gate.

import { buildLobLearningProfile, type LobOutcomeSample } from "../_shared/lob/learning.ts";
import {
  evaluateLobPolicy,
  type LobPolicyExposure,
  type LobPolicyPhase,
  type LobPolicyTrade,
} from "../_shared/lob/governance.ts";
import type { LobPatternName } from "../_shared/lob/types.ts";
import type { LobTrapName } from "../_shared/lob/traps.ts";
import { estimateEvBias, type EvBiasSample } from "../_shared/lob/ev-bias.ts";
import { proposeLobAdaptivePolicy } from "../_shared/lob/adaptive-policy.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const PATTERN_NAMES: LobPatternName[] = [
  "ABSORPTION_REVERSAL",
  "QUEUE_DEPLETION_BREAKOUT",
  "SWEEP_RECLAIM",
  "OFI_CONTINUATION",
  "REPLENISHMENT_ICEBERG",
];
const TRAP_NAMES: LobTrapName[] = [
  "ASK_ICEBERG",
  "BID_SPOOF",
  "ASK_SPOOF",
  "CHOP_NO_VIABLE_STOP",
  "QUOTE_FLICKER",
];

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
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`db ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function evaluateGovernance(dryRun: boolean): Promise<any> {
  let dataset: any;
  try {
    dataset = await db("rpc/get_lob_policy_evaluation_dataset", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!dataset || dataset.phase === "IDLE") {
    return { available: true, phase: "IDLE", decision: null, dataset };
  }
  const phase = String(dataset.phase) as Exclude<LobPolicyPhase, "IDLE">;
  if (phase !== "CHALLENGE" && phase !== "CONFIRMATION") {
    return { available: false, reason: `unknown governance phase ${phase}` };
  }
  const currentTrafficFraction = Math.max(
    0,
    Math.min(0.5, finite(dataset.candidate_traffic_fraction, 0.15)),
  );
  const nextTrafficFraction = currentTrafficFraction < 0.25 ? 0.25 : 0.50;
  const stageSamples = currentTrafficFraction < 0.25 ? 30 : currentTrafficFraction < 0.50 ? 60 : 100;
  const evaluationLook = Math.max(0, Math.floor(finite(dataset.evaluation_look, 0)));
  // Alpha spending: repeated looks become stricter instead of silently increasing the
  // false-promotion rate. The stage boundary itself also raises the sample requirement.
  const zScore = currentTrafficFraction < 0.25
    ? 1.644853626951 + Math.min(0.30, evaluationLook * 0.02)
    : 1.95996398454 + Math.min(0.30, evaluationLook * 0.015);
  const evaluation = evaluateLobPolicy(
    (dataset.baseline_trades || []) as LobPolicyTrade[],
    (dataset.candidate_trades || []) as LobPolicyTrade[],
    (dataset.baseline_exposures || []) as LobPolicyExposure[],
    (dataset.candidate_exposures || []) as LobPolicyExposure[],
    phase,
    {
      currentTrafficFraction,
      expandedTrafficFraction: nextTrafficFraction,
      canaryMinBaselineSamples: stageSamples,
      canaryMinCandidateSamples: stageSamples,
      canaryMinObservationHours: 24,
      minSamplesPerArm: 100,
      minAssignedScansPerArm: 60,
      minIndependentBlocksPerArm: 3,
      zScore,
    },
  );
  if (dryRun) return { available: true, phase, evaluation, applied: null };
  const applied = await db("rpc/apply_lob_policy_decision", {
    method: "POST",
    body: JSON.stringify({
      p_expected_champion: phase === "CHALLENGE"
        ? dataset.baseline_version
        : dataset.candidate_version,
      p_expected_alternate: phase === "CHALLENGE"
        ? dataset.candidate_version
        : dataset.baseline_version,
      p_decision: evaluation.decision,
      p_metrics: evaluation,
      p_reason: evaluation.reason,
    }),
  });
  return { available: true, phase, evaluation, applied };
}

/**
 * A position resolved at its target when it closed for a target reason. Anything else —
 * stop, signal invalidation, reversal, reconciliation — counts as a non-hit.
 *
 * Signal exits are deliberately counted against the pattern rather than excluded. The exit
 * rules are part of the strategy, so a pattern that keeps being closed early by its own
 * invalidation conditions is not delivering its edge, whatever the entry model claimed.
 */
function outcomeOf(row: any): 0 | 1 {
  const reason = String(row.close_reason || "").toUpperCase();
  if (reason.includes("TARGET")) return 1;
  // A position closed for an unrecognised reason still resolved profitably or not; fall
  // back to realized P&L rather than discarding the sample.
  if (!reason) return finite(row.realized_pnl_quote) > 0 ? 1 : 0;
  return 0;
}

function toSample(row: any): LobOutcomeSample | null {
  const signal = row?.metadata?.lob_signal;
  if (!signal) return null;
  const pattern = String(signal.pattern || "") as LobPatternName;
  if (!PATTERN_NAMES.includes(pattern)) return null;

  const predicted = finite(signal.p_target, NaN);
  if (!Number.isFinite(predicted)) return null;

  // Older rows predate `neutral_win_rate`; recover it from the barrier widths, which have
  // always been recorded. A row with neither is unusable — the whole point is to separate
  // the arithmetic term from the belief, and a guessed neutral rate would defeat that.
  const target = finite(signal.target_bps, NaN);
  const stop = finite(signal.noise_adjusted_stop_bps ?? signal.stop_bps, NaN);
  const neutral = Number.isFinite(finite(signal.neutral_win_rate, NaN))
    ? finite(signal.neutral_win_rate)
    : Number.isFinite(target) && Number.isFinite(stop) && target + stop > 0
    ? stop / (target + stop)
    : NaN;
  if (!Number.isFinite(neutral)) return null;

  const entry = finite(row.average_entry_price, NaN);
  const cost = finite(row.realized_cost_quote);
  const netBps = cost > 0 ? finite(row.realized_pnl_quote) / cost * 10_000 : 0;

  const traps = Array.isArray(signal.traps)
    ? (signal.traps as string[]).filter((name): name is LobTrapName =>
      TRAP_NAMES.includes(name as LobTrapName)
    )
    : [];

  return {
    pattern,
    predicted,
    neutral,
    outcome: outcomeOf(row),
    netBps: Number.isFinite(entry) ? netBps : 0,
    heldSeconds: (() => {
      const openedAt = Date.parse(String(row.opened_at || row.created_at || ""));
      const closedAt = Date.parse(String(row.closed_at || row.updated_at || ""));
      return Number.isFinite(openedAt) && Number.isFinite(closedAt)
        ? Math.max(0, (closedAt - openedAt) / 1000)
        : 0;
    })(),
    traps,
    exploration: Boolean(row?.metadata?.exploration ?? signal.exploration),
    closedAtMs: Date.parse(String(row.closed_at || row.updated_at || "")) || Date.now(),
  };
}

async function measureLiveForecastDiagnostics(settings: any): Promise<any> {
  const compatibleEngines = "6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE";
  const rows = await db(
    "lob_online_outcomes?accounting_quality=in.(NO_RESIDUAL,RESIDUAL_MARKED_TO_EXIT)" +
      "&fee_accounting_quality=in.(EXACT,AGGREGATE_EXACT,THIRD_ASSET_MARKED,BASE_ASSET_ACCOUNTED)" +
      "&prediction_basis=eq.FILL_CONDITIONAL" +
      `&engine_version=eq.${compatibleEngines}` +
      "&select=net_bps,entry_snapshot,closed_at,engine_version,fee_accounting_quality,prediction_basis&order=closed_at.desc&limit=2000",
  ).catch(() => []) as any[];
  const evSamples: EvBiasSample[] = (rows || []).flatMap((row: any) => {
    const predicted = finite(
      row?.entry_snapshot?.conditional_ev_lower_bound_bps ??
        row?.entry_snapshot?.conditional_ev_net_bps,
      Number.NaN,
    );
    const realized = finite(row?.net_bps, Number.NaN);
    return Number.isFinite(predicted) && Number.isFinite(realized)
      ? [{ predictedEvBps: predicted, realizedNetBps: realized }]
      : [];
  });
  const evBias = estimateEvBias(evSamples);
  const insufficient = (rows || []).filter((row: any) =>
    String(
      row?.entry_snapshot?.features?.dynamicStatus ??
        row?.entry_snapshot?.scanned_lob?.features?.dynamicStatus ??
        "",
    ).toUpperCase().includes("INSUFFICIENT")
  ).length;
  const insufficientDataShare = rows?.length ? insufficient / rows.length : 0;
  const latencySamples = Math.max(0, finite(settings?.scalp_latency_samples));
  const latencyMeasured = String(settings?.scalp_latency_source || "") === "MEASURED" &&
    latencySamples >= 30;
  const latencySloBreached = latencyMeasured &&
    finite(settings?.scalp_latency_p95_ms) > Math.max(250, finite(settings?.scalp_latency_slo_ms, 1500));
  const policyStatus = await db("rpc/get_lob_policy_status", {
    method: "POST",
    body: JSON.stringify({}),
  }).catch(() => null);
  const currentFamily = policyStatus?.champion?.policy_definition?.family || null;
  const proposalRound = Math.max(
    0,
    finite(policyStatus?.champion?.metrics?.proposal_round, 0) +
      finite(policyStatus?.alternate?.metrics?.proposal_round, 0) + 1,
  );
  const policyProposal = proposeLobAdaptivePolicy({
    latencyMeasured,
    latencySloBreached,
    evBiasPenaltyBps: evBias.penaltyBps,
    insufficientDataShare,
    currentFamily,
    proposalRound,
  });
  return {
    rows: rows?.length || 0,
    evBias,
    insufficientDataShare,
    latencyMeasured,
    latencySloBreached,
    policyProposal,
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "supabase env missing" }, 500);
  if (!allowed(request)) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const windowHours = Math.max(
    1,
    Math.min(720, Number(url.searchParams.get("window_hours") || 168)),
  );
  const dryRun = url.searchParams.get("dry_run") === "1";
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  try {
    const settings = (await db("trading_settings?id=eq.1&select=*&limit=1").catch(() => []))?.[0] || {};
    const liveDiagnostics = await measureLiveForecastDiagnostics(settings);
    if (!dryRun) {
      await db("trading_settings?id=eq.1", {
        method: "PATCH",
        body: JSON.stringify({
          scalp_ev_bias_penalty_bps: liveDiagnostics.evBias.penaltyBps,
          scalp_ev_bias_samples: liveDiagnostics.evBias.samples,
          scalp_ev_bias_source: liveDiagnostics.evBias.samples >= 40 ? "MEASURED" : "UNMEASURED",
          scalp_ev_bias_measured_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }).catch(() => null);
    }
    let onlineBackfilled = 0;
    if (!dryRun) {
      try {
        onlineBackfilled = finite(
          await db("rpc/backfill_lob_online_learning", {
            method: "POST",
            body: JSON.stringify({ p_limit: 5000 }),
          }),
        );
      } catch {
        // Rolling deploy: the online migration may not exist yet. Pattern calibration
        // remains independently valid and the next hourly run retries the backfill.
      }
    }
    const rows = await db(
      `trading_positions?state=eq.CLOSED&is_paper=eq.false&closed_at=gte.${since}` +
        `&select=id,created_at,opened_at,closed_at,updated_at,close_reason,average_entry_price,realized_pnl_quote,realized_cost_quote,metadata` +
        `&order=closed_at.desc&limit=5000`,
    );

    const samples = (rows || [])
      .map(toSample)
      .filter((sample: LobOutcomeSample | null): sample is LobOutcomeSample => sample !== null);

    const profile = buildLobLearningProfile(samples);

    if (dryRun) {
      const governance = await evaluateGovernance(true);
      return json({
        ok: true,
        dry_run: true,
        window_hours: windowHours,
        online_backfilled: onlineBackfilled,
        profile,
        live_diagnostics: liveDiagnostics,
        governance,
      });
    }

    // Preserve every measurable batch as immutable challenger evidence. The old `active`
    // switch is deliberately untouched: v6.8 runtime reads only frozen policy versions.
    // A calibration job can no longer replace production merely because twelve observations
    // happened to exist in the same market regime.
    let profileId: string | null = null;
    if (profile.patterns.length) {
      const inserted = await db("lob_learning_profiles", {
        method: "POST",
        body: JSON.stringify({
          generated_at: new Date(profile.generatedAtMs).toISOString(),
          active: false,
          samples: profile.samples,
          base_hit_rate: profile.baseHitRate,
          window_hours: windowHours,
          patterns: profile.patterns,
          traps: profile.traps,
          notes: [...profile.notes, "VALIDATION_CANDIDATE_ONLY_V610"],
        }),
      });
      profileId = inserted?.[0]?.id ?? null;
    }

    const governance = await evaluateGovernance(false);
    let challenger: any = null;
    const terminalDecision = ["PROMOTE", "REJECT", "CONFIRM", "ROLLBACK"].includes(
      String(governance?.evaluation?.decision || ""),
    );
    if (governance?.phase === "IDLE" || terminalDecision) {
      try {
        challenger = await db("rpc/create_lob_policy_challenger", {
          method: "POST",
          body: JSON.stringify({
            p_min_new_samples: 20,
            p_policy_definition: liveDiagnostics.policyProposal,
          }),
        });
      } catch (error) {
        challenger = {
          created: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return json({
      ok: true,
      promoted: governance?.evaluation?.decision === "PROMOTE" ||
        governance?.evaluation?.decision === "CONFIRM",
      window_hours: windowHours,
      online_backfilled: onlineBackfilled,
      profile_id: profileId,
      profile,
      live_diagnostics: liveDiagnostics,
      governance,
      challenger,
    });
  } catch (error) {
    return json({ error: String(error instanceof Error ? error.message : error) }, 500);
  }
});
