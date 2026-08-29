from pathlib import Path
import re

ROOT = Path('supabase/functions/regime-router-v5-research')

# ops.test.ts: candidate-product assertions follow the frozen registry instead of stale V5 literal 19.
p = ROOT / 'ops.test.ts'
s = p.read_text()
s = s.replace('assertEquals(captured.config?.candidate_count, 19);', 'assertEquals(captured.config?.candidate_count, candidates().length);')
s = s.replace('assertEquals(resultRows[0].length, 19 * 4 * 3);', 'assertEquals(resultRows[0].length, candidates().length * 4 * 3);')
p.write_text(s)

# strategies.test.ts: assert the new exact registry and replace the obsolete long-only RANGE test.
p = ROOT / 'strategies.test.ts'
s = p.read_text()
s = s.replace('assertEquals(first.length, 19);', 'assertEquals(first.length, 20);')
s = s.replace(
    '  assert(first.some((candidate) => candidate.family === "COMPRESSION_BREAKOUT"));\n',
    '  assert(first.some((candidate) => candidate.family === "COMPRESSION_BREAKOUT"));\n'
    '  assert(first.some((candidate) => candidate.name.includes("V6_RANGE_LONG_EDGE_P25")));\n'
    '  assert(first.some((candidate) => candidate.name.includes("V6_RANGE_SHORT_EDGE_P75")));\n'
)
pattern = r'Deno\.test\("RANGE requires a dynamic-percentile up-cycle and a cost-aware mean target", \(\) => \{.*?\n\}\);\n\nfunction bearSetup'
replacement = r'''Deno.test("RANGE V6 trades only scored lower/upper edges and does not hard-require 5m", () => {
  const longCandidate = named("V6_RANGE_LONG_EDGE_P25");
  const longPrevious = bar({
    time: 0,
    open: 99.8,
    high: 100.0,
    low: 99.3,
    close: 99.4,
    ret2: -0.004,
    stochK: 8,
    stochD: 10,
    stochPercentile7d: 0.18,
  });
  const longCurrent = bar({
    open: 99.35,
    high: 99.8,
    low: 99.15,
    close: 99.5,
    ema20: 99.8,
    ema50: 99.7,
    adx: 17,
    stochK: 13,
    stochD: 11,
    stochPercentile7d: 0.20,
    rsi: 43,
    rsiSlope2: 0.6,
    rsiPercentile7d: 0.25,
    vwap96: 100.8,
    dayOpen: 100.9,
    bbMid: 100.6,
    bbLower: 99.2,
    bbUpper: 101.8,
    rangeMid20Prev: 100.75,
    high20Prev: 103,
    low20Prev: 98.5,
    high8Prev: 101.5,
    low8Prev: 99.0,
    volumeRatio: 1.0,
    ret24h: 0.01,
  });
  const longContext = tactical("RANGE", "RANGE_UP_CYCLE", "UP_CYCLE", {
    localBreadth: 0.45,
    breadthVelocity: 0,
    fiveMinuteConfirmed: false,
  });
  const longDecision = signalDecision(
    [longPrevious, longCurrent],
    1,
    longCandidate,
    longContext,
    structural("RANGE"),
  );
  assertEquals(longDecision.ok, true);
  assertEquals(longDecision.targetHint, 100.6);
  assert(!longDecision.reasons.includes("FIVE_MINUTE_CONFIRMATION_REQUIRED"));

  const midRange = signalDecision(
    [longPrevious, { ...longCurrent, close: 100.7, low: 99.15, bbMid: 101.5, vwap96: 101.7, dayOpen: 101.8 }],
    1,
    longCandidate,
    longContext,
    structural("RANGE"),
  );
  assertEquals(midRange.ok, false);
  assert(midRange.reasons.includes("LONG_NOT_AT_RANGE_LOWER_EDGE"));

  const shortCandidate = named("V6_RANGE_SHORT_EDGE_P75");
  const shortPrevious = bar({
    time: 0,
    open: 100.2,
    high: 100.8,
    low: 100.0,
    close: 100.6,
    stochK: 90,
    stochD: 85,
    stochPercentile7d: 0.82,
  });
  const shortCurrent = bar({
    open: 100.7,
    high: 100.85,
    low: 100.3,
    close: 100.5,
    ema20: 100.2,
    ema50: 100.1,
    adx: 17,
    stochK: 75,
    stochD: 80,
    stochPercentile7d: 0.78,
    rsi: 58,
    rsiSlope2: -0.6,
    rsiPercentile7d: 0.75,
    vwap96: 99.5,
    dayOpen: 99.4,
    bbMid: 99.7,
    bbLower: 98.2,
    bbUpper: 100.8,
    rangeMid20Prev: 99.3,
    high20Prev: 101.5,
    low20Prev: 97,
    high8Prev: 101.2,
    low8Prev: 98.0,
    volumeRatio: 1.0,
    ret24h: -0.01,
  });
  const shortContext = tactical("RANGE", "RANGE_DOWN_CYCLE", "DOWN_CYCLE", {
    localBreadth: 0.55,
    breadthVelocity: 0,
    fiveMinuteConfirmed: false,
  });
  const shortDecision = signalDecision(
    [shortPrevious, shortCurrent],
    1,
    shortCandidate,
    shortContext,
    structural("RANGE"),
  );
  assertEquals(shortDecision.ok, true);
  assertEquals(shortDecision.targetHint, 99.7);
  assert(shortDecision.stopHint! > shortCurrent.close);
});

function bearSetup'''
s, n = re.subn(pattern, replacement, s, count=1, flags=re.S)
if n != 1:
    raise SystemExit(f'RANGE strategy test replacement expected 1 match, got {n}')
p.write_text(s)
print('RANGE V6 test fixtures aligned')
