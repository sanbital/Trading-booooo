from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text and old not in text:
        print(f"already patched: {path}")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"expected unique source fragment missing or duplicated: {path}: count={count}"
        )
    p.write_text(text.replace(old, new, 1))


types = "supabase/functions/_shared/lob/types.ts"
entry = "supabase/functions/_shared/lob/entry.ts"
scanner = "supabase/functions/market-scanner/engine.ts"
autotrader = "supabase/functions/market-autotrader/index.ts"
test_path = Path("supabase/functions/_shared/lob/extreme-mover-entry-guard.test.ts")

replace_once(
    types,
    '''  /** Scan-time 24h move used only to reject measured late-extension chase setups. */
  change24hPct?: number;
  samples: number;''',
    '''  /** Scan-time 24h move used by extreme-mover and late-extension entry guards. */
  change24hPct?: number;
  /** Scan-time (high-low)/opening-price range over the venue ticker window. */
  dayRangePct?: number;
  samples: number;''',
)

replace_once(
    scanner,
    '''      universeMode: period.universe.universe_mode,
      gainerRank: finiteOr(period.universe.gainer_rank, 99),
      change24hPct: period.universe.change_24h_pct,
      samples: micro.samples,''',
    '''      universeMode: period.universe.universe_mode,
      gainerRank: finiteOr(period.universe.gainer_rank, 99),
      change24hPct: period.universe.change_24h_pct,
      dayRangePct: period.universe.day_range_pct,
      samples: micro.samples,''',
)

replace_once(
    autotrader,
    '''    universeMode: base.universeMode,
    gainerRank: finite(base.gainerRank, finite(scan?.gainer_rank, 99)),
    change24hPct: finite(base.change24hPct, 0),
    samples: Math.max(1, Math.floor(finite(base.samples, tradeCount))),''',
    '''    universeMode: base.universeMode,
    gainerRank: finite(base.gainerRank, finite(scan?.gainer_rank, 99)),
    change24hPct: finite(base.change24hPct, 0),
    dayRangePct: finite(base.dayRangePct, 0),
    samples: Math.max(1, Math.floor(finite(base.samples, tradeCount))),''',
)

replace_once(
    entry,
    '''  // The completed candle is deliberately the small pre-breakout candle. A large expansion
  // candle, a late three-bar advance, or a band that is not just beginning to widen blocks.
  if (cfg.requireMinuteEntryGate === true) {''',
    '''  // Extreme-mover guard. The live review on 2026-08-13 showed that the largest spot
  // losses came from event-like symbols whose venue ticker range was tens of times wider
  // than BTC/ETH. This guard is evaluated before the minute gate so missing candle telemetry
  // cannot make a hyper-volatile symbol look safe.
  const change24hPct = optionalFinite(features.change24hPct);
  const dayRangePct = optionalFinite(features.dayRangePct);
  const recentAdvanceAtrForExtremeMove = optionalFinite(features.m1RecentAdvanceAtr);
  const bandWidthExpansionForExtremeMove = optionalFinite(features.m1BandWidthExpansionRatio);
  const controlledPositiveContinuation = change24hPct != null && change24hPct >= 15 &&
    features.m1SqueezeRelease === true && recentAdvanceAtrForExtremeMove != null &&
    recentAdvanceAtrForExtremeMove < 1.5 && bandWidthExpansionForExtremeMove != null &&
    bandWidthExpansionForExtremeMove >= 1 && bandWidthExpansionForExtremeMove <= 1.25;

  if (dayRangePct != null && dayRangePct >= 20) {
    reasons.push("EXTREME_24H_RANGE");
  }
  if (
    change24hPct != null && Math.abs(change24hPct) >= 15 &&
    !controlledPositiveContinuation
  ) {
    reasons.push("EXTREME_24H_MOVE");
  }

  // The completed candle is deliberately the small pre-breakout candle. A large expansion
  // candle, a late three-bar advance, or a band that is not just beginning to widen blocks.
  if (cfg.requireMinuteEntryGate === true) {''',
)

replace_once(
    entry,
    '''      const change24hPct = optionalFinite(features.change24hPct);
      const stochK = optionalFinite(features.m1StochK);''',
    '''      const stochK = optionalFinite(features.m1StochK);''',
)

