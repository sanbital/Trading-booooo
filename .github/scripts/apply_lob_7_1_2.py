from pathlib import Path
import re

OLD_VERSION = "7.1.1-LOB-45S-PROFIT-OR-5PCT"
NEW_VERSION = "7.1.2-LOB-CONSISTENCY"


def load(path: str) -> str:
    return Path(path).read_text()


def save(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    text = load(path)
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} exact matches, found {count}")
    save(path, text.replace(old, new, expected))


def replace_regex(path: str, pattern: str, replacement: str, expected: int = 1) -> None:
    text = load(path)
    updated, count = re.subn(pattern, replacement, text, flags=re.MULTILINE)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} regex matches, found {count}: {pattern[:120]}")
    save(path, updated)


patterns = "supabase/functions/_shared/lob/patterns.ts"
entry = "supabase/functions/_shared/lob/entry.ts"
engine = "supabase/functions/market-scanner/engine.ts"
scanner = "supabase/functions/market-scanner/index.ts"
trader = "supabase/functions/market-autotrader/index.ts"

# 1) The rolling heat sample fixes only Top-10 membership. Entry probability and
# primary pattern selection use the 45-50 second live book/tape window.
replace_exact(
    patterns,
    '''  const notionalTrend = clamp((Number(f.notionalTrend) + 1) / 2);
  const tradeSpeedTrend = clamp((Number(f.tradeSpeedTrend) + 1) / 2);
  const tapeTrend = clamp((Number(f.tradeArrivalTrend) + 1) / 2);
  const liveTradeEvidence = f.tradeArrivalRate > 0 && f.aggressiveNotionalPerSecond > 0 &&
    f.dataQuality >= 0.25;
  const momentumPrimary = f.universeMode === "TOP10_24H_GAINERS_LOB_ONLY" &&
    Number(f.gainerRank) >= 1 && Number(f.gainerRank) <= 10 &&
    Number(f.notionalTrend) >= -0.20 && Number(f.tradeSpeedTrend) >= -0.20 &&
    Number(f.tradeArrivalTrend) >= -0.20 &&
    f.tradePressureFast >= 0.12 && f.micropriceDeviationBps >= -0.5 &&
    f.bookImbalance > -0.55 && votes >= 2 && liveTradeEvidence &&
    f.spreadBps != null && f.spreadBps <= 12 &&
    f.recentNotionalPerSecond > 0 && f.tradeCount >= 4;
''',
    '''  const tapeTrend = clamp((Number(f.tradeArrivalTrend) + 1) / 2);
  const liveActivity = clamp(f.tradeArrivalRate / 4, 0, 1);
  const liveNotionalIntensity = clamp(
    f.aggressiveNotionalPerSecond /
      Math.max(1, f.minActionableTurnover24h / 3600),
    0,
    1,
  );
  const liveTradeEvidence = f.tradeArrivalRate > 0 && f.aggressiveNotionalPerSecond > 0 &&
    f.dataQuality >= 0.25;
  const momentumPrimary = f.universeMode === "TOP10_24H_GAINERS_LOB_ONLY" &&
    Number(f.gainerRank) >= 1 && Number(f.gainerRank) <= 10 &&
    f.tradePressureFast >= 0.12 && f.micropriceDeviationBps >= -0.5 &&
    f.bookImbalance > -0.55 && votes >= 2 && liveTradeEvidence &&
    f.spreadBps != null && f.spreadBps <= 12 && f.tradeCount >= 4;
''',
)
replace_exact(
    patterns,
    '''    positiveFlow * 0.24 + notionalTrend * 0.16 + tradeSpeedTrend * 0.12 +
      tapeTrend * 0.12 + positiveMicroMomentum * 0.10 + clamp(votes / 3) * 0.10 +
      clamp(f.dataQuality, 0, 1) * 0.08 + clamp(f.tradeArrivalRate / 4, 0, 1) * 0.08,
''',
    '''    positiveFlow * 0.28 + tapeTrend * 0.14 + liveActivity * 0.12 +
      liveNotionalIntensity * 0.10 + positiveMicroMomentum * 0.10 +
      clamp(votes / 3) * 0.10 + clamp(f.dataQuality, 0, 1) * 0.08 +
      clamp(f.ofiPersistence, 0, 1) * 0.08,
''',
)

