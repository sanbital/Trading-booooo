from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEW_RELEASE = "7.3.8-M1-CORE-SCORE-OBS-TOLERANCE"


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def replace_once(path: str, old: str, new: str, marker: str | None = None) -> None:
    text = read(path)
    if old in text:
        if text.count(old) != 1:
            raise SystemExit(f"{path}: expected one match, found {text.count(old)}")
        write(path, text.replace(old, new))
        return
    if marker and marker in text:
        return
    raise SystemExit(f"{path}: source block missing: {old[:120]!r}")


# 1) Minute gate: four hard conditions, every other candle condition becomes a weighted score.
path = "supabase/functions/_shared/lob/minute-entry-gate.ts"
replace_once(
    path,
    'export const MINUTE_ENTRY_GATE_VERSION = "M1-BB-PREBREAKOUT-STOCH-14-3-3-V2";',
    'export const MINUTE_ENTRY_GATE_VERSION = "M1-BB-CORE4-AUX-SCORE-STOCH-14-3-3-V3";',
    "M1-BB-CORE4-AUX-SCORE-STOCH-14-3-3-V3",
)
replace_once(
    path,
    "  preBreakout: boolean;\n  bearishUpperBandReentry: boolean;",
    "  preBreakout: boolean;\n  corePassed: boolean;\n  upperBandTouched: boolean;\n  auxiliaryScore: number;\n  auxiliaryPassed: boolean;\n  auxiliarySignals: string[];\n  bearishUpperBandReentry: boolean;",
    "auxiliaryScore: number",
)
replace_once(
    path,
    "    preBreakout: false,\n    bearishUpperBandReentry: false,",
    "    preBreakout: false,\n    corePassed: false,\n    upperBandTouched: false,\n    auxiliaryScore: 0,\n    auxiliaryPassed: false,\n    auxiliarySignals: [],\n    bearishUpperBandReentry: false,",
    "auxiliarySignals: []",
)
old_logic = '''  const reasons: string[] = [];
  if (!previousBullish) reasons.push("M1_PREVIOUS_CANDLE_NOT_BULLISH");
  if (!(stoch.k > stoch.d)) reasons.push("M1_STOCH_K_NOT_ABOVE_D");
  if (stoch.previousK != null && stoch.k < stoch.previousK - 2) reasons.push("M1_STOCH_K_FADING");
  if (!squeezeRelease) reasons.push("M1_BB_SQUEEZE_NOT_RELEASING");
  if (!(bandPosition >= 0.78 && bandPosition <= 1.08)) reasons.push("M1_NOT_NEAR_UPPER_BAND");
  if (!(upperBandSlopePct > 0)) reasons.push("M1_UPPER_BAND_NOT_RISING");
  if (
    !(bodyAtrRatio >= 0.05 && bodyAtrRatio <= 0.75) || rangeAtrRatio > 1.20 || recentLargeBullish
  ) {
    reasons.push("M1_CANDLE_ALREADY_EXTENDED");
  }
  if (recentAdvanceAtr > 1.25) reasons.push("M1_RECENT_MOVE_ALREADY_EXTENDED");
  if (!(volumeRatio >= 1.05)) reasons.push("M1_VOLUME_NOT_EXPANDING");

  const preBreakout = reasons.length === 0;'''
