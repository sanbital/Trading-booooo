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
 * Every venue must still agree with the completed M1 direction at the final executable
 * quote. The previous Binance Futures exception made M1 advisory-only, allowing a signal
 * discovered on an older scan to enter after the minute structure had already reversed.
 * The executable LOB recheck remains mandatory, but it is microstructure confirmation,
 * not a substitute for the directional M1 gate.
 */
export function resolveFinalLobAdmission(
  _exchange: FinalEntryExchange,
  lobPassed: boolean,
  lobReasons: readonly string[],
  minutePassed: boolean,
  minuteReasons: readonly string[],
): FinalLobAdmission {
  // Kept in the response shape for backwards-compatible telemetry. Final M1 is now a hard
  // gate on every venue, including Binance Futures.
  const minuteGateAdvisory = false;
  const minuteGateAdvisoryReasons: string[] = [];
  const blockingReasons = uniqueReasons([
    ...lobReasons,
    ...minuteReasons,
  ]);

  return {
    passed: Boolean(lobPassed) && Boolean(minutePassed),
    blockingReasons,
    minuteGateAdvisory,
    minuteGateAdvisoryReasons,
  };
}
