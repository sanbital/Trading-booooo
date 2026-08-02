from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_required(path: str, old: str, new: str, marker: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if old in text:
        if text.count(old) != 1:
            raise SystemExit(f"{path}: expected one source block, found {text.count(old)}")
        target.write_text(text.replace(old, new))
        return
    if marker in text:
        return
    raise SystemExit(f"{path}: source block missing and marker {marker!r} absent")


replace_required(
    "supabase/functions/_shared/lob/types.ts",
    '''  /** Bounded additive edge from perp positioning. Never a veto. */
  fundingEdge: number;
}''',
    '''  /** Bounded additive edge from perp positioning. Never a veto. */
  fundingEdge: number;
  /** Mandatory completed 1m candle + Stoch(14,3,3) entry confirmation. */
  m1GateVersion?: string;
  m1DataAvailable?: boolean;
  m1PreviousBullish?: boolean | null;
  m1StochK?: number | null;
  m1StochD?: number | null;
  m1CompletedBars?: number;
  m1CompletedCandleOpenTime?: string | null;
  m1CompletedCandleCloseTime?: string | null;
}''',
    "m1GateVersion",
)
replace_required(
    "supabase/functions/_shared/lob/types.ts",
    '''  blockedPatterns?: string[];
  minSamples: number;''',
    '''  blockedPatterns?: string[];
  /** Require the completed 1m bullish candle and Stoch(14,3,3) %K > %D gate. */
  requireMinuteEntryGate?: boolean;
  minSamples: number;''',
    "requireMinuteEntryGate",
)

replace_required(
    "supabase/functions/_shared/lob/entry.ts",
    '''import { scoreHotSymbol } from "./hot-symbol.ts";''',
    '''import { scoreHotSymbol } from "./hot-symbol.ts";
import { MINUTE_ENTRY_GATE_VERSION } from "./minute-entry-gate.ts";''',
    "MINUTE_ENTRY_GATE_VERSION",
)
replace_required(
    "supabase/functions/_shared/lob/entry.ts",
    '''  // Structural and execution checks only.
  const maxGainerRank = clamp(''',
    '''  // Operator-added 1m entry gate. It is opt-in at the shared-library level so legacy
  // research fixtures remain valid, but both production admission stages set it to true.
  if (cfg.requireMinuteEntryGate === true) {
    const k = Number(features.m1StochK);
    const d = Number(features.m1StochD);
    if (
      features.m1GateVersion !== MINUTE_ENTRY_GATE_VERSION ||
      features.m1DataAvailable !== true
    ) {
      reasons.push("M1_CANDLE_DATA_UNAVAILABLE");
    } else if (
      Math.max(0, Math.floor(Number(features.m1CompletedBars) || 0)) < 18 ||
      !Number.isFinite(k) || !Number.isFinite(d)
    ) {
      reasons.push("M1_CANDLE_DATA_INSUFFICIENT");
    } else {
      if (features.m1PreviousBullish !== true) {
        reasons.push("M1_PREVIOUS_CANDLE_NOT_BULLISH");
      }
      if (!(k > d)) reasons.push("M1_STOCH_K_NOT_ABOVE_D");
    }
  }

  // Structural and execution checks only.
  const maxGainerRank = clamp(''',
    "M1_PREVIOUS_CANDLE_NOT_BULLISH",
)

replace_required(
    "supabase/functions/market-scanner/engine.ts",
    '''  funding_edge?: number;
  recent_notional_per_second?: number;''',
    '''  funding_edge?: number;
  m1_gate_version?: string;
  m1_data_available?: boolean;
  m1_previous_bullish?: boolean | null;
  m1_stoch_k?: number | null;
  m1_stoch_d?: number | null;
  m1_completed_bars?: number;
  m1_completed_candle_open_time?: string | null;
  m1_completed_candle_close_time?: string | null;
  recent_notional_per_second?: number;''',
    "m1_gate_version",
)
replace_required(
    "supabase/functions/market-scanner/engine.ts",
    '''      fundingPremiumBps: finiteOr(period.universe.funding_premium_bps, 0),
      fundingAttention: finiteOr(period.universe.funding_attention, 0),
      fundingEdge: finiteOr(period.universe.funding_edge, 0),
    };''',
    '''      fundingPremiumBps: finiteOr(period.universe.funding_premium_bps, 0),
      fundingAttention: finiteOr(period.universe.funding_attention, 0),
      fundingEdge: finiteOr(period.universe.funding_edge, 0),
      m1GateVersion: period.universe.m1_gate_version,
      m1DataAvailable: period.universe.m1_data_available === true,
      m1PreviousBullish: period.universe.m1_previous_bullish ?? null,
      m1StochK: period.universe.m1_stoch_k ?? null,
      m1StochD: period.universe.m1_stoch_d ?? null,
      m1CompletedBars: Math.max(0, Math.floor(finiteOr(period.universe.m1_completed_bars, 0))),
      m1CompletedCandleOpenTime: period.universe.m1_completed_candle_open_time ?? null,
      m1CompletedCandleCloseTime: period.universe.m1_completed_candle_close_time ?? null,
    };''',
    "m1GateVersion: period.universe.m1_gate_version",
)
replace_required(
    "supabase/functions/market-scanner/engine.ts",
    '''        }, { maxSpreadBps: risk.maxSpreadBps ?? 30 }),
        maxHoldingSeconds: Math.round(''',
    '''        }, { maxSpreadBps: risk.maxSpreadBps ?? 30 }),
        requireMinuteEntryGate: true,
        maxHoldingSeconds: Math.round(''',
    "requireMinuteEntryGate: true",
)

replace_required(
    "supabase/functions/market-scanner/index.ts",
    '''} from "../_shared/lob/market-heat.ts";''',
    '''} from "../_shared/lob/market-heat.ts";
import { loadMinuteEntryGates } from "../_shared/lob/minute-entry-market.ts";''',
    "loadMinuteEntryGates",
)
replace_required(
    "supabase/functions/market-scanner/index.ts",
    '''  const selectedRows = heatRanked;
  const finalists = selectedRows.map(heatPeriod);''',
    '''  const selectedRows = heatRanked;
  const minuteEntryGates = await loadMinuteEntryGates(
    exchange,
    selectedRows.map((row) => row.market),
  );
  const candleGatedRows = selectedRows.map((row) => {
    const gate = minuteEntryGates.get(row.market);
    return {
      ...row,
      m1_gate_version: gate?.version,
      m1_data_available: gate?.dataAvailable === true,
      m1_previous_bullish: gate?.previousBullish ?? null,
      m1_stoch_k: gate?.stochK ?? null,
      m1_stoch_d: gate?.stochD ?? null,
      m1_completed_bars: gate?.completedBars ?? 0,
      m1_completed_candle_open_time: gate?.completedCandleOpenTime ?? null,
      m1_completed_candle_close_time: gate?.completedCandleCloseTime ?? null,
    };
  });
  const finalists = candleGatedRows.map(heatPeriod);''',
    "const minuteEntryGates = await loadMinuteEntryGates",
)
replace_required(
    "supabase/functions/market-scanner/index.ts",
    '''      hard_economic_gate: "TARGET_NET_PROFIT_GT_0",
      search_policy: "STRICT_TOP10_NO_BACKFILL",''',
    '''      hard_economic_gate: "TARGET_NET_PROFIT_GT_0",
      m1_entry_gate: "PREVIOUS_CANDLE_BULLISH_AND_STOCH_14_3_3_K_GT_D",
      search_policy: "STRICT_TOP10_NO_BACKFILL",''',
    "PREVIOUS_CANDLE_BULLISH_AND_STOCH_14_3_3_K_GT_D",
)

replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''import { buildLobGateConfig } from "../_shared/lob/gate-config.ts";''',
    '''import { buildLobGateConfig } from "../_shared/lob/gate-config.ts";
import { loadMinuteEntryGate } from "../_shared/lob/minute-entry-market.ts";''',
    "loadMinuteEntryGate",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
  };''',
    '''    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
    m1GateVersion: base.m1GateVersion,
    m1DataAvailable: base.m1DataAvailable === true,
    m1PreviousBullish: base.m1PreviousBullish ?? null,
    m1StochK: base.m1StochK ?? null,
    m1StochD: base.m1StochD ?? null,
    m1CompletedBars: Math.max(0, Math.floor(finite(base.m1CompletedBars, 0))),
    m1CompletedCandleOpenTime: base.m1CompletedCandleOpenTime ?? null,
    m1CompletedCandleCloseTime: base.m1CompletedCandleCloseTime ?? null,
  };''',
    "m1GateVersion: base.m1GateVersion",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''    minNetRewardRiskRatio: number;
    trap?: Partial<LobTrapConfig>;''',
    '''    minNetRewardRiskRatio: number;
    requireMinuteEntryGate: boolean;
    trap?: Partial<LobTrapConfig>;''',
    "requireMinuteEntryGate: boolean",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''    minNetRewardRiskRatio: options.minNetRewardRiskRatio,
    trap: options.trap || {},''',
    '''    minNetRewardRiskRatio: options.minNetRewardRiskRatio,
    requireMinuteEntryGate: options.requireMinuteEntryGate,
    trap: options.trap || {},''',
    "requireMinuteEntryGate: options.requireMinuteEntryGate",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''      }, { maxSpreadBps: LIVE_MAX_SPREAD_BPS }),
      maxHoldingSeconds: Math.round(''',
    '''      }, { maxSpreadBps: LIVE_MAX_SPREAD_BPS }),
      requireMinuteEntryGate: true,
      maxHoldingSeconds: Math.round(''',
    "requireMinuteEntryGate: true",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''      minNetRewardRiskRatio: lobExecutionGate.minNetRewardRiskRatio,
    };''',
    '''      minNetRewardRiskRatio: lobExecutionGate.minNetRewardRiskRatio,
      requireMinuteEntryGate: true,
    };''',
    "requireMinuteEntryGate: true,\n    };",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''    const finalPreOrderMarket = await marketQuote(exchange, candidate.market);
    secondLobPreOrderRecheck = evaluateLobPreOrderRecheck(''',
    '''    const [finalPreOrderMarket, finalMinuteEntryGate] = await Promise.all([
      marketQuote(exchange, candidate.market),
      loadMinuteEntryGate(exchange, candidate.market),
    ]);
    secondLobPreOrderRecheck = evaluateLobPreOrderRecheck(''',
    "finalMinuteEntryGate",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''    const finalAudit = {
      checked_at: secondLobPreOrderRecheck.checkedAt,
      passed: secondLobPreOrderRecheck.passed,
      reasons: secondLobPreOrderRecheck.reasons,''',
    '''    const finalReasons = [...new Set([
      ...secondLobPreOrderRecheck.reasons,
      ...finalMinuteEntryGate.reasons,
    ])];
    const finalPassed = secondLobPreOrderRecheck.passed && finalMinuteEntryGate.passed;
    const finalAudit = {
      checked_at: secondLobPreOrderRecheck.checkedAt,
      passed: finalPassed,
      reasons: finalReasons,
      minute_entry_gate: finalMinuteEntryGate,''',
    "minute_entry_gate: finalMinuteEntryGate",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''    if (!secondLobPreOrderRecheck.passed) {''',
    '''    if (!finalPassed) {''',
    "if (!finalPassed)",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''        reason: `LOB final pre-order check: ${secondLobPreOrderRecheck.reasons.join(",")}`,''',
    '''        reason: `LOB final pre-order check: ${finalReasons.join(",")}`,''',
    "finalReasons.join",
)
replace_required(
    "supabase/functions/market-autotrader/index.ts",
    '''/** Re-run the same LOB-only gate on a fresh gateway quote; no EV or candle input exists here. */''',
    '''/** Re-run the LOB gate on a fresh quote; the immutable scan-time 1m gate is carried here,
 * and a second fresh 1m fetch is enforced immediately before the order. */''',
    "second fresh 1m fetch",
)

for path, required in {
    "supabase/functions/_shared/lob/types.ts": "requireMinuteEntryGate",
    "supabase/functions/_shared/lob/entry.ts": "M1_STOCH_K_NOT_ABOVE_D",
    "supabase/functions/market-scanner/index.ts": "const minuteEntryGates = await loadMinuteEntryGates",
    "supabase/functions/market-scanner/engine.ts": "m1GateVersion: period.universe.m1_gate_version",
    "supabase/functions/market-autotrader/index.ts": "minute_entry_gate: finalMinuteEntryGate",
}.items():
    if required not in (ROOT / path).read_text():
        raise SystemExit(f"{path}: required marker {required!r} missing")

print("M1 candle + Stoch(14,3,3) production entry gates applied")
