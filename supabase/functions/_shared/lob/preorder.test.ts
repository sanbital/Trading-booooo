import { assessLobPreOrderPair, type LobPreOrderRecheck } from "./preorder.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function recheck(overrides: Partial<LobPreOrderRecheck> = {}): LobPreOrderRecheck {
  return {
    passed: true,
    reasons: [],
    decision: "BUY",
    checkedAt: new Date(0).toISOString(),
    bestBid: 100,
    bestAsk: 100.1,
    spreadBps: 10,
    bidDepthQuote: 100_000,
    askDepthQuote: 80_000,
    tradePressureFast: 0.1,
    micropriceDeviationBps: 0.2,
    features: {} as LobPreOrderRecheck["features"],
    ...overrides,
  };
}

Deno.test("both stable pre-order LOB snapshots pass", () => {
  const result = assessLobPreOrderPair(recheck(), recheck({ bidDepthQuote: 80_000 }));
  assert(result.passed);
});

Deno.test("either individual pre-order rejection cancels the pair", () => {
  const result = assessLobPreOrderPair(
    recheck(),
    recheck({ passed: false, reasons: ["BID_SPOOF_CONFIRMED_BY_WEAK_FLOW"] }),
  );
  assert(!result.passed);
  assert(result.reasons.includes("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW"));
});

Deno.test("rapid bid-depth collapse blocks only with current adverse flow", () => {
  const cleanFlow = assessLobPreOrderPair(
    recheck(),
    recheck({ bidDepthQuote: 60_000 }),
  );
  const adverseFlow = assessLobPreOrderPair(
    recheck(),
    recheck({ bidDepthQuote: 60_000, tradePressureFast: -0.01 }),
  );
  assert(cleanFlow.passed, "depth decay alone must not be a broad veto");
  assert(!adverseFlow.passed);
  assert(adverseFlow.reasons.includes("PREORDER_SUPPORT_EVAPORATION_CONFIRMED"));
});
