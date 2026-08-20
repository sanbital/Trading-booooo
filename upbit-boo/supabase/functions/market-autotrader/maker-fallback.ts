export interface MakerFallbackInput {
  exchange: unknown;
  pattern: unknown;
  errorMessage: unknown;
  convertToTaker: unknown;
  attemptEvLowerBoundBps: unknown;
  conditionalEvLowerBoundBps: unknown;
  spreadBps: unknown;
  maxSpreadBps: unknown;
  candidateAgeMs: unknown;
  hardMaxAgeMs: unknown;
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A Binance LIMIT_MAKER "would immediately match" response is deterministic: the exchange
 * rejected the order before it existed. Only that duplicate-safe case may continue into the
 * already-tested IOC limit path, and only while the momentum trade remains fee-net positive,
 * fresh and inside its dedicated spread ceiling.
 */
export function shouldFallbackPostOnlyMomentumToIoc(input: MakerFallbackInput): boolean {
  const deterministicPostOnlyReject = /order would immediately match and take/i.test(
    String(input.errorMessage || ""),
  );
  const exchangeOk = String(input.exchange || "").toLowerCase() === "binance";
  const patternOk = String(input.pattern || "").toUpperCase() === "MOMENTUM_CONTINUATION";
  const modelApproved = input.convertToTaker === true;
  const attemptEvPositive = finite(input.attemptEvLowerBoundBps, Number.NEGATIVE_INFINITY) > 0;
  const conditionalEvPositive = finite(
    input.conditionalEvLowerBoundBps,
    Number.NEGATIVE_INFINITY,
  ) > 0;
  const spread = finite(input.spreadBps, Number.POSITIVE_INFINITY);
  const maxSpread = Math.max(0, finite(input.maxSpreadBps, 0));
  const spreadOk = spread <= maxSpread;
  const ageMs = Math.max(0, finite(input.candidateAgeMs, Number.POSITIVE_INFINITY));
  const hardMaxAgeMs = Math.max(0, finite(input.hardMaxAgeMs, 0));
  const fresh = hardMaxAgeMs > 0 && ageMs <= hardMaxAgeMs;
  return deterministicPostOnlyReject && exchangeOk && patternOk && modelApproved &&
    attemptEvPositive && conditionalEvPositive && spreadOk && fresh;
}
