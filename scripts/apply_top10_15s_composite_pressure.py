from __future__ import annotations

from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[1]
VERSION = "7.3.7-15S-TOP10-COMPOSITE-PRESSURE"


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str, marker: str | None = None) -> None:
    text = read(path)
    if old in text:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"{path}: expected one source block, found {count}")
        write(path, text.replace(old, new))
        return
    if marker and marker in text:
        return
    raise SystemExit(f"{path}: source block missing: {old[:160]!r}")


ENTRY = "supabase/functions/_shared/lob/entry.ts"
ENGINE = "supabase/functions/market-scanner/engine.ts"
SCANNER = "supabase/functions/market-scanner/index.ts"
AUTOTRADER = "supabase/functions/market-autotrader/index.ts"
GATE_CONFIG = "supabase/functions/_shared/lob/gate-config.ts"

replace_once(
    ENTRY,
    "const DEFAULT_MAX_GAINER_RANK = 3;",
    "const DEFAULT_MAX_GAINER_RANK = 10;",
    "const DEFAULT_MAX_GAINER_RANK = 10;",
)
replace_once(
    GATE_CONFIG,
    "export const LOB_DEFAULT_MAX_GAINER_RANK = 3;",
    "export const LOB_DEFAULT_MAX_GAINER_RANK = 10;",
    "export const LOB_DEFAULT_MAX_GAINER_RANK = 10;",
)

old_pressure = dedent('''
  // Entry is armed by the completed pre-breakout candle, but executed only when real buys
  // are accelerating now. Resting depth alone never counts as pressure.
  const pressureConfirmations = [
    ofi >= 0.45,
    micropriceBps >= 0,
    imbalance >= 0,
    finite(features.depthRatio) >= 0.90,
    finite(features.tradeSpeedTrend) >= -0.05,
  ].filter(Boolean).length;
  if (pressure < 0.10) reasons.push("BUY_PRESSURE_TOO_WEAK");
  if (buySellRatio < 1.25) reasons.push("AGGRESSIVE_BUY_NOTIONAL_TOO_WEAK");
  if (!(acceleration > 0)) reasons.push("BUY_FLOW_NOT_ACCELERATING");
  if (pressureConfirmations < 3) reasons.push("BUY_PRESSURE_NOT_CONFIRMED");
  if (!(Math.max(0, finite(features.tradeArrivalRate)) > 0)) reasons.push("NO_LIVE_BUY_TAPE");
''')
new_pressure = dedent('''
  // COMPOSITE-PRESSURE-V1: acceleration is one vote, never a standalone mandatory gate.
  // A live tape-side confirmation must combine with current book/price evidence. This keeps
  // resting depth from authorizing a BUY while allowing valid pressure that is already strong
  // but whose short-window acceleration happens to be flat at the sampling boundary.
  const liveTape = Math.max(0, finite(features.tradeArrivalRate)) > 0;
  const tapePressureVotes = [
    pressure >= 0.10,
    buySellRatio >= 1.15,
    acceleration > 0,
  ].filter(Boolean).length;
  const bookPressureVotes = [
    ofi >= 0.45,
    micropriceBps >= 0,
    imbalance >= 0,
    finite(features.depthRatio) >= 0.90,
    finite(features.tradeSpeedTrend) >= -0.05,
  ].filter(Boolean).length;
  const pressureConfirmations = tapePressureVotes + bookPressureVotes + (liveTape ? 1 : 0);

  if (!liveTape) reasons.push("NO_LIVE_BUY_TAPE");
  if (pressure < 0 && buySellRatio < 1) reasons.push("SELL_PRESSURE_DOMINANT");
  if (tapePressureVotes < 1 || pressureConfirmations < 5) {
    reasons.push("BUY_PRESSURE_NOT_CONFIRMED");
  }
  if (pressure < 0.10) warnings.push("BUY_PRESSURE_BELOW_PRIMARY_THRESHOLD");
  if (buySellRatio < 1.15) warnings.push("AGGRESSIVE_BUY_NOTIONAL_BELOW_PRIMARY_THRESHOLD");
  if (!(acceleration > 0)) warnings.push("BUY_FLOW_NOT_ACCELERATING_OPTIONAL_VOTE");
''')
replace_once(ENTRY, old_pressure, new_pressure, "COMPOSITE-PRESSURE-V1")

