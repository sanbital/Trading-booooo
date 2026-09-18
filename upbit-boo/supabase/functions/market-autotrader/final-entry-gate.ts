export type FinalEntryExchange = "upbit" | "binance" | "binance_futures";

export type FinalLobAdmission = {
  passed: boolean;
  blockingReasons: string[];
  minuteGateAdvisory: boolean;
  minuteGateAdvisoryReasons: string[];
};

function uniqueReasons(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

/**
 * Final executable admission policy.
 *
 * Binance futures already arrives here after the scanner/order-time M1 setup was accepted.
 * Requiring a second, newly completed 1m candle at the last executable quote caused valid
 * opportunities to be rejected solely because the minute boundary advanced while the live
 * order book remained safe. For futures, keep that fresh M1 read as telemetry only and let
 * the current executable LOB recheck own the final veto.
 *
 * Spot/Upbit retain the existing hard final M1 gate until their own live data is reviewed.
 */
export function resolveFinalLobAdmission(
  exchange: FinalEntryExchange,
  lobPassed: boolean,
  lobReasons: readonly string[],
  minutePassed: boolean,
  minuteReasons: readonly string[],
): FinalLobAdmission {
  const minuteGateAdvisory = exchange === "binance_futures";
  const minuteGateAdvisoryReasons = minuteGateAdvisory ? uniqueReasons(minuteReasons) : [];
  const blockingReasons = uniqueReasons([
    ...lobReasons,
    ...(minuteGateAdvisory ? [] : minuteReasons),
  ]);

  return {
    passed: Boolean(lobPassed) && (minuteGateAdvisory || Boolean(minutePassed)),
    blockingReasons,
    minuteGateAdvisory,
    minuteGateAdvisoryReasons,
  };
}
