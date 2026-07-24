import { CALIBRATED_PARAMETERS, ENGINE_VERSION } from "../market-scanner/engine.ts";
import {
  autoCalibrateForward,
  loadRuntimeProfile,
  reconcileForwardOutcomes,
  type LearningParameters,
} from "../market-scanner/forward-learning.ts";

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

const weekly: LearningParameters = {
  scoreThreshold: CALIBRATED_PARAMETERS.scoreThreshold,
  minNetRR: CALIBRATED_PARAMETERS.minNetRR,
  shortTargetAtrMult: CALIBRATED_PARAMETERS.shortTargetAtrMult,
  stopAtrMult: CALIBRATED_PARAMETERS.stopAtrMult,
  mediumTargetAtr4hMult: CALIBRATED_PARAMETERS.mediumTargetAtr4hMult,
  mediumTargetAtrDayMult: CALIBRATED_PARAMETERS.mediumTargetAtrDayMult,
  minStructuralHeadroomNetPct: 0.6,
  minCostMultiple: 2,
  minTradePressure: -0.2,
  maxNegativeBookImbalance: -0.4,
  minDepthCoverage: 1.5,
  maxSlippageBps: 20,
  maxSpreadBps: 35,
  stopMinAtr4hMult: 1,
  stopMinAtr15mMult: 1.5,
  firstTargetAllocationPct: 60,
  exitPolicy: "SCALE_OUT",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!allowed(request)) return json({ error: "unauthorized" }, 401);
  try {
    const before = await loadRuntimeProfile(weekly);
    const reconciliation = await reconcileForwardOutcomes();
    const calibration = await autoCalibrateForward(before, weekly);
    return json({
      ok: true,
      engine_version: ENGINE_VERSION,
      reconciliation,
      calibration: {
        promoted: calibration.promoted,
        reason: calibration.reason,
        profile_version: calibration.profile.version,
        profile_source: calibration.profile.source,
        samples: calibration.profile.samples,
        validation_samples: calibration.profile.validationSamples,
        active_parameters: calibration.profile.parameters,
      },
    });
  } catch (error) {
    console.error("market learning failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