replace_exact(
    entry,
    '''  const momentumPulse = clamp(
    positivePressure * 0.32 +
      clamp((Number(features.notionalTrend) + 1) / 2, 0, 1) * 0.20 +
      clamp((Number(features.tradeSpeedTrend) + 1) / 2, 0, 1) * 0.16 +
      clamp((Number(features.tradeArrivalTrend) + 1) / 2, 0, 1) * 0.16 +
      clamp(features.micropriceDeviationBps / 5, 0, 1) * 0.16,
    0,
    1,
  );
''',
    '''  const liveTradeActivity = clamp(features.tradeArrivalRate / 4, 0, 1);
  const liveNotionalIntensity = clamp(
    features.aggressiveNotionalPerSecond /
      Math.max(1, features.minActionableTurnover24h / 3600),
    0,
    1,
  );
  const momentumPulse = clamp(
    positivePressure * 0.34 + clamp(features.ofiPersistence, 0, 1) * 0.18 +
      liveTradeActivity * 0.14 + liveNotionalIntensity * 0.10 +
      clamp((Number(features.tradeArrivalTrend) + 1) / 2, 0, 1) * 0.10 +
      clamp(features.micropriceDeviationBps / 5, 0, 1) * 0.08 +
      clamp(features.dataQuality, 0, 1) * 0.06,
    0,
    1,
  );
''',
)
replace_exact(
    entry,
    '''  if (Number(features.notionalTrend) < -0.20) reasons.push("FLOW_NOTIONAL_DECLINING");
  if (Number(features.tradeSpeedTrend) < -0.20) reasons.push("FLOW_TRADE_SPEED_DECLINING");
  if (Number(features.tradeArrivalTrend) < -0.20) reasons.push("TAPE_SPEED_DECLINING");
  if (features.tradePressureFast < -0.10) reasons.push("SELL_PRESSURE_DOMINANT");
  if (features.micropriceDeviationBps < -1.0) reasons.push("MICROPRICE_BEARISH");
''',
    '''  if (Number(features.notionalTrend) < -0.20) warnings.push("FLOW_NOTIONAL_DECLINING_DIAGNOSTIC");
  if (Number(features.tradeSpeedTrend) < -0.20) warnings.push("FLOW_TRADE_SPEED_DECLINING_DIAGNOSTIC");
  if (Number(features.tradeArrivalTrend) < -0.20) warnings.push("TAPE_SPEED_DECLINING_DIAGNOSTIC");
  if (features.tradePressureFast < -0.10) reasons.push("SELL_PRESSURE_DOMINANT");
  const bearishMicropriceConfirmed = features.micropriceDeviationBps < -2.5 &&
    features.tradePressureFast < 0.05 && features.bookImbalance < 0.10;
  if (bearishMicropriceConfirmed) reasons.push("MICROPRICE_BEARISH");
  else if (features.micropriceDeviationBps < -1.0) {
    warnings.push("MICROPRICE_BEARISH_UNCONFIRMED");
  }
''',
)
replace_exact(
    entry,
    '''  const evLowerBoundBps = conditionalEvLowerBoundBps;

  for (const reason of payoff.reasons) reasons.push(reason);
''',
    '''  const evLowerBoundBps = conditionalEvLowerBoundBps;
  if (!(evLowerBoundBps > cfg.minEvBps)) reasons.push("EV_BELOW_MINIMUM");

  for (const reason of payoff.reasons) reasons.push(reason);
''',
)
replace_exact(
    entry,
    '''  const technicalBlock = reasons.some((r) =>
    r.startsWith("TRAP_") ||
    r.startsWith("FLOW_") ||
    r.startsWith("FIXED_PLAN_") ||
    r === "TAPE_SPEED_DECLINING" ||
    r === "SELL_PRESSURE_DOMINANT" ||
    r === "MICROPRICE_BEARISH" ||
''',
    '''  const technicalBlock = reasons.some((r) =>
    r.startsWith("TRAP_") ||
    r.startsWith("FIXED_PLAN_") ||
    r === "EV_BELOW_MINIMUM" ||
    r === "SELL_PRESSURE_DOMINANT" ||
    r === "MICROPRICE_BEARISH" ||
''',
)

