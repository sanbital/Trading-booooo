import {
  lobRecommendationWindowSeconds,
  recommendationAdmission,
  summarizeEntryAdmission,
} from "./entry-admission.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("LOB scanner expiry proceeds to a bounded fresh-book recheck", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const decision = recommendationAdmission({
    strategy: "LOB_SCALP",
    recommendationValidUntil: "2026-07-28T11:59:50.000Z",
    candidateCreatedAt: "2026-07-28T11:59:30.000Z",
    nowMs: now,
    lobLiveRecheckMaxAgeMs: 120_000,
  });
  assert(decision.allowed);
  assert(decision.scannerExpired);
  assert(decision.reason === "LIVE_RECHECK");
});

Deno.test("legacy strategies and genuinely old LOB scans still expire", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const legacy = recommendationAdmission({
    strategy: "TREND",
    recommendationValidUntil: "2026-07-28T11:59:50.000Z",
    candidateCreatedAt: "2026-07-28T11:59:30.000Z",
    nowMs: now,
  });
  const oldLob = recommendationAdmission({
    strategy: "LOB_SCALP",
    recommendationValidUntil: "2026-07-28T11:59:50.000Z",
    candidateCreatedAt: "2026-07-28T11:55:00.000Z",
    nowMs: now,
    lobLiveRecheckMaxAgeMs: 120_000,
  });
  assert(!legacy.allowed);
  assert(!oldLob.allowed);
});

Deno.test("LOB recommendation window covers the scan scheduler", () => {
  assert(lobRecommendationWindowSeconds(12) === 120);
  assert(lobRecommendationWindowSeconds(60) === 120);
  assert(lobRecommendationWindowSeconds(180) === 300);
});

Deno.test("admission summary exposes a zero-reservation collapse and gate reasons", () => {
  const summary = summarizeEntryAdmission(24, [
    { reason: "recommendation expired" },
    { reason: "LOB recheck: NET_EV_NOT_POSITIVE,STALE_ORDERBOOK" },
    { error: "gateway timeout" },
  ]);
  assert(summary.admissionCollapse);
  assert(summary.reservations === 0);
  assert(summary.rejectionReasons.RECOMMENDATION_EXPIRED === 1);
  assert(summary.rejectionReasons.NET_EV_NOT_POSITIVE === 1);
  assert(summary.rejectionReasons.STALE_ORDERBOOK === 1);
  assert(!summary.antiGamingFailure, "negative-EV/structural rows must not become forced trades");
});

Deno.test("positive-EV opportunities cannot be hidden by reducing activity to zero", () => {
  const rows = Array.from({ length: 5 }, () => ({
    reason: "database 400: LOB_ADMISSION_REJECT[upbit:KRW-X]: CORE_OPPORTUNITY_SCORE_LOW",
    audit: {
      attempt_ev_lower_bound_bps: 1.8,
      net_reward_risk_ratio: 0.92,
    },
  }));
  const summary = summarizeEntryAdmission(12, rows, 0.20);
  assert(summary.qualifiedAttempts === 5);
  assert(summary.requiredReservations === 1);
  assert(summary.zeroTradeWithQualifiedOpportunity);
  assert(summary.antiGamingFailure);
  assert(summary.activityShortfall === 1);
});

Deno.test("meeting the opportunity-normalized activity floor clears anti-gaming failure", () => {
  const summary = summarizeEntryAdmission(12, [
    {
      entered: true,
      audit: { attempt_ev_lower_bound_bps: 2, net_reward_risk_ratio: 1.1 },
    },
    ...Array.from({ length: 4 }, () => ({
      reason: "LOB_ADMISSION_REJECT[binance:XUSDT]: CORE_OPPORTUNITY_SCORE_LOW",
      lob_signal: { attempt_ev_lower_bound_bps: 1.2, net_reward_risk_ratio: 0.90 },
    })),
  ], 0.20);
  assert(summary.qualifiedAttempts === 5);
  assert(summary.reservations === 1);
  assert(summary.participationRate === 0.2);
  assert(!summary.antiGamingFailure);
});
