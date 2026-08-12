from pathlib import Path


def replace_once_or_already(path: str, old: str, new: str) -> None:
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
test_path = Path("supabase/functions/_shared/lob/entry-quality-guard.test.ts")

replace_once_or_already(
    types,
    '''  universeMode?: "TOP10_24H_GAINERS_LOB_ONLY";
  gainerRank?: number;
  samples: number;''',
    '''  universeMode?: "TOP10_24H_GAINERS_LOB_ONLY";
  gainerRank?: number;
  /** Scan-time 24h move used only to reject measured late-extension chase setups. */
  change24hPct?: number;
  samples: number;''',
)

replace_once_or_already(
    scanner,
    '''      universeMode: period.universe.universe_mode,
      gainerRank: finiteOr(period.universe.gainer_rank, 99),
      samples: micro.samples,''',
    '''      universeMode: period.universe.universe_mode,
      gainerRank: finiteOr(period.universe.gainer_rank, 99),
      change24hPct: period.universe.change_24h_pct,
      samples: micro.samples,''',
)

replace_once_or_already(
    autotrader,
    '''    universeMode: base.universeMode,
    gainerRank: finite(base.gainerRank, finite(scan?.gainer_rank, 99)),
    samples: Math.max(1, Math.floor(finite(base.samples, tradeCount))),''',
    '''    universeMode: base.universeMode,
    gainerRank: finite(base.gainerRank, finite(scan?.gainer_rank, 99)),
    change24hPct: finite(base.change24hPct, 0),
    samples: Math.max(1, Math.floor(finite(base.samples, tradeCount))),''',
)

replace_once_or_already(
    entry,
    '''function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
''',
    '''function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFinite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
''',
)

replace_once_or_already(
    entry,
    '''    } else if (features.m1PreBreakout !== true) {
      reasons.push("M1_PREBREAKOUT_SETUP_NOT_READY");
    }
  }

  // Structural and execution checks only.''',
    '''    } else if (features.m1PreBreakout !== true) {
      reasons.push("M1_PREBREAKOUT_SETUP_NOT_READY");
    } else {
      // 2026-08-13 live-fill review: a setup labelled pre-breakout while Bollinger width
      // is still contracting is internally contradictory. In the prior 72h live cohort
      // this condition appeared twice and both trades lost. Keep squeeze releases exempt.
      const bandWidthExpansionRatio = optionalFinite(features.m1BandWidthExpansionRatio);
      if (
        bandWidthExpansionRatio != null && bandWidthExpansionRatio < 1 &&
        features.m1SqueezeRelease !== true
      ) {
        reasons.push("M1_BAND_WIDTH_NOT_EXPANDING");
      }

      // The same review isolated a late-extension cluster without using broad trend/EMA
      // vetoes: 24h move already >=15%, Stoch K >=88, the last three minutes advanced
      // >=1.9 ATR, and the upper band itself is rising >=0.10%/min. All three observed
      // trades in this exact cluster lost, while the profitable high-gainer counterexample
      // stayed below the recent-advance threshold. Require every input so missing telemetry
      // never fabricates an overheat rejection.
      const change24hPct = optionalFinite(features.change24hPct);
      const stochK = optionalFinite(features.m1StochK);
      const recentAdvanceAtr = optionalFinite(features.m1RecentAdvanceAtr);
      const upperBandSlopePct = optionalFinite(features.m1UpperBandSlopePct);
      if (
        change24hPct != null && stochK != null && recentAdvanceAtr != null &&
        upperBandSlopePct != null && change24hPct >= 15 && stochK >= 88 &&
        recentAdvanceAtr >= 1.9 && upperBandSlopePct >= 0.10
      ) {
        reasons.push("M1_LATE_EXTENSION_CHASE");
      }
    }
  }

  // Structural and execution checks only.''',
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

Deno.test("valid M1 pre-breakout remains buyable", () => {
  const decision = evaluate();
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
});

Deno.test("contracting Bollinger width cannot masquerade as pre-breakout", () => {
  const decision = evaluate({
    m1BandWidthExpansionRatio: 0.99,
    m1SqueezeRelease: false,
  });
  assert(decision.reasons.includes("M1_BAND_WIDTH_NOT_EXPANDING"));
  assert(decision.decision !== "BUY");
});

Deno.test("measured late-extension chase cluster is rejected", () => {
  const decision = evaluate({
    change24hPct: 23.5,
    m1StochK: 94.82,
    m1RecentAdvanceAtr: 1.938,
    m1UpperBandSlopePct: 0.118,
  });
  assert(decision.reasons.includes("M1_LATE_EXTENSION_CHASE"));
  assert(decision.decision !== "BUY");
});

Deno.test("large 24h gain alone is not rejected when the 1m move is not late", () => {
  const decision = evaluate({
    change24hPct: 39.05,
    m1StochK: 91.52,
    m1RecentAdvanceAtr: 1.258,
    m1UpperBandSlopePct: 0.408,
    m1BandWidthExpansionRatio: 1.065,
    m1SqueezeRelease: true,
  });
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
  assert(!decision.reasons.includes("M1_LATE_EXTENSION_CHASE"));
});

Deno.test("high stochastic and advance remain allowed when upper-band slope is shallow", () => {
  const decision = evaluate({
    change24hPct: 18.99,
    m1StochK: 96.51,
    m1RecentAdvanceAtr: 1.963,
    m1UpperBandSlopePct: 0.038,
    m1BandWidthExpansionRatio: 1.018,
    m1SqueezeRelease: false,
  });
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
  assert(!decision.reasons.includes("M1_LATE_EXTENSION_CHASE"));
});
'''

if test_path.exists():
    existing = test_path.read_text()
    if existing != test_content:
        raise SystemExit(f"unexpected existing test content: {test_path}")
else:
    test_path.write_text(test_content)

print("LOB entry quality guard patch applied")
