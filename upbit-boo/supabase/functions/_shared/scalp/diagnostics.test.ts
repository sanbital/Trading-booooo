import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tallyDecisions, tallyDropReasons, websocketHealth, buildScanDiagnostics, type ScanFunnel } from "./diagnostics.ts";

Deno.test("tallyDecisions counts BUY/WAIT/AVOID", () => {
  const t = tallyDecisions([{ decision: "BUY" }, { decision: "WAIT" }, { decision: "WAIT" }, { decision: "AVOID" }]);
  assertEquals(t, { BUY: 1, WAIT: 2, AVOID: 1 });
});

Deno.test("tallyDropReasons aggregates failed gates, most frequent first", () => {
  const t = tallyDropReasons([
    { failed_gates: ["rr", "spread"] },
    { failed_gates: ["rr"] },
    { failed_gates: ["depth", "rr"] },
  ]);
  assertEquals(t.rr, 3);
  assertEquals(Object.keys(t)[0], "rr");
});

Deno.test("websocketHealth flags stale and absent markets", () => {
  const now = 1_000_000;
  const snaps = new Map<string, Array<{ timestamp?: number }>>([
    ["FRESH", [{ timestamp: now - 1000 }]],
    ["STALE", [{ timestamp: now - 9000 }]],
    // ABSENT has no entry
  ]);
  const h = websocketHealth(snaps, ["FRESH", "STALE", "ABSENT"], now, 2, 60_000, 5_000);
  assertEquals(h.stale_markets, 2); // STALE + ABSENT
  assertEquals(h.newest_snapshot_age_ms, 1000);
  assertEquals(h.markets_with_ws, 2);
});

Deno.test("buildScanDiagnostics assembles the full block", () => {
  const funnel: ScanFunnel = {
    total_instruments: 470, universe: 400, eligible: 215, shortlist: 30,
    analyzed: 30, finalists: 8, final_candidates: 8, buy: 0,
  };
  const d = buildScanDiagnostics({
    startedMs: 0, endMs: 1234, exchange: "binance", status: "NO_BUY", funnel,
    candidates: [{ decision: "WAIT", failed_gates: ["rr"] }, { decision: "AVOID", failed_gates: ["rr", "spread"] }],
    websocket: { markets_with_ws: 8, observation_ms: 60000, newest_snapshot_age_ms: 500, stale_markets: 0, stale_threshold_ms: 5000 },
  });
  assertEquals(d.duration_ms, 1234);
  assertEquals(d.funnel.buy, 0);
  assertEquals(d.decisions.WAIT, 1);
  assertEquals(d.drop_reasons.rr, 2);
  assert(d.scanned_at.startsWith("1970-01-01"));
});