new_logic = '''  // CORE4 is deliberately small and explicit. These are the only mandatory 1m gates:
  // 1) previous completed candle is bullish, 2) Stoch(14,3,3) K>D,
  // 3) that candle touched/closed above the upper band, 4) upper band slopes upward.
  const upperBandTouched = last.high >= currentBb.upper * 0.9995 || last.close >= currentBb.upper;
  const coreReasons: string[] = [];
  if (!previousBullish) coreReasons.push("M1_PREVIOUS_CANDLE_NOT_BULLISH");
  if (!(stoch.k > stoch.d)) coreReasons.push("M1_STOCH_K_NOT_ABOVE_D");
  if (!upperBandTouched) coreReasons.push("M1_UPPER_BAND_NOT_TOUCHED");
  if (!(upperBandSlopePct > 0)) coreReasons.push("M1_UPPER_BAND_NOT_RISING");
  const corePassed = coreReasons.length === 0;

  // Everything else is supporting evidence, not an independent veto. Positive structure
  // earns points; severe extension receives penalties so a completed expansion candle does
  // not pass merely because volume and band width are high.
  const auxiliarySignals: string[] = [];
  let rawAuxiliaryScore = 0;
  const add = (condition: boolean, points: number, label: string) => {
    if (!condition) return;
    rawAuxiliaryScore += points;
    auxiliarySignals.push(label);
  };
  add(squeezeRelease, 20, "SQUEEZE_RELEASE");
  add(bandWidthExpansionRatio >= 1.003, 10, "BAND_WIDTH_EXPANDING");
  add(stoch.previousK == null || stoch.k >= stoch.previousK - 2, 15, "STOCH_NOT_FADING");
  add(volumeRatio >= 0.90, 15, "VOLUME_SUPPORTED");
  add(bodyAtrRatio >= 0.03 && bodyAtrRatio <= 0.90, 15, "BODY_NOT_EXTENDED");
  add(rangeAtrRatio <= 1.50, 10, "RANGE_NOT_EXTENDED");
  add(recentAdvanceAtr <= 1.50, 10, "RECENT_ADVANCE_NOT_EXTENDED");
  add(bandPosition >= 0.85, 5, "CLOSE_NEAR_UPPER_BAND");

  if (bodyAtrRatio > 1.20 || recentLargeBullish) {
    rawAuxiliaryScore -= 25;
    auxiliarySignals.push("PENALTY_COMPLETED_EXPANSION_CANDLE");
  }
  if (rangeAtrRatio > 1.80) {
    rawAuxiliaryScore -= 15;
    auxiliarySignals.push("PENALTY_WIDE_RANGE");
  }
  if (recentAdvanceAtr > 2.00) {
    rawAuxiliaryScore -= 20;
    auxiliarySignals.push("PENALTY_LATE_ADVANCE");
  }

  const auxiliaryScore = Math.max(0, Math.min(100, rawAuxiliaryScore));
  const auxiliaryPassed = auxiliaryScore >= 40;
  const reasons = [...coreReasons];
  if (corePassed && !auxiliaryPassed) reasons.push("M1_AUXILIARY_SCORE_TOO_LOW");
  const preBreakout = corePassed && auxiliaryPassed;'''
replace_once(path, old_logic, new_logic, "M1_AUXILIARY_SCORE_TOO_LOW")
replace_once(
    path,
    "    preBreakout,\n    bearishUpperBandReentry,",
    "    preBreakout,\n    corePassed,\n    upperBandTouched,\n    auxiliaryScore,\n    auxiliaryPassed,\n    auxiliarySignals,\n    bearishUpperBandReentry,",
    "    auxiliaryScore,",
)

