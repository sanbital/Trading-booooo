import { evaluatePath, type StoredCandidate } from "./forward-learning.ts";

const base: StoredCandidate = {
  id: "00000000-0000-0000-0000-000000000001", scan_id: "s", exchange: "binance", market: "TESTUSDT",
  created_at: "2026-07-24T00:00:00.000Z", decision: "BUY", score: 75,
  entry_low: 99, entry_high: 100, stop_price: 97, target_1: 104, target_2: 108,
  net_rr: 1.5, estimated_cost_pct: .2, snapshot: {},
};

Deno.test("forward outcome uses conservative stop-first on ambiguous bar", () => {
  const out = evaluatePath(base, [
    {t:1,o:100,h:101,l:99,c:100},
    {t:2,o:100,h:105,l:96,c:103},
  ], 3);
  if (!out.stop_first || out.target_first || out.outcome !== "AMBIGUOUS_STOP_FIRST") throw new Error(JSON.stringify(out));
});

Deno.test("forward outcome records no-entry instead of imaginary fill", () => {
  const out = evaluatePath(base, [{t:1,o:105,h:106,l:104,c:105}], 2);
  if (out.entered || out.outcome !== "NO_ENTRY") throw new Error(JSON.stringify(out));
});
