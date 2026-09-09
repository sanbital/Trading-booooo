import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const scanStart = source.indexOf("async function p10ScanCycle(");
const scanEnd = source.indexOf("async function p10FetchJson(", scanStart);
const scan = source.slice(scanStart, scanEnd);

Deno.test("P10 scan persists account truth before every futures reconciliation return", () => {
  const snapshot = scan.indexOf("const snapshotResults = await Promise.allSettled(");
  const observationGate = scan.indexOf("if (futuresObservationError)");
  const mismatchGate = scan.indexOf("if (untrackedFutures.length)");

  assert(snapshot >= 0, "authenticated snapshot write is missing from P10 scan");
  assert(snapshot < observationGate, "snapshot must precede the observation-failure return");
  assert(snapshot < mismatchGate, "snapshot must precede the untracked-exposure return");
  assert(
    scan.includes("portfolioExchanges.map((exchange)"),
    "futures truth must be snapshotted even when only another shared lane is active",
  );
});

Deno.test("P10 reconciliation recognizes every active futures strategy ledger", () => {
  assert(scan.includes("v10_lane_positions?state=in.(OPEN,CLOSE_SUBMITTED,RECONCILIATION_FAILED)"));
  assert(scan.includes("v11_long_regime_positions?state=eq.OPEN"));
  assert(scan.includes("...v11MaintenancePositions.map"));
});
