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


def append_once(path: str, marker: str, block: str) -> None:
    p = Path(path)
    text = p.read_text()
    if marker in text:
        print(f"already appended: {path}: {marker}")
        return
    p.write_text(text.rstrip() + "\n\n" + block.strip() + "\n")


types = "supabase/functions/_shared/lob/types.ts"
entry = "supabase/functions/_shared/lob/entry.ts"
scanner = "supabase/functions/market-scanner/engine.ts"
autotrader = "supabase/functions/market-autotrader/index.ts"
test = "supabase/functions/_shared/lob/entry-quality-guard.test.ts"

replace_once_or_already(
    types,
    '''  /** Scan-time 24h move used only to reject measured late-extension chase setups. */
  change24hPct?: number;
  samples: number;''',
    '''  /** Scan-time 24h move used by event-risk and late-extension entry guards. */
  change24hPct?: number;
  /** Venue ticker (high-low)/open range used to reject event-like hyper-volatility. */
  dayRangePct?: number;
  samples: number;''',
)

replace_once_or_already(
    scanner,
    '''      change24hPct: period.universe.change_24h_pct,
      samples: micro.samples,''',
    '''      change24hPct: period.universe.change_24h_pct,
      dayRangePct: period.universe.day_range_pct,
      samples: micro.samples,''',
)

replace_once_or_already(
    autotrader,
    '''    change24hPct: finite(base.change24hPct, 0),
    samples: Math.max(1, Math.floor(finite(base.samples, tradeCount))),''',
    '''    change24hPct: finite(base.change24hPct, 0),
    dayRangePct: finite(base.dayRangePct, 0),
    samples: Math.max(1, Math.floor(finite(base.samples, tradeCount))),''',
)

replace_once_or_already(
    entry,
    '''  // The completed candle is deliberately the small pre-breakout candle. A large expansion
  // candle, a late three-bar advance, or a band that is not just beginning to widen blocks.
  if (cfg.requireMinuteEntryGate === true) {''',
    '''  // Extreme-mover guard from the 2026-08-13 live-fill review. PROM and COTI were not
  // broad-market failures: each had an event-like venue range far outside the benchmark
  // regime. Reject that failure mode without banning healthy high gainers outright.
  // Missing telemetry never fabricates a rejection.
  const extremeChange24hPct = optionalFinite(features.change24hPct);
  const dayRangePct = optionalFinite(features.dayRangePct);
  if (dayRangePct != null && dayRangePct >= 20) {
    reasons.push("EXTREME_24H_RANGE");
  }
  if (extremeChange24hPct != null && extremeChange24hPct <= -15) {
    reasons.push("EXTREME_24H_DRAWDOWN");
  }

  // Momentum-chase guard: after a >=1.5 ATR three-minute advance, a current 1m volume
  // ratio below 0.70 means participation has already faded. Only apply it after a meaningful
  // positive 24h move so ordinary low-volume consolidations stay eligible.
  const chaseRecentAdvanceAtr = optionalFinite(features.m1RecentAdvanceAtr);
  const chaseVolumeRatio = optionalFinite(features.m1VolumeRatio);
  if (
    extremeChange24hPct != null && extremeChange24hPct >= 10 &&
    chaseRecentAdvanceAtr != null && chaseRecentAdvanceAtr >= 1.5 &&
    chaseVolumeRatio != null && chaseVolumeRatio < 0.70
  ) {
    reasons.push("M1_MOMENTUM_CHASE_VOLUME_FADE");
  }

  // The completed candle is deliberately the small pre-breakout candle. A large expansion
  // candle, a late three-bar advance, or a band that is not just beginning to widen blocks.
  if (cfg.requireMinuteEntryGate === true) {''',
)

append_once(
    test,
    'Deno.test("PROM-like extreme drawdown and range are rejected"',
    r'''
Deno.test("PROM-like extreme drawdown and range are rejected", () => {
  const decision = evaluate({
    change24hPct: -20.9,
    dayRangePct: 32.4,
    m1RecentAdvanceAtr: 0.8,
    m1VolumeRatio: 1.0,
  });
  assert(decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(decision.reasons.includes("EXTREME_24H_DRAWDOWN"));
  assert(decision.decision !== "BUY");
});

Deno.test("COTI-like event range is rejected without banning normal high gainers", () => {
  const decision = evaluate({
    change24hPct: 40.9,
    dayRangePct: 62.9,
    m1RecentAdvanceAtr: 1.2,
    m1VolumeRatio: 1.1,
    m1BandWidthExpansionRatio: 1.05,
    m1SqueezeRelease: true,
  });
  assert(decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(decision.decision !== "BUY");
});

Deno.test("normal high gainer with controlled range remains buyable", () => {
  const decision = evaluate({
    change24hPct: 18.99,
    dayRangePct: 12,
    m1StochK: 91,
    m1RecentAdvanceAtr: 1.2,
    m1VolumeRatio: 1.05,
    m1UpperBandSlopePct: 0.08,
    m1BandWidthExpansionRatio: 1.05,
    m1SqueezeRelease: true,
  });
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
  assert(!decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(!decision.reasons.includes("M1_MOMENTUM_CHASE_VOLUME_FADE"));
});

Deno.test("volume fade after an ATR chase is rejected", () => {
  const decision = evaluate({
    change24hPct: 12,
    dayRangePct: 14,
    m1RecentAdvanceAtr: 1.6,
    m1VolumeRatio: 0.6,
  });
  assert(decision.reasons.includes("M1_MOMENTUM_CHASE_VOLUME_FADE"));
  assert(decision.decision !== "BUY");
});
''',
)

print("Extreme mover entry guard patch applied")
