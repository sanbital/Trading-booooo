// Entry-admission availability helpers.
//
// LOB candidates are discovered by a multi-stage scan and then fully re-priced against a
// fresh orderbook immediately before an order. The scanner recommendation is therefore a
// routing seed, not the final market decision. Expiring that seed before the scan itself has
// finished prevents the fresh recheck from ever running and can silently reduce turnover to
// zero.

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
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
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
  if (/recommendation.+expired/i.test(text)) return ["RECOMMENDATION_EXPIRED"];
  if (/market already tracked/i.test(text)) return ["MARKET_ALREADY_TRACKED"];
  if (/already exposed/i.test(text)) return ["ASSET_ALREADY_EXPOSED"];
  if (/managed allocation.+buying power/i.test(text)) return ["NO_BUYING_POWER"];
  if (/low-evidence concurrency/i.test(text)) return ["LOW_EVIDENCE_CONCURRENCY"];
  if (/low-evidence daily loss/i.test(text)) return ["LOW_EVIDENCE_LOSS_BUDGET"];
  if (/spread .+ exceeds/i.test(text)) return ["SPREAD_TOO_WIDE"];
  if (/depth/i.test(text)) return ["INSUFFICIENT_DEPTH"];
  if (/maker.+minimum/i.test(text)) return ["MAKER_BELOW_MINIMUM"];
  if (/maker entry resting/i.test(text)) return ["MAKER_ENTRY_RESTING"];
  return [text.replaceAll(/\s+/g, "_").toUpperCase().slice(0, 96)];
}

export function summarizeEntryAdmission(
  candidateCount: unknown,
  results: EntryAdmissionResult[],
): EntryAdmissionSummary {
  const rows = Array.isArray(results) ? results : [];
  const reservations = rows.filter((row) => row.entered || row.reserved).length;
  const entered = rows.filter((row) => row.entered).length;
  const errors = rows.filter((row) => row.error != null).length;
  const rejectedRows = rows.filter((row) => !row.entered && !row.reserved);
  const rejectionReasons: Record<string, number> = {};
  for (const row of rejectedRows) {
    for (const code of reasonCodes(row.reason ?? row.error)) {
      rejectionReasons[code] = (rejectionReasons[code] || 0) + 1;
    }
  }
  const candidates = Math.max(0, Math.floor(finite(candidateCount)));
  return {
    candidates,
    attempts: rows.length,
    entered,
    reservations,
    rejected: rejectedRows.length,
    errors,
    rejectionReasons,
    admissionCollapse: candidates > 0 && rows.length > 0 && reservations === 0,
  };
}
