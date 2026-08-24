/** Default-off live-order gate for Binance USDⓈ-M SHORT entries.
 *
 * Signal producers may continue to emit/research SHORT candidates.  The order
 * executor must independently require an exact, explicit environment opt-in so a
 * model or benchmark-gate change cannot turn research output into a live SELL.
 */
export const FUTURES_SHORT_LIVE_ENV = "BINANCE_FUTURES_SHORT_LIVE_ENABLED";

export function futuresShortLiveEnabled(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}
export function futuresShortEntryBlockReason(
  exchange: string,
  side: string,
  liveFlagValue: unknown,
): string | null {
  if (exchange !== "binance_futures" || side !== "SHORT") return null;
  return futuresShortLiveEnabled(liveFlagValue)
    ? null
    : "BINANCE_FUTURES_SHORT_LIVE_DISABLED";
}
