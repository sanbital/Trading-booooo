import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { selectLobSearchRows, type LobSearchExpansion } from "./search-expansion.ts";

function expansion(overrides: Partial<LobSearchExpansion> = {}): LobSearchExpansion {
  return {
    enabled: true,
    reason: "SEARCH_FAILURE",
    failureStreak: 1,
    baseFinalists: 12,
    finalistLimit: 18,
    observationMs: 10000,
    rotationPool: 48,
    rotationMinutes: 1,
    evaluatedAt: "2026-07-29T00:00:00Z",
    thresholdsRelaxed: false,
    ...overrides,
  };
}

Deno.test("normal scan keeps only the core heat leaders", () => {
  const rows = Array.from({ length: 60 }, (_, index) => index + 1);
  const selected = selectLobSearchRows(rows, expansion({ enabled: false, finalistLimit: 12 }));
  assertEquals(selected, Array.from({ length: 12 }, (_, index) => index + 1));
});

Deno.test("search failure keeps core leaders and adds rotating tail ranks", () => {
  const rows = Array.from({ length: 60 }, (_, index) => index + 1);
  const first = selectLobSearchRows(rows, expansion(), 0);
  const second = selectLobSearchRows(rows, expansion(), 60_000);
  assertEquals(first.slice(0, 12), rows.slice(0, 12));
  assertEquals(second.slice(0, 12), rows.slice(0, 12));
  assertEquals(first.length, 18);
  assertEquals(second.length, 18);
  assertEquals(first.slice(12), [13, 14, 15, 16, 17, 18]);
  assertEquals(second.slice(12), [19, 20, 21, 22, 23, 24]);
});

Deno.test("expanded search never duplicates or exceeds the configured limit", () => {
  const rows = Array.from({ length: 25 }, (_, index) => `M${index + 1}`);
  const selected = selectLobSearchRows(rows, expansion({ finalistLimit: 20 }), 180_000);
  assertEquals(selected.length, 20);
  assertEquals(new Set(selected).size, 20);
});