# 2) Gate tests: hard conditions and score behavior.
write(
    "supabase/functions/_shared/lob/minute-entry-gate.test.ts",
    '''import {
  evaluateMinuteEntryGate,
  MINUTE_ENTRY_GATE_VERSION,
  type MinuteCandle,
} from "./minute-entry-gate.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function candidate(now: number, step: number): MinuteCandle[] {
  const start = now - 50 * 60_000;
  return Array.from({ length: 44 }, (_, index) => {
    const quietAmplitude = index < 22 ? 0.08 : 0.004;
    const quiet = Math.sin(index * 1.7) * quietAmplitude;
    const launch = index >= 42 ? (index - 41) * step : 0;
    const close = 100 + quiet + launch;
    const open = close - (index >= 38 ? Math.max(0.004, step * 0.35) : 0.003);
    return {
      openTimeMs: start + index * 60_000,
      closeTimeMs: start + (index + 1) * 60_000 - 1,
      open,
      high: Math.max(open, close) + 0.035,
      low: Math.min(open, close) - 0.035,
      close,
      volume: index === 43 ? 180 : 100 + (index % 4) * 3,
    };
  });
}

Deno.test("CORE4 plus auxiliary score admits a pre-expansion upper-band touch", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  let accepted = null;
  for (const step of [0.006, 0.008, 0.01, 0.012, 0.015, 0.018, 0.02, 0.025]) {
    const result = evaluateMinuteEntryGate(candidate(now, step), now);
    if (result.passed) {
      accepted = result;
      break;
    }
  }
  assert(accepted, "no synthetic CORE4 setup passed");
  assert(accepted.version === MINUTE_ENTRY_GATE_VERSION);
  assert(accepted.corePassed && accepted.upperBandTouched);
  assert(accepted.auxiliaryPassed && accepted.auxiliaryScore >= 40);
});

Deno.test("the four primary conditions remain hard gates", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  const candles = candidate(now, 0.012);
  const last = candles.at(-1)!;
  last.open = last.close + 0.02;
  last.high = Math.max(last.high, last.open + 0.01);
  const result = evaluateMinuteEntryGate(candles, now);
  assert(!result.passed);
  assert(result.reasons.includes("M1_PREVIOUS_CANDLE_NOT_BULLISH"));
});

Deno.test("a completed expansion candle is rejected by the auxiliary score", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  const candles = candidate(now, 0.012);
  const last = candles.at(-1)!;
  last.open = last.close - 1.2;
  last.low = last.open - 0.05;
  last.high = last.close + 0.05;
  last.volume = 400;
  const result = evaluateMinuteEntryGate(candles, now);
  assert(!result.passed);
  assert(result.auxiliarySignals.includes("PENALTY_COMPLETED_EXPANSION_CANDLE"));
  assert(result.reasons.includes("M1_AUXILIARY_SCORE_TOO_LOW"));
});

Deno.test("forming candle is excluded and insufficient history fails closed", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  const candles = candidate(now, 0.012);
  candles.push({
    openTimeMs: now - 30_000,
    closeTimeMs: now + 30_000,
    open: 999,
    high: 1000,
    low: 800,
    close: 801,
    volume: 9999,
  });
  const result = evaluateMinuteEntryGate(candles, now);
  assert(result.latestClose !== 801, "forming candle leaked into the gate");
  const short = evaluateMinuteEntryGate(candles.slice(-10), now);
  assert(!short.passed && short.reasons.includes("M1_CANDLE_DATA_INSUFFICIENT"));
});
''',
)