replace_once(
    ENGINE,
    'export const ENGINE_VERSION = "7.3.5-APPROVAL-SURVIVES-REQUOTE";',
    f'export const ENGINE_VERSION = "{VERSION}";',
    VERSION,
)
replace_once(
    AUTOTRADER,
    'const VERSION = "7.3.5-APPROVAL-SURVIVES-REQUOTE";',
    f'const VERSION = "{VERSION}";',
    VERSION,
)
replace_once(
    ENGINE,
    dedent('''
const DYNAMIC_MIN_OBSERVATION_MS = 45_000;
const DYNAMIC_MIN_BOOK_UPDATES = 25;
const DYNAMIC_MIN_TRADES = 20;
'''),
    dedent('''
// The scanner now makes one synchronized 15-second decision. Sample floors are scaled to
// that window; three-phase consistency remains mandatory, so shorter never means one-tick.
const DYNAMIC_MIN_OBSERVATION_MS = 15_000;
const DYNAMIC_MIN_BOOK_UPDATES = 12;
const DYNAMIC_MIN_TRADES = 8;
'''),
    "const DYNAMIC_MIN_OBSERVATION_MS = 15_000;",
)
replace_once(
    ENGINE,
    "Math.min(1, observationMs / 60_000) * 0.3 +",
    "Math.min(1, observationMs / DYNAMIC_MIN_OBSERVATION_MS) * 0.3 +",
    "observationMs / DYNAMIC_MIN_OBSERVATION_MS",
)

old_scanner_constants = dedent('''
const DEFAULT_DYNAMIC_OBSERVATION_MS = 15_000;
const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 20_000;
const MIN_DYNAMIC_OBSERVATION_MS = 12_000;
const MAX_DYNAMIC_OBSERVATION_MS = 25_000;
const REQUIRED_PER_MARKET_OBSERVATION_MS = 15_000;
const EXTENDED_PER_MARKET_OBSERVATION_MS = 25_000;
const DYNAMIC_STREAM_HARD_TIMEOUT_BUFFER_MS = 20_000;
''')
new_scanner_constants = dedent('''
const DEFAULT_DYNAMIC_OBSERVATION_MS = 15_000;
const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 15_000;
const MIN_DYNAMIC_OBSERVATION_MS = 15_000;
const MAX_DYNAMIC_OBSERVATION_MS = 15_000;
const REQUIRED_PER_MARKET_OBSERVATION_MS = 15_000;
const EXTENDED_PER_MARKET_OBSERVATION_MS = 15_000;
const DYNAMIC_STREAM_HARD_TIMEOUT_BUFFER_MS = 5_000;
''')
replace_once(SCANNER, old_scanner_constants, new_scanner_constants, "MAX_DYNAMIC_OBSERVATION_MS = 15_000")

old_refresh = dedent('''
    if (state.complete || state.observedForMs < REQUIRED_PER_MARKET_OBSERVATION_MS) continue;
    if (state.observedForMs >= EXTENDED_PER_MARKET_OBSERVATION_MS) {
      state.complete = true;
      state.extendedForInsufficient = true;
      continue;
    }
    if (!snapshots || !trades) continue;
    if (
      state.lastSufficiencyCheckAt != null &&
      now - state.lastSufficiencyCheckAt < DYNAMIC_SUFFICIENCY_RECHECK_MS
    ) continue;
    state.lastSufficiencyCheckAt = now;
    const dynamic = computeDynamicOrderflow(
      snapshots.get(market) || [],
      trades.get(market) || [],
      Number.EPSILON,
    );
    // Entry requires 50 seconds even though the lower-level feature calculator can be
    // reused by legacy callers with a 45-second window.
    state.complete = dynamic.sufficient && dynamic.observation_ms >= 50_000;
    state.extendedForInsufficient = !state.complete;
''')
new_refresh = dedent('''
    if (state.complete || state.observedForMs < REQUIRED_PER_MARKET_OBSERVATION_MS) continue;
    const reachedDeadline = state.observedForMs >= EXTENDED_PER_MARKET_OBSERVATION_MS;
    if (!snapshots || !trades) {
      if (reachedDeadline) {
        state.complete = true;
        state.extendedForInsufficient = true;
      }
      continue;
    }
    if (
      !reachedDeadline && state.lastSufficiencyCheckAt != null &&
      now - state.lastSufficiencyCheckAt < DYNAMIC_SUFFICIENCY_RECHECK_MS
    ) continue;
    state.lastSufficiencyCheckAt = now;
    const dynamic = computeDynamicOrderflow(
      snapshots.get(market) || [],
      trades.get(market) || [],
      Number.EPSILON,
    );
    state.complete = dynamic.sufficient &&
      dynamic.observation_ms >= REQUIRED_PER_MARKET_OBSERVATION_MS;
    state.extendedForInsufficient = false;
    if (!state.complete && reachedDeadline) {
      state.complete = true;
      state.extendedForInsufficient = true;
    }
''')
replace_once(SCANNER, old_refresh, new_refresh, "const reachedDeadline = state.observedForMs")

