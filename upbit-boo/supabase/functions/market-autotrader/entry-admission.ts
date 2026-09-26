// Entry-admission availability and mission-throughput helpers.
//
// LOB candidates are discovered by a multi-stage scan and then fully re-priced against a
// fresh orderbook immediately before an order. The scanner recommendation is therefore a
// routing seed, not the final market decision. Expiring that seed before the scan itself has
// finished prevents the fresh recheck from ever running and can silently reduce turnover to
// zero.
//
// v6.12 adds an anti-gaming contract: a model cannot present a better win rate merely by
// refusing every positive-EV opportunity. Activity is measured only against economically
// qualified, structurally executable attempts; negative-EV or operationally impossible rows
// never become forced trades.

export interface RecommendationAdmissionInput {
  strategy: unknown;
  recommendationValidUntil: unknown;
  candidateCreatedAt: unknown;
  nowMs?: number;
  lobLiveRecheckMaxAgeMs?: number;
}

export interface RecommendationAdmissionDecision {
  allowed: boolean;
  scannerExpired: boolean;
  candidateAgeMs: number | null;
  hardMaxAgeMs: number;
  reason: "FRESH" | "NO_EXPIRY" | "LIVE_RECHECK" | "HARD_EXPIRED";
}

export interface EntryAdmissionResult {
  entered?: boolean;
  reserved?: boolean;
  reason?: unknown;
  error?: unknown;
  evLowerBoundBps?: unknown;
  ev_lower_bound_bps?: unknown;
  netRewardRiskRatio?: unknown;
  net_reward_risk_ratio?: unknown;
  audit?: Record<string, unknown> | null;
  signal?: Record<string, unknown> | null;
  lob_signal?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface EntryAdmissionSummary {
  candidates: number;
  attempts: number;
  entered: number;
  reservations: number;
  rejected: number;
  errors: number;
  rejectionReasons: Record<string, number>;
  admissionCollapse: boolean;
  qualifiedAttempts: number;
  participationFloor: number;
  participationRate: number;
  requiredReservations: number;
  activityShortfall: number;
  zeroTradeWithQualifiedOpportunity: boolean;
  antiGamingFailure: boolean;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstFinite(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteOrNull(value);
    if (parsed != null) return parsed;
  }
  return null;
}

/** Candidate validity must cover at least one complete scan plus admission processing. */
export function lobRecommendationWindowSeconds(scanIntervalSeconds: unknown): number {
  const interval = clamp(finite(scanIntervalSeconds, 60), 8, 300);
  return Math.round(clamp(interval * 2, 120, 300));
}

/**
 * Preserve legacy recommendation expiry for non-LOB strategies.
 *
 * A current-scan LOB candidate that crossed its scanner timestamp may continue only to the
 * fresh order-time LOB recheck. A separate hard age prevents an old scan from being revived.
 */
export function recommendationAdmission(
  input: RecommendationAdmissionInput,
): RecommendationAdmissionDecision {
  const nowMs = finite(input.nowMs, Date.now());
  const hardMaxAgeMs = clamp(
    finite(input.lobLiveRecheckMaxAgeMs, 120_000),
    30_000,
    300_000,
  );
  const validUntilMs = timestamp(input.recommendationValidUntil);
  const createdAtMs = timestamp(input.candidateCreatedAt);
  const candidateAgeMs = createdAtMs == null ? null : Math.max(0, nowMs - createdAtMs);

  if (validUntilMs == null) {
    return {
      allowed: true,
      scannerExpired: false,
      candidateAgeMs,
      hardMaxAgeMs,
      reason: "NO_EXPIRY",
    };
  }
  if (nowMs <= validUntilMs) {
    return {
      allowed: true,
      scannerExpired: false,
      candidateAgeMs,
      hardMaxAgeMs,
      reason: "FRESH",
    };
  }
  if (
    String(input.strategy || "").toUpperCase() === "LOB_SCALP" &&
    candidateAgeMs != null &&
    candidateAgeMs <= hardMaxAgeMs
  ) {
    return {
      allowed: true,
      scannerExpired: true,
      candidateAgeMs,
      hardMaxAgeMs,
      reason: "LIVE_RECHECK",
    };
  }
  return {
    allowed: false,
    scannerExpired: true,
    candidateAgeMs,
    hardMaxAgeMs,
    reason: "HARD_EXPIRED",
  };
}

function reasonCodes(reason: unknown): string[] {
  const text = String(reason || "").trim();
  if (!text) return ["UNSPECIFIED_REJECTION"];
  if (text.startsWith("LOB recheck:")) {
    return text.slice("LOB recheck:".length).split(",").map((value) => value.trim())
      .filter(Boolean);
  }
  const admissionMatch = text.match(/LOB_ADMISSION_REJECT\[[^\]]+\]:\s*([^"}]+)/i);
  if (admissionMatch?.[1]) {
    return admissionMatch[1].split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (/recommendation.+expired/i.test(text)) return ["RECOMMENDATION_EXPIRED"];
  if (/market already tracked/i.test(text)) return ["MARKET_ALREADY_TRACKED"];
  if (/already exposed/i.test(text)) return ["ASSET_ALREADY_EXPOSED"];
  if (/pre-existing account balance/i.test(text)) return ["PREEXISTING_BALANCE"];
  if (/managed allocation.+buying power/i.test(text)) return ["NO_BUYING_POWER"];
  if (/low-evidence concurrency/i.test(text)) return ["LOW_EVIDENCE_CONCURRENCY"];
  if (/low-evidence daily loss/i.test(text)) return ["LOW_EVIDENCE_LOSS_BUDGET"];
  if (/spread .+ exceeds/i.test(text)) return ["SPREAD_TOO_WIDE"];
  if (/depth/i.test(text)) return ["INSUFFICIENT_DEPTH"];
  if (/maker.+minimum/i.test(text)) return ["MAKER_BELOW_MINIMUM"];
  if (/maker entry resting/i.test(text)) return ["MAKER_ENTRY_RESTING"];
  return [text.replaceAll(/\s+/g, "_").toUpperCase().slice(0, 96)];
}

const NON_OPPORTUNITY_CODES = new Set([
  "RECOMMENDATION_EXPIRED",
  "MARKET_ALREADY_TRACKED",
  "ASSET_ALREADY_EXPOSED",
  "PREEXISTING_BALANCE",
  "NO_BUYING_POWER",
  "LOW_EVIDENCE_CONCURRENCY",
  "LOW_EVIDENCE_LOSS_BUDGET",
  "SPREAD_TOO_WIDE",
  "INSUFFICIENT_DEPTH",
  "MAKER_BELOW_MINIMUM",
  "MAKER_ENTRY_RESTING",
  "STALE_ORDERBOOK",
  "MISSING_LIVE_SPREAD",
  "MISSING_NET_RR",
]);

function economicsOf(row: EntryAdmissionResult): { ev: number | null; rr: number | null } {
  const audit = object(row.audit);
  const directSignal = object(row.lob_signal ?? row.signal);
  const metadata = object(row.metadata);
  const metadataSignal = object(metadata.lob_signal ?? metadata.scalp_signal);
  const ev = firstFinite([
    row.evLowerBoundBps,
    row.ev_lower_bound_bps,
    audit.attempt_ev_lower_bound_bps,
    audit.conditional_ev_lower_bound_bps,
    audit.ev_lower_bound_bps,
    directSignal.attempt_ev_lower_bound_bps,
    directSignal.conditional_ev_lower_bound_bps,
    directSignal.ev_lower_bound_bps,
    metadataSignal.attempt_ev_lower_bound_bps,
    metadataSignal.conditional_ev_lower_bound_bps,
    metadataSignal.ev_lower_bound_bps,
  ]);
  const rr = firstFinite([
    row.netRewardRiskRatio,
    row.net_reward_risk_ratio,
    audit.net_reward_risk_ratio,
    directSignal.net_reward_risk_ratio,
    metadataSignal.net_reward_risk_ratio,
  ]);
  return { ev, rr };
}

function economicallyQualified(row: EntryAdmissionResult): boolean {
  if (row.entered || row.reserved) return true;
  if (row.error != null && !String(row.error).includes("LOB_ADMISSION_REJECT")) return false;
  const codes = reasonCodes(row.reason ?? row.error);
  if (codes.some((code) => NON_OPPORTUNITY_CODES.has(code))) return false;
  const { ev, rr } = economicsOf(row);
  // The activity contract never forces a non-positive-EV trade. A sub-1 payoff ratio may still
  // qualify when its probability edge makes the fee-net EV positive; v6.12 evaluates the pair.
  return ev != null && ev > 0 && rr != null && rr >= 0.80;
}

export function summarizeEntryAdmission(
  candidateCount: unknown,
  results: EntryAdmissionResult[],
  participationFloorInput: unknown = 0.20,
): EntryAdmissionSummary {
  const rows = Array.isArray(results) ? results : [];
  const reservations = rows.filter((row) => row.entered || row.reserved).length;
  const entered = rows.filter((row) => row.entered).length;
  const errors = rows.filter((row) =>
    row.error != null && !String(row.error).includes("LOB_ADMISSION_REJECT")
  ).length;
  const rejectedRows = rows.filter((row) => !row.entered && !row.reserved);
  const rejectionReasons: Record<string, number> = {};
  for (const row of rejectedRows) {
    for (const code of reasonCodes(row.reason ?? row.error)) {
      rejectionReasons[code] = (rejectionReasons[code] || 0) + 1;
    }
  }
  const candidates = Math.max(0, Math.floor(finite(candidateCount)));
  const qualifiedAttempts = rows.filter(economicallyQualified).length;
  const participationFloor = clamp(finite(participationFloorInput, 0.20), 0.05, 0.80);
  const requiredReservations = qualifiedAttempts >= 4
    ? Math.min(qualifiedAttempts, Math.max(1, Math.ceil(qualifiedAttempts * participationFloor)))
    : 0;
  const activityShortfall = Math.max(0, requiredReservations - reservations);
  const participationRate = qualifiedAttempts > 0
    ? clamp(reservations / qualifiedAttempts, 0, 1)
    : 1;
  const zeroTradeWithQualifiedOpportunity = qualifiedAttempts > 0 && reservations === 0;
  const antiGamingFailure = requiredReservations > 0 && activityShortfall > 0;
  return {
    candidates,
    attempts: rows.length,
    entered,
    reservations,
    rejected: rejectedRows.length,
    errors,
    rejectionReasons,
    admissionCollapse: candidates > 0 && rows.length > 0 && reservations === 0,
    qualifiedAttempts,
    participationFloor,
    participationRate,
    requiredReservations,
    activityShortfall,
    zeroTradeWithQualifiedOpportunity,
    antiGamingFailure,
  };
}