# 2) Robust recent-window microprice and explicit observation-end frame.
replace_exact(
    engine,
    '''    const signature = bookSignature(item.snapshot);
    if (!signature || signature === previousSignature) continue;
    previousSignature = signature;
''',
    '''    const signature = bookSignature(item.snapshot);
    const observationBoundary = String(item.snapshot.stream_type || "").toUpperCase() ===
      "OBSERVATION_END";
    if (!signature || (signature === previousSignature && !observationBoundary)) continue;
    if (signature !== previousSignature) previousSignature = signature;
''',
)
replace_exact(
    engine,
    '''  const latestUnit = latestFrame?.units?.[0];
  const mid = latestFrame ? (latestFrame.bestBid + latestFrame.bestAsk) / 2 : 0;
  const microprice = latestUnit && latestUnit.bidSize + latestUnit.askSize > 0
    ? (latestUnit.askPrice * latestUnit.bidSize + latestUnit.bidPrice * latestUnit.askSize) /
      (latestUnit.bidSize + latestUnit.askSize)
    : mid;
  const micropriceDeviationBps = mid > 0 ? (microprice / mid - 1) * 10_000 : 0;
''',
    '''  const mid = latestFrame ? (latestFrame.bestBid + latestFrame.bestAsk) / 2 : 0;
  const recentMicroFrames = frames.slice(
    -Math.max(5, Math.min(60, Math.ceil(frames.length * 0.35))),
  );
  const micropriceSamples = recentMicroFrames.flatMap((frame) => {
    const unit = frame.units[0];
    const frameMid = (frame.bestBid + frame.bestAsk) / 2;
    if (!unit || !(frameMid > 0) || !(unit.bidSize + unit.askSize > 0)) return [];
    const frameMicroprice =
      (unit.askPrice * unit.bidSize + unit.bidPrice * unit.askSize) /
      (unit.bidSize + unit.askSize);
    return [(frameMicroprice / frameMid - 1) * 10_000];
  });
  const sortedMicroprice = [...micropriceSamples].sort((a, b) => a - b);
  const trim = Math.floor(sortedMicroprice.length * 0.10);
  const trimmedMicroprice = sortedMicroprice.slice(
    trim,
    Math.max(trim + 1, sortedMicroprice.length - trim),
  );
  const micropriceDeviationBps = sortedMicroprice.length
    ? median(sortedMicroprice) * 0.65 + mean(trimmedMicroprice) * 0.35
    : 0;
''',
)
replace_exact(
    engine,
    '''        lobResult.evLowerBoundBps > 0,
        `${lobResult.evLowerBoundBps.toFixed(3)}bp`,
''',
    '''        lobResult.evLowerBoundBps > lobResult.minimumVerifiedEvBps,
        `${lobResult.evLowerBoundBps.toFixed(3)}bp / 최소 ${
          lobResult.minimumVerifiedEvBps.toFixed(3)
        }bp`,
''',
)

