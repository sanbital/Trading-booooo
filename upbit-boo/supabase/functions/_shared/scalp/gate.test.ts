import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scalpEntryDecision } from "./scalp-gate.ts";
import { DEFAULT_SCALP_SAFETY } from "./safety.ts";
import { DEFAULT_COST_MODEL } from "./cost-model.ts";

const deepAsk = [{ price: 100.0, size: 20_000 }, { price: 100.1, size: 20_000 }];
const deepBid = [{ price: 99.9, size: 20_000 }, { price: 99.8, size: 20_000 }];

const base = {
  capitalQuote: 1_000_000,
  requestedNotional: 500_000,
  day: { realizedPnlQuote: 0, consecutiveLosses: 0 },
  pWin: 0.9,
  targetPct: 0.008,
  stopPct: 0.003,
  askLevels: deepAsk,
  bidLevels: deepBid,
  bestAsk: 100.0,
  bestBid: 99.9,
};

Deno.test("passes a strong forecast without an extra cap inside operator allocation", () => {
  const r = scalpEntryDecision(base, DEFAULT_SCALP_SAFETY, DEFAULT_COST_MODEL);
  assert(r.allow);
  assertEquals(r.notional, 500_000);
  assert((r.expectedNetEdge ?? -1) >= DEFAULT_COST_MODEL.minimumEdge);
});

Deno.test("futures safety caps margin while depth and EV see leveraged contract notional", () => {
  const r = scalpEntryDecision(
    {
      ...base,
      capitalQuote: 50,
      requestedCapital: 50,
      notionalPerCapital: 3,
      requestedNotional: 150,
    },
    DEFAULT_SCALP_SAFETY,
    DEFAULT_COST_MODEL,
  );
  assert(r.allow);
  assertEquals(r.notional, 150);
});

Deno.test("safety halt runs FIRST — daily loss blocks before EV is considered", () => {
  const r = scalpEntryDecision(
    { ...base, day: { realizedPnlQuote: -600_000, consecutiveLosses: 0 } },
    DEFAULT_SCALP_SAFETY,
    DEFAULT_COST_MODEL,
  );
  assertEquals(r.allow, false);
  assertEquals(r.reason, "daily_loss_limit");
  assertEquals(r.expectedNetEdge, null); // never reached the EV step
});

Deno.test("kill switch blocks everything", () => {
  const r = scalpEntryDecision(
    base,
    { ...DEFAULT_SCALP_SAFETY, killSwitch: true },
    DEFAULT_COST_MODEL,
  );
  assertEquals(r.allow, false);
  assertEquals(r.reason, "kill_switch");
});

Deno.test("weak EV is rejected even after passing safety", () => {
  // symmetric-ish target/stop with modest pWin => negative EV after costs
  const r = scalpEntryDecision(
    { ...base, pWin: 0.55, targetPct: 0.004, stopPct: 0.003 },
    DEFAULT_SCALP_SAFETY,
    DEFAULT_COST_MODEL,
  );
  assertEquals(r.allow, false);
  assertEquals(r.reason, "edge_below_minimum");
  assert(r.notional === 500_000); // allocation amount reached EV, then was rejected
});
