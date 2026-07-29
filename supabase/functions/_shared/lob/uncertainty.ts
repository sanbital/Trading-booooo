import type { LobFeatureVector } from "./types.ts";

export type LobUncertaintyTier = "BASE" | "SUPPORTED" | "STRONG";

export type LobUncertaintyResolution = {
  haircut: number;
  tier: LobUncertaintyTier;
  positiveDirectionVotes: number;
  evidenceScore: number;
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

/**
 * Converts data quality into epistemic uncertainty without changing any economic hard gate.
 *
 * Weak, stale, wide-spread or direction-conflicted observations retain the configured base
 * haircut. Only live books with independently corroborated tape, microprice and top-book
 * direction earn a smaller uncertainty deduction. The raw fee-net EV still must be positive,
 * the conservative EV still must clear the caller's threshold, and all trap/execution gates
 * remain unchanged.
 */
export function resolveLobUncertaintyHaircut(
  features: LobFeatureVector,
  configuredHaircut: number,
): LobUncertaintyResolution {
  const base = clamp(configuredHaircut, 0, 0.9);
  const pressurePositive = features.tradePressureFast > 0;
  const micropricePositive = features.micropriceDeviationBps > 0;
  const bookPositive = features.bookImbalance > 0;
  const votes = Number(pressurePositive) + Number(micropricePositive) + Number(bookPositive);
  const quality = clamp(features.dataQuality, 0, 1);
  const spread = Math.max(0, Number(features.spreadBps ?? Number.POSITIVE_INFINITY));
  const samples = Math.max(0, Number(features.samples || 0));
  const observationMs = Math.max(0, Number(features.observationMs || 0));
  const status = String(features.dynamicStatus || "UNKNOWN").toUpperCase();
  const statusUsable = !["INSUFFICIENT", "UNKNOWN"].includes(status);

  const evidenceScore = clamp(
    quality * 0.35 +
      clamp(samples / 40, 0, 1) * 0.15 +
      clamp(observationMs / 20_000, 0, 1) * 0.10 +
      (votes / 3) * 0.25 +
      clamp(1 - spread / 12, 0, 1) * 0.15,
    0,
    1,
  );

  const strong = statusUsable && quality >= 0.50 && votes === 3 && spread <= 5 &&
    samples >= 12 && observationMs >= 20_000;
  if (strong) {
    return {
      haircut: Math.min(base, Math.max(0.05, base * 0.25)),
      tier: "STRONG",
      positiveDirectionVotes: votes,
      evidenceScore,
    };
  }

  const supported = statusUsable && quality >= 0.60 && votes >= 2 && spread <= 8 &&
    samples >= 20 && observationMs >= 20_000;
  if (supported) {
    return {
      haircut: Math.min(base, Math.max(0.10, base * 0.50)),
      tier: "SUPPORTED",
      positiveDirectionVotes: votes,
      evidenceScore,
    };
  }

  return {
    haircut: base,
    tier: "BASE",
    positiveDirectionVotes: votes,
    evidenceScore,
  };
}
