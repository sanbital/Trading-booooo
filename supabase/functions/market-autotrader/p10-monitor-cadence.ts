/** The open time of the newest hourly candle that is guaranteed to be complete. */
export function latestCompletedPolicyBarTime(nowMs: number, hourMs: number): number {
  if (!(Number.isFinite(nowMs) && Number.isFinite(hourMs) && hourMs > 0)) return 0;
  return Math.floor(nowMs / hourMs) * hourMs - hourMs;
}

/**
 * Hourly policy inputs change only once per hour. Intrabar STOP/TARGET/TIME exits do not
 * depend on a candle fetch, so the two-second monitor loads history only after a new hour
 * has actually closed.
 */
export function shouldLoadCompletedPolicyBar(
  lastPolicyBarTime: number,
  nowMs: number,
  hourMs: number,
): boolean {
  return lastPolicyBarTime < latestCompletedPolicyBarTime(nowMs, hourMs);
}