test_content = r'''import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateLobEntry } from "./entry.ts";
import { MINUTE_ENTRY_GATE_VERSION } from "./minute-entry-gate.ts";
import type { LobCostEstimate, LobFeatureVector } from "./types.ts";

function features(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    universeMode: "TOP10_24H_GAINERS_LOB_ONLY",
    gainerRank: 1,
    change24hPct: 12,
    dayRangePct: 8,
    samples: 40,
    observationMs: 50_000,
    bookAgeMs: 100,
    spreadBps: 3,
    bookImbalance: 0.35,
    imbalanceStability: 0.80,
    tradePressureFast: 0.55,
    tradeCount: 80,
    buyNotional: 80_000,
    sellNotional: 30_000,
    averageTradeNotional: 1_375,
    bookUpdateRate: 20,
    tradeArrivalRate: 12,
    aggressiveNotionalPerSecond: 13_750,
    micropriceDeviationBps: 3,
    bidDepthQuote: 500_000,
    askDepthQuote: 350_000,
    depthRatio: 1.4,
    spoofLikeScore: 0.05,
    askSpoofScore: 0.05,
    askAbsorptionScore: 0.10,
    askRefillRatio: 0.10,
    bidAbsorptionScore: 0.20,
    breakoutScore: 0.85,
    sweepReclaimScore: 0.20,
    ofiPersistence: 0.75,
    persistentBidWall: true,
    persistentAskWall: false,
    dynamicStatus: "NEUTRAL",
    dataQuality: 0.80,
    turnover24hQuote: 50_000_000,
    minActionableTurnover24h: 100_000,
    trendContext: 0,
    marketHeatScore: 60,
    recentNotionalPerSecond: 13_750,
    notionalAcceleration: 0.30,
    tradeCountPerSecond: 10,
    notionalTrend: 0.10,
    tradeSpeedTrend: 0.10,
    tradeArrivalTrend: 0.10,
    pathEfficiency: 0.65,
    reversalRate: 0.20,
    noiseBandBps: 4,
    quoteFlickerRate: 5,
    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
    m1GateVersion: MINUTE_ENTRY_GATE_VERSION,
    m1DataAvailable: true,
    m1PreviousBullish: true,
    m1StochK: 82,
    m1StochD: 75,
    m1CompletedBars: 59,
    m1BandWidthExpansionRatio: 1.05,
    m1UpperBandSlopePct: 0.20,
    m1RecentAdvanceAtr: 1.20,
    m1VolumeRatio: 1.1,
    m1SqueezeRelease: true,
    m1PreBreakout: true,
    m1CorePassed: true,
    ...overrides,
  };
}

const costs: LobCostEstimate = {
  roundTripFeeBps: 10,
  entrySlippageBps: 1,
  targetExitSlippageBps: 1,
  stopExitSlippageBps: 2,
  spreadBps: 3,
  latencyPenaltyBps: 0.5,
  forecastBiasPenaltyBps: 0,
};

function evaluate(overrides: Partial<LobFeatureVector> = {}) {
  return evaluateLobEntry(features(overrides), costs, { requireMinuteEntryGate: true });
}

Deno.test("normal measured pre-breakout remains buyable", () => {
  const decision = evaluate();
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
});

Deno.test("PROM-like extreme drawdown and wide range are rejected", () => {
  const decision = evaluate({
    change24hPct: -20.9,
    dayRangePct: 32.4,
    m1SqueezeRelease: false,
    m1RecentAdvanceAtr: 1.2,
  });
  assert(decision.reasons.includes("EXTREME_24H_MOVE"));
  assert(decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(decision.decision !== "BUY");
});

Deno.test("COTI-like event range is rejected even during a bullish continuation", () => {
  const decision = evaluate({
    change24hPct: 40.9,
    dayRangePct: 62.9,
    m1SqueezeRelease: true,
    m1RecentAdvanceAtr: 1.2,
    m1BandWidthExpansionRatio: 1.05,
  });
  assert(decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(decision.decision !== "BUY");
});

Deno.test("positive extreme move without controlled continuation is rejected", () => {
  const decision = evaluate({
    change24hPct: 24,
    dayRangePct: 12,
    m1SqueezeRelease: false,
    m1RecentAdvanceAtr: 1.7,
    m1BandWidthExpansionRatio: 1.12,
  });
  assert(decision.reasons.includes("EXTREME_24H_MOVE"));
  assert(decision.decision !== "BUY");
});

Deno.test("measured profitable high-gainer counterexample remains admissible", () => {
  const decision = evaluate({
    change24hPct: 39.05,
    dayRangePct: 12,
    m1StochK: 91.52,
    m1RecentAdvanceAtr: 1.258,
    m1UpperBandSlopePct: 0.408,
    m1BandWidthExpansionRatio: 1.065,
    m1SqueezeRelease: true,
  });
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
  assert(!decision.reasons.includes("EXTREME_24H_MOVE"));
  assert(!decision.reasons.includes("EXTREME_24H_RANGE"));
});
'''

if test_path.exists():
    existing = test_path.read_text()
    if existing != test_content:
        raise SystemExit(f"unexpected existing test content: {test_path}")
else:
    test_path.write_text(test_content)

print("extreme mover entry guard patch applied")