# 3) Flow the new diagnostics through feature snapshots.
replace_once(
    "supabase/functions/_shared/lob/types.ts",
    "  m1PreBreakout?: boolean;\n  m1BearishUpperBandReentry?: boolean;",
    "  m1PreBreakout?: boolean;\n  m1CorePassed?: boolean;\n  m1UpperBandTouched?: boolean;\n  m1AuxiliaryScore?: number | null;\n  m1AuxiliaryPassed?: boolean;\n  m1BearishUpperBandReentry?: boolean;",
    "m1AuxiliaryScore?: number",
)
replace_once(
    "supabase/functions/market-scanner/engine.ts",
    "  m1_pre_breakout?: boolean;\n  m1_bearish_upper_band_reentry?: boolean;",
    "  m1_pre_breakout?: boolean;\n  m1_core_passed?: boolean;\n  m1_upper_band_touched?: boolean;\n  m1_auxiliary_score?: number | null;\n  m1_auxiliary_passed?: boolean;\n  m1_bearish_upper_band_reentry?: boolean;",
    "m1_auxiliary_score?: number",
)
replace_once(
    "supabase/functions/market-scanner/engine.ts",
    "      m1PreBreakout: period.universe.m1_pre_breakout === true,\n      m1BearishUpperBandReentry:",
    "      m1PreBreakout: period.universe.m1_pre_breakout === true,\n      m1CorePassed: period.universe.m1_core_passed === true,\n      m1UpperBandTouched: period.universe.m1_upper_band_touched === true,\n      m1AuxiliaryScore: period.universe.m1_auxiliary_score ?? null,\n      m1AuxiliaryPassed: period.universe.m1_auxiliary_passed === true,\n      m1BearishUpperBandReentry:",
    "m1AuxiliaryScore: period.universe.m1_auxiliary_score",
)
replace_once(
    "supabase/functions/market-scanner/index.ts",
    "      m1_pre_breakout: gate?.preBreakout === true,\n      m1_bearish_upper_band_reentry:",
    "      m1_pre_breakout: gate?.preBreakout === true,\n      m1_core_passed: gate?.corePassed === true,\n      m1_upper_band_touched: gate?.upperBandTouched === true,\n      m1_auxiliary_score: gate?.auxiliaryScore ?? null,\n      m1_auxiliary_passed: gate?.auxiliaryPassed === true,\n      m1_bearish_upper_band_reentry:",
    "m1_auxiliary_score: gate?.auxiliaryScore",
)
replace_once(
    "supabase/functions/market-autotrader/index.ts",
    "    m1PreBreakout: base.m1PreBreakout === true,\n    m1BearishUpperBandReentry:",
    "    m1PreBreakout: base.m1PreBreakout === true,\n    m1CorePassed: base.m1CorePassed === true,\n    m1UpperBandTouched: base.m1UpperBandTouched === true,\n    m1AuxiliaryScore: base.m1AuxiliaryScore ?? null,\n    m1AuxiliaryPassed: base.m1AuxiliaryPassed === true,\n    m1BearishUpperBandReentry:",
    "m1AuxiliaryScore: base.m1AuxiliaryScore",
)

# 4) Keep the socket open for 15 seconds, but accept a 13.5s boundary window only when
# it already contains meaningful book and trade samples.
entry_path = "supabase/functions/_shared/lob/entry.ts"
replace_once(
    entry_path,
    "const ECONOMIC_GATE_EPSILON = 1e-9;",
    "const ECONOMIC_GATE_EPSILON = 1e-9;\nexport const EFFECTIVE_OBSERVATION_MIN_MS = 13_500;\nconst EFFECTIVE_OBSERVATION_MIN_SAMPLES = 20;\nconst EFFECTIVE_OBSERVATION_MIN_TRADES = 20;\nconst EFFECTIVE_OBSERVATION_MIN_QUALITY = 0.45;",
    "EFFECTIVE_OBSERVATION_MIN_MS = 13_500",
)
replace_once(
    entry_path,
    "export type LobEntryRiskAssessment = {",
    '''export function hasEffectiveLobObservation(features: LobFeatureVector): boolean {
  const observationMs = Math.max(0, finite(features.observationMs));
  if (observationMs >= 15_000) return true;
  return observationMs >= EFFECTIVE_OBSERVATION_MIN_MS &&
    Math.max(0, finite(features.samples)) >= EFFECTIVE_OBSERVATION_MIN_SAMPLES &&
    Math.max(0, finite(features.tradeCount)) >= EFFECTIVE_OBSERVATION_MIN_TRADES &&
    clamp(finite(features.dataQuality), 0, 1) >= EFFECTIVE_OBSERVATION_MIN_QUALITY;
}

export type LobEntryRiskAssessment = {''',
    "export function hasEffectiveLobObservation",
)
replace_once(
    entry_path,
    '''  const dynamicInsufficient = status.includes("INSUFFICIENT") ||
    clamp(finite(features.dataQuality), 0, 1) < trapCfg.minDataQuality;''',
    '''  const effectiveObservation = hasEffectiveLobObservation(features);
  const dynamicInsufficient = (!effectiveObservation && status.includes("INSUFFICIENT")) ||
    clamp(finite(features.dataQuality), 0, 1) < trapCfg.minDataQuality;''',
    "const effectiveObservation = hasEffectiveLobObservation(features);",
)
replace_once(
    entry_path,
    '  if (features.observationMs < 15_000) reasons.push("INSUFFICIENT_15S_OBSERVATION");',
    '  if (!hasEffectiveLobObservation(features)) reasons.push("INSUFFICIENT_EFFECTIVE_OBSERVATION");',
    "INSUFFICIENT_EFFECTIVE_OBSERVATION",
)