# 3) Seal each connected observation and retain partial streamed books/trades.
replace_exact(
    scanner,
    '''function allDynamicMarketsCovered(
  coverage: Map<string, DynamicMarketCoverage>,
): boolean {
  return coverage.size > 0 && [...coverage.values()].every((state) => state.complete);
}
''',
    '''function allDynamicMarketsCovered(
  coverage: Map<string, DynamicMarketCoverage>,
): boolean {
  return coverage.size > 0 && [...coverage.values()].every((state) => state.complete);
}

function sealDynamicObservation(
  snapshots: Map<string, OrderbookSnapshot[]>,
  coverage: Map<string, DynamicMarketCoverage>,
  now = Date.now(),
): void {
  for (const [market, bucket] of snapshots.entries()) {
    const last = bucket.at(-1);
    if (!last) continue;
    const lastTimestamp = Number(last.timestamp || 0);
    if (now - lastTimestamp > 50) {
      bucket.push({
        ...last,
        market,
        timestamp: now,
        stream_type: "OBSERVATION_END",
      });
    }
  }
  refreshDynamicCoverage(coverage, now);
}
''',
)
replace_exact(
    scanner,
    '''      else {
        refreshDynamicCoverage(coverage);
        resolve({ snapshots, trades, coverage });
      }
''',
    '''      else {
        sealDynamicObservation(snapshots, coverage);
        resolve({ snapshots, trades, coverage });
      }
''',
    expected=2,
)
merge_pattern = r'''(?ms)^      if \(marketCoverage\?\.complete && streamedBooks\.length >= 2\) \{\n        snapshots\.set\(market, streamedBooks\);\n        websocketMarkets\+\+;\n        if \(streamedTrades\.length\) \{\n          trades\.set\(market, \[\n            \.\.\.\(trades\.get\(market\) \|\| \[\]\),\n            \.\.\.streamedTrades,\n          \]\);\n        \}\n      \}'''
merge_replacement = '''      if (streamedBooks.length >= 2) {
        snapshots.set(market, streamedBooks);
        if (marketCoverage?.complete) websocketMarkets++;
      } else if (streamedBooks.length === 1) {
        snapshots.set(market, [
          ...(snapshots.get(market) || []),
          ...streamedBooks,
        ]);
      }
      if (streamedTrades.length) {
        trades.set(market, [
          ...(trades.get(market) || []),
          ...streamedTrades,
        ]);
      }'''
replace_regex(scanner, merge_pattern, merge_replacement, expected=2)