replace_once(
    SCANNER,
    "// Entry requires 50 seconds even though the lower-level feature calculator can be\n",
    "// Entry confirmation is synchronized to the canonical 15-second window.\n",
    "const reachedDeadline = state.observedForMs",
)

TEST = dedent('''
import { assessLobEntryRisk } from "./entry.ts";
import type { LobFeatureVector } from "./types.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function features(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    dynamicStatus: "NEUTRAL",
    dataQuality: 0.8,
    tradePressureFast: 0.22,
    micropriceDeviationBps: 0.8,
    bookImbalance: 0.15,
    ofiPersistence: 0.55,
    spoofLikeScore: 0,
    askSpoofScore: 0,
    buyNotional: 120,
    sellNotional: 100,
    notionalAcceleration: 0,
    tradeSpeedTrend: 0,
    notionalTrend: 0,
    depthRatio: 1.05,
    tradeArrivalRate: 1,
    ...overrides,
  } as LobFeatureVector;
}

Deno.test("flat notional acceleration can pass with composite live pressure", () => {
  const result = assessLobEntryRisk(features());
  assert(!result.reasons.includes("BUY_FLOW_NOT_ACCELERATING"));
  assert(!result.reasons.includes("BUY_PRESSURE_NOT_CONFIRMED"));
  assert(result.warnings.includes("BUY_FLOW_NOT_ACCELERATING_OPTIONAL_VOTE"));
  assert(result.positiveVotes >= 5);
});

Deno.test("acceleration alone cannot authorize an entry", () => {
  const result = assessLobEntryRisk(features({
    tradePressureFast: -0.2,
    buyNotional: 80,
    sellNotional: 120,
    notionalAcceleration: 1,
    micropriceDeviationBps: -1,
    bookImbalance: -0.2,
    ofiPersistence: 0.1,
    depthRatio: 0.4,
    tradeSpeedTrend: -0.3,
  }));
  assert(result.reasons.includes("BUY_PRESSURE_NOT_CONFIRMED"));
  assert(result.reasons.includes("SELL_PRESSURE_DOMINANT"));
});

Deno.test("no live tape remains a hard rejection", () => {
  const result = assessLobEntryRisk(features({ tradeArrivalRate: 0 }));
  assert(result.reasons.includes("NO_LIVE_BUY_TAPE"));
});
''').lstrip()
write("supabase/functions/_shared/lob/entry-risk.test.ts", TEST)

MIGRATION = dedent(f'''
-- Canonical 15-second Top-10 composite-pressure admission policy.
-- Entry pause is preserved by the deployment workflow and restored after verification.
begin;
update public.trading_settings
set
  lob_observation_window_ms = 15000,
  lob_max_gainer_rank = 10,
  lob_live_admission_revision = '{VERSION}',
  lob_model_revision = '{VERSION}',
  updated_at = now()
where id = 1;
commit;
''').lstrip()
write("supabase/migrations/20260802160600_top10_15s_composite_pressure.sql", MIGRATION)

print(f"{VERSION} source patch applied")
