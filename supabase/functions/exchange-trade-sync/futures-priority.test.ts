// Regression tests for the futures sweep starvation that lost 8.00447003 USDT
// of exit fills across three positions on 2026-09-12..16.
//
// Fixtures marked INCIDENT are the anonymised shapes actually observed in
// production on 2026-09-16; SYNTHETIC ones cover paths no incident produced.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { prioritizeFuturesMarkets } from "./futures-sync.ts";

const T = (iso: string) => iso;

Deno.test("INCIDENT: a market with no sync-state row is required, never tail", () => {
  // CVCUSDT had no exchange_trade_sync_state row at all, so its fills were
  // never collected -- not even the entry ones.
  const p = prioritizeFuturesMarkets({
    universe: ["CVCUSDT", "AAAUSDT", "BBBUSDT"],
    portfolioPositions: [],
    syncStates: [
      { market: "AAAUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
      { market: "BBBUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
    ],
  });
  assert(p.required.has("CVCUSDT"), "never-synced market must be required");
  assertEquals(p.markets[0], "CVCUSDT");
  assertEquals(p.tiers.tail.includes("CVCUSDT"), false);
});

Deno.test("INCIDENT: a position closed after its market's last sync is required", () => {
  // 哈基米USDT: last synced 05:01:13Z, position closed 05:06:46Z, no SELL fills.
  const p = prioritizeFuturesMarkets({
    universe: ["哈基米USDT", "AAAUSDT"],
    portfolioPositions: [],
    leaderPositions: [
      { symbol: "哈基米USDT", state: "CLOSED", closed_at: T("2026-09-15T05:06:46Z") } as any,
    ],
    syncStates: [
      { market: "哈基米USDT", last_synced_at: T("2026-09-15T05:01:13Z") },
      { market: "AAAUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
    ],
  });
  assert(p.required.has("哈基米USDT"));
  assertEquals(p.markets[0], "哈基米USDT");
});

Deno.test("INCIDENT: non-ASCII markets survive prioritisation intact", () => {
  const p = prioritizeFuturesMarkets({
    universe: ["哈基米USDT", "我踏马来了USDT", "AAAUSDT"],
    portfolioPositions: [],
    syncStates: [],
  });
  // All three are never-synced, so all three are required and none is dropped.
  assertEquals(p.required.size, 3);
  assert(p.markets.includes("哈基米USDT"));
  assert(p.markets.includes("我踏马来了USDT"));
});

Deno.test("SYNTHETIC: a position closed BEFORE the last sync is not required", () => {
  const p = prioritizeFuturesMarkets({
    universe: ["AAAUSDT"],
    portfolioPositions: [],
    leaderPositions: [
      { symbol: "AAAUSDT", state: "CLOSED", closed_at: T("2026-09-16T10:00:00Z") } as any,
    ],
    syncStates: [{ market: "AAAUSDT", last_synced_at: T("2026-09-16T12:00:00Z") }],
  });
  assertEquals(p.required.has("AAAUSDT"), false);
  assertEquals(p.tiers.tail, ["AAAUSDT"]);
});

Deno.test("SYNTHETIC: live exchange exposure outranks everything", () => {
  const p = prioritizeFuturesMarkets({
    universe: ["AAAUSDT", "BBBUSDT"],
    portfolioPositions: [{ symbol: "BBBUSDT", positionAmt: "12.5" }],
    syncStates: [
      { market: "AAAUSDT", last_synced_at: T("2026-01-01T00:00:00Z") },
      { market: "BBBUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
    ],
  });
  assertEquals(p.tiers.exposure, ["BBBUSDT"]);
  assertEquals(p.markets[0], "BBBUSDT");
  assert(p.required.has("BBBUSDT"));
});

Deno.test("SYNTHETIC: a zero-quantity portfolio row is not exposure", () => {
  const p = prioritizeFuturesMarkets({
    universe: ["AAAUSDT"],
    portfolioPositions: [{ symbol: "AAAUSDT", positionAmt: "0" }],
    syncStates: [{ market: "AAAUSDT", last_synced_at: T("2026-09-16T13:00:00Z") }],
  });
  assertEquals(p.tiers.exposure.length, 0);
});

Deno.test("SYNTHETIC: unsettled orders make their market required", () => {
  for (const state of ["PLANNED", "DISPATCHED", "RECONCILIATION_PENDING", "RECONCILIATION_FAILED"]) {
    const p = prioritizeFuturesMarkets({
      universe: ["AAAUSDT"],
      portfolioPositions: [],
      leaderOrders: [{ symbol: "AAAUSDT", state } as any],
      syncStates: [{ market: "AAAUSDT", last_synced_at: T("2026-09-16T13:00:00Z") }],
    });
    assert(p.required.has("AAAUSDT"), state);
  }
  const settled = prioritizeFuturesMarkets({
    universe: ["AAAUSDT"],
    portfolioPositions: [],
    leaderOrders: [{ symbol: "AAAUSDT", state: "FILLED" } as any],
    syncStates: [{ market: "AAAUSDT", last_synced_at: T("2026-09-16T13:00:00Z") }],
  });
  assertEquals(settled.required.has("AAAUSDT"), false);
});

Deno.test("SYNTHETIC: the tail is bounded but required markets are never truncated", () => {
  // 162 markets, the real universe size when the starvation was observed.
  const universe = Array.from({ length: 162 }, (_, i) => `SYM${String(i).padStart(3, "0")}USDT`);
  const syncStates = universe.map((m, i) => ({
    market: m,
    last_synced_at: new Date(Date.parse("2026-09-16T13:00:00Z") - i * 60_000).toISOString(),
  }));
  const p = prioritizeFuturesMarkets({
    universe,
    // 70 markets carry live exposure -- more than the sweep budget of 60.
    portfolioPositions: universe.slice(0, 70).map((m) => ({ symbol: m, positionAmt: "1" })),
    syncStates,
    maxMarkets: 60,
  });
  assertEquals(p.required.size, 70);
  assertEquals(p.markets.length, 70, "required tiers must not be cut to fit the budget");
  assertEquals(p.tiers.tail.length, 0);
  assertEquals(p.selection, "REQUIRED_ONLY_BUDGET_EXHAUSTED");
});

Deno.test("SYNTHETIC: the tail is swept oldest-first so it cannot starve forever", () => {
  const universe = ["OLDUSDT", "MIDUSDT", "NEWUSDT"];
  const p = prioritizeFuturesMarkets({
    universe,
    portfolioPositions: [],
    syncStates: [
      { market: "NEWUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
      { market: "MIDUSDT", last_synced_at: T("2026-09-16T07:00:00Z") },
      { market: "OLDUSDT", last_synced_at: T("2026-09-13T15:38:23Z") },
    ],
    maxMarkets: 60,
  });
  assertEquals(p.tiers.tail, ["OLDUSDT", "MIDUSDT", "NEWUSDT"]);
});

Deno.test("SYNTHETIC: prioritisation is deterministic for equal sync times", () => {
  const args = {
    universe: ["BBBUSDT", "AAAUSDT", "CCCUSDT"],
    portfolioPositions: [],
    syncStates: [
      { market: "AAAUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
      { market: "BBBUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
      { market: "CCCUSDT", last_synced_at: T("2026-09-16T13:00:00Z") },
    ],
  };
  assertEquals(prioritizeFuturesMarkets(args).markets, prioritizeFuturesMarkets(args).markets);
  assertEquals(prioritizeFuturesMarkets(args).markets, ["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
});

Deno.test("SYNTHETIC: a market outside the universe is never scheduled", () => {
  const p = prioritizeFuturesMarkets({
    universe: ["AAAUSDT"],
    portfolioPositions: [],
    leaderPositions: [{ symbol: "GONEUSDT", state: "OPEN" } as any],
    syncStates: [{ market: "AAAUSDT", last_synced_at: T("2026-09-16T13:00:00Z") }],
  });
  assertEquals(p.markets.includes("GONEUSDT"), false);
  assertEquals(p.required.has("GONEUSDT"), false);
});