# 4) Order-time recheck uses fresh geometry, the same EV threshold, and expected
# admission failures remain REJECTED rather than engine ERROR.
replace_exact(
    trader,
    '''  const microprice = bidSize + askSize > 0
    ? (bestAsk * bidSize + bestBid * askSize) / (bidSize + askSize)
    : mid;
''',
    '''  const microprice = bidSize + askSize > 0
    ? (bestAsk * bidSize + bestBid * askSize) / (bidSize + askSize)
    : mid;
  const liveMicropriceDeviationBps = mid > 0 ? (microprice / mid - 1) * 10000 : 0;
  const scanMicropriceDeviationBps = finite(
    base.micropriceDeviationBps,
    liveMicropriceDeviationBps,
  );
  const robustMicropriceDeviationBps = scanMicropriceDeviationBps * 0.70 +
    liveMicropriceDeviationBps * 0.30;
''',
)
replace_exact(
    trader,
    '''    micropriceDeviationBps: mid > 0 ? (microprice / mid - 1) * 10000 : 0,
''',
    '''    micropriceDeviationBps: robustMicropriceDeviationBps,
''',
)
replace_exact(
    trader,
    '''      learnedStopFloorBps: 0,
      fixedTargetBps: fixedPlanTargetBps,
      fixedStopBps: fixedPlanStopBps,
      fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,
''',
    '''      learnedStopFloorBps: 0,
''',
)
replace_regex(
    trader,
    r'''(?ms)^    // v7\.1\.1: FIXED_PLAN_STOP_INVALIDATED.*?^    if \(decision\.decision !== "BUY" && !fixedPlanCompatibilityEntry\) \{''',
    '''    // The shared evaluator is authoritative at scan and order time. The live
    // recheck solves fresh geometry and must retain positive conservative EV.
    if (decision.decision !== "BUY") {''',
)
replace_exact(
    trader,
    '''    // The model stop remains available for entry EV, but execution uses the user's
    // single hard-loss boundary. No tighter LOB stop may liquidate a losing position.
    const stopPct = 0.05;
''',
    '''    // Execute the freshly solved stop used by the order-time EV calculation.
    // Five percent remains the absolute per-trade loss ceiling.
    const stopPct = clamp(decision.stopBps / 10000, 0.0001, 0.05);
''',
)
replace_exact(
    trader,
    '''async function enterCandidate(
  candidate: Candidate,
  settings: TradingSettings,
''',
    '''function expectedLobAdmissionRejection(message: string): boolean {
  return /(?:FIXED_PLAN_STOP_INVALIDATED|EV_BELOW_MINIMUM|TARGET_NET_CUSHION_TOO_SMALL|NO_PRIMARY_LOB_PATTERN|INSUFFICIENT_LOB_SAMPLES|INSUFFICIENT_OBSERVATION_WINDOW|STALE_ORDERBOOK|SPREAD_TOO_WIDE|low-evidence|uneconomic payoff|admission rejected|LOB recheck)/i.test(message);
}

async function enterCandidate(
  candidate: Candidate,
  settings: TradingSettings,
''',
)
replace_exact(
    trader,
    '''  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordDecision({
      decisionId,
      cycleId,
      scanId: candidate.scan_id ? String(candidate.scan_id) : null,
      exchange: candidate.exchange,
      market: candidate.market,
      outcome: "ERROR",
      reason: message,
      audit: (candidate as any).__decision_audit || null,
    });
    await recordLatency(trace, { outcome: "ERROR" });
    throw error;
  }
''',
    '''  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expectedRejection = isLobStrategy((settings as any).strategy) &&
      expectedLobAdmissionRejection(message);
    await recordDecision({
      decisionId,
      cycleId,
      scanId: candidate.scan_id ? String(candidate.scan_id) : null,
      exchange: candidate.exchange,
      market: candidate.market,
      outcome: expectedRejection ? "REJECTED" : "ERROR",
      reason: message,
      audit: (candidate as any).__decision_audit || null,
    });
    await recordLatency(trace, { outcome: expectedRejection ? "REJECTED" : "ERROR" });
    if (expectedRejection) {
      await event("LOB_EXPECTED_REJECTION", message, {
        candidate_id: candidate.id,
        exchange: candidate.exchange,
        market: candidate.market,
      }, { cycleId, level: "INFO" }).catch(() => null);
      return {
        entered: false,
        exchange: candidate.exchange,
        market: candidate.market,
        reason: message,
        decision_id: decisionId,
      };
    }
    throw error;
  }
''',
)

for path in (engine, scanner, trader):
    text = load(path)
    if OLD_VERSION not in text:
        raise SystemExit(f"{path}: old version marker missing")
    save(path, text.replace(OLD_VERSION, NEW_VERSION))

# Regression assertions.
assert 'reasons.push("FLOW_NOTIONAL_DECLINING")' not in load(entry)
assert 'reasons.push("FLOW_TRADE_SPEED_DECLINING")' not in load(entry)
assert 'reasons.push("TAPE_SPEED_DECLINING")' not in load(entry)
assert 'reasons.push("EV_BELOW_MINIMUM")' in load(entry)
assert "sealDynamicObservation" in load(scanner)
assert load(scanner).count("if (streamedBooks.length >= 2)") == 2
assert "recentMicroFrames" in load(engine)
assert "fixedTargetBps: fixedPlanTargetBps" not in load(trader)
assert "expectedLobAdmissionRejection" in load(trader)
assert "const stopPct = clamp(decision.stopBps / 10000" in load(trader)
print(NEW_VERSION)