# Dynamic status uses the same 13.5-second boundary tolerance; requested socket duration stays 15s.
replace_once(
    "supabase/functions/market-scanner/engine.ts",
    "const DYNAMIC_MIN_OBSERVATION_MS = 15_000;",
    "const DYNAMIC_MIN_OBSERVATION_MS = 13_500;",
    "const DYNAMIC_MIN_OBSERVATION_MS = 13_500;",
)

# 5) Observation tests.
entry_test = read("supabase/functions/_shared/lob/entry-risk.test.ts")
entry_test = entry_test.replace(
    'import { assessLobEntryRisk } from "./entry.ts";',
    'import { assessLobEntryRisk, hasEffectiveLobObservation } from "./entry.ts";',
)
if "13.5s boundary tolerance" not in entry_test:
    entry_test += '''

Deno.test("13.5s boundary tolerance requires substantial live samples", () => {
  assert(hasEffectiveLobObservation(features({
    observationMs: 14_976,
    samples: 53,
    tradeCount: 81,
    dataQuality: 0.78,
  })));
  assert(!hasEffectiveLobObservation(features({
    observationMs: 13_267,
    samples: 53,
    tradeCount: 81,
    dataQuality: 0.78,
  })));
  assert(!hasEffectiveLobObservation(features({
    observationMs: 14_500,
    samples: 8,
    tradeCount: 5,
    dataQuality: 0.8,
  })));
});
'''
write("supabase/functions/_shared/lob/entry-risk.test.ts", entry_test)

# 6) Revision bump for deployment/runtime parity.
for release_path in [
    "supabase/functions/market-scanner/engine.ts",
    "supabase/functions/market-autotrader/index.ts",
]:
    text = read(release_path)
    text = text.replace("7.3.7-15S-TOP10-COMPOSITE-PRESSURE", NEW_RELEASE)
    write(release_path, text)

migration = f'''-- {NEW_RELEASE}
-- Core 1m admission: bullish completed candle, Stoch(14,3,3) K>D, upper-band touch,
-- and rising upper band. Other candle attributes are weighted supporting evidence.
-- The scanner still observes for 15 seconds; 13.5-15.0 seconds is accepted only with
-- substantial synchronized book/trade samples.

update public.trading_settings
set lob_observation_window_ms = 15000,
    lob_max_gainer_rank = 10,
    lob_live_admission_revision = '{NEW_RELEASE}',
    lob_model_revision = '{NEW_RELEASE}',
    updated_at = now()
where id = 1;
'''
write("supabase/migrations/20260802164500_m1_core_score_observation_tolerance.sql", migration)

# Final source assertions.
checks = {
    "supabase/functions/_shared/lob/minute-entry-gate.ts": [
        "M1-BB-CORE4-AUX-SCORE-STOCH-14-3-3-V3",
        "M1_UPPER_BAND_NOT_TOUCHED",
        "M1_AUXILIARY_SCORE_TOO_LOW",
        "auxiliaryScore >= 40",
    ],
    "supabase/functions/_shared/lob/entry.ts": [
        "EFFECTIVE_OBSERVATION_MIN_MS = 13_500",
        "INSUFFICIENT_EFFECTIVE_OBSERVATION",
        "hasEffectiveLobObservation",
    ],
    "supabase/functions/market-scanner/engine.ts": [
        NEW_RELEASE,
        "const DYNAMIC_MIN_OBSERVATION_MS = 13_500;",
    ],
    "supabase/functions/market-autotrader/index.ts": [NEW_RELEASE],
}
for checked_path, markers in checks.items():
    body = read(checked_path)
    for marker in markers:
        if marker not in body:
            raise SystemExit(f"{checked_path}: missing marker {marker}")

print(f"{NEW_RELEASE} patch applied")
