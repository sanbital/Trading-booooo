from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


SPOT_POLICY = '''export const SPOT_SPLIT_EXIT_THRESHOLDS = {
  firstTakeProfitPct: 5,
  firstStopLossPct: -4,
  residualProfitFloorPct: 3,
  residualTrailingDrawdownPct: 1.5,
  firstTakeProfitFraction: 0.5,
  hardStopFraction: 1,
} as const;

export type SpotSplitExitInput = {
  residualStage: boolean;
  grossReturnPct: number;
  peakGrossReturnPct: number;
  residualNetReturnPct: number;
  safetyRequested?: boolean;
};

export type SpotSplitExitDecision = {
  action: "STOP" | "NONE";
  fraction: number;
  reason: string;
  residualProtectPct?: number;
};

/**
 * Canonical spot policy:
 * - hard stop: -4%, close 100%
 * - first take-profit: +5%, close 50%
 * - residual: protect at max(+3%, peak - 1.5 percentage points)
 */
export function spotSplitExitDecision(input: SpotSplitExitInput): SpotSplitExitDecision {
  const t = SPOT_SPLIT_EXIT_THRESHOLDS;
  if (input.residualStage) {
    const peakGrossReturnPct = Math.max(input.grossReturnPct, input.peakGrossReturnPct);
    const residualProtectPct = Math.max(
      t.residualProfitFloorPct,
      peakGrossReturnPct - t.residualTrailingDrawdownPct,
    );
    if (input.grossReturnPct <= residualProtectPct) {
      return {
        action: "STOP",
        fraction: 1,
        reason: "RESIDUAL_PROTECTED_TRAIL_EXIT",
        residualProtectPct,
      };
    }
    return {
      action: "NONE",
      fraction: 0,
      reason: "RESIDUAL_PROTECTED_TRAIL_ACTIVE",
      residualProtectPct,
    };
  }
  if (input.grossReturnPct >= t.firstTakeProfitPct) {
    return {
      action: "STOP",
      fraction: t.firstTakeProfitFraction,
      reason: "HALF_HOLD_TAKE_PROFIT_5",
    };
  }
  if (input.grossReturnPct <= t.firstStopLossPct) {
    return {
      action: "STOP",
      fraction: t.hardStopFraction,
      reason: "HALF_HOLD_STOP_LOSS_4",
    };
  }
  return {
    action: "NONE",
    fraction: 0,
    reason: input.safetyRequested
      ? "HALF_HOLD_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
      : "HALF_HOLD_AWAITING_TP5_OR_SL4",
  };
}
'''

SPOT_TEST = '''import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { spotSplitExitDecision } from "./spot-exit-policy.ts";

function decide(overrides: Partial<Parameters<typeof spotSplitExitDecision>[0]> = {}) {
  return spotSplitExitDecision({
    residualStage: false,
    grossReturnPct: 0,
    peakGrossReturnPct: 0,
    residualNetReturnPct: 0,
    safetyRequested: false,
    ...overrides,
  });
}

Deno.test("spot first tranche sells 50% at +5%", () => {
  assertEquals(decide({ grossReturnPct: 5 }).fraction, 0.5);
  assertEquals(decide({ grossReturnPct: 5 }).reason, "HALF_HOLD_TAKE_PROFIT_5");
});

Deno.test("spot hard stop closes 100% at -4%", () => {
  assertEquals(decide({ grossReturnPct: -4 }).fraction, 1);
  assertEquals(decide({ grossReturnPct: -4 }).reason, "HALF_HOLD_STOP_LOSS_4");
});

Deno.test("spot residual at a +5% peak protects at +3.5%", () => {
  const hold = decide({ residualStage: true, grossReturnPct: 3.6, peakGrossReturnPct: 5 });
  assertEquals(hold.action, "NONE");
  assertEquals(hold.residualProtectPct, 3.5);
  const exit = decide({ residualStage: true, grossReturnPct: 3.5, peakGrossReturnPct: 5 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.fraction, 1);
});

Deno.test("spot residual follows peak minus 1.5 percentage points", () => {
  const exit = decide({ residualStage: true, grossReturnPct: 6.5, peakGrossReturnPct: 8 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.reason, "RESIDUAL_PROTECTED_TRAIL_EXIT");
  assertEquals(exit.residualProtectPct, 6.5);
});

Deno.test("spot residual floor never goes below +3%", () => {
  const exit = decide({ residualStage: true, grossReturnPct: 3, peakGrossReturnPct: 4 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.residualProtectPct, 3);
});
'''

write("supabase/functions/market-autotrader/spot-exit-policy.ts", SPOT_POLICY)
write("supabase/functions/market-autotrader/spot-exit-policy.test.ts", SPOT_TEST)
write("supabase/functions/market-autotrader/split-stop-policy.test.ts", SPOT_TEST)

# Futures policy: retain leverage/minimum helpers, replace only the exit contract.
futures_path = "supabase/functions/market-autotrader/futures-exit-policy.ts"
futures = read(futures_path)
start = futures.index("export const FUTURES_SPLIT_EXIT_THRESHOLDS = {")
end = futures.index("} as const;", start) + len("} as const;")
futures = futures[:start] + '''export const FUTURES_SPLIT_EXIT_THRESHOLDS = {
  /** Half take-profit, measured on margin (ROE). */
  firstTakeProfitRoePct: 15,
  /** Hard stop, measured on margin (ROE). */
  firstStopLossRoePct: -12,
  /** Residual minimum protected ROE after the first +15% take-profit. */
  residualProfitFloorRoePct: 9,
  /** Residual trailing drawdown from peak ROE. */
  residualTrailingDrawdownRoePct: 4.5,
  /** Fraction closed at the first take-profit. */
  firstTakeProfitFraction: 0.5,
  /** Fraction closed at the hard stop. */
  hardStopFraction: 1,
} as const;''' + futures[end:]

reason_start = futures.index("export type FuturesSplitExitReason =")
reason_end = futures.index("export type FuturesSplitExitInput", reason_start)
futures = futures[:reason_start] + '''export type FuturesSplitExitReason =
  | "FUTURES_HALF_TAKE_PROFIT_ROE_15"
  | "FUTURES_HALF_STOP_LOSS_ROE_12"
  | "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12"
  | "FUTURES_HALF_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"
  | "FUTURES_RESIDUAL_PROTECTED_TRAIL_ACTIVE";

''' + futures[reason_end:]

futures = replace_once(
    futures,
    "  /** Price return from average entry to the executable exit price, before fees, in %. */\n  grossReturnPct: number;\n",
    "  /** Price return from average entry to the executable exit price, before fees, in %. */\n  grossReturnPct: number;\n  /** Highest observed gross price return since entry, in %. */\n  peakGrossReturnPct: number;\n",
    "futures peak input",
)

futures = replace_once(
    futures,
    "  /** Leverage-applied return after the sell fee. */\n  netRoePct: number;\n  leverage: number;\n",
    "  /** Leverage-applied return after the sell fee. */\n  netRoePct: number;\n  /** Highest observed leverage-applied gross return. */\n  peakRoePct: number;\n  /** Active residual protection threshold when in residual stage. */\n  residualProtectRoePct: number | null;\n  leverage: number;\n",
    "futures decision audit fields",
)

old_init = '''  const roePct = futuresRoePct(input.grossReturnPct, leverage);
  const netRoePct = futuresRoePct(input.netReturnPct, leverage);
  const base = { roePct, netRoePct, leverage };
'''
new_init = '''  const roePct = futuresRoePct(input.grossReturnPct, leverage);
  const netRoePct = futuresRoePct(input.netReturnPct, leverage);
  const peakGrossReturnPct = Math.max(input.grossReturnPct, finite(input.peakGrossReturnPct));
  const peakRoePct = futuresRoePct(peakGrossReturnPct, leverage);
  const residualProtectRoePct = input.residualStage
    ? Math.max(
      thresholds.residualProfitFloorRoePct,
      peakRoePct - thresholds.residualTrailingDrawdownRoePct,
    )
    : null;
  const base = { roePct, netRoePct, peakRoePct, residualProtectRoePct, leverage };
'''
futures = replace_once(futures, old_init, new_init, "futures decision init")

fn_start = futures.index("  if (input.residualStage) {", futures.index("export function futuresSplitExitDecision"))
fn_end = futures.index("\n  if (roePct >= thresholds.firstTakeProfitRoePct)", fn_start)
new_residual = '''  if (input.residualStage) {
    if (roePct <= finite(residualProtectRoePct, thresholds.residualProfitFloorRoePct)) {
      return {
        ...base,
        action: "STOP",
        fraction: 1,
        reason: "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",
      };
    }
    return {
      ...base,
      action: "NONE",
      fraction: 0,
      reason: "FUTURES_RESIDUAL_PROTECTED_TRAIL_ACTIVE",
    };
  }
'''
futures = futures[:fn_start] + new_residual + futures[fn_end:]

futures = replace_once(
    futures,
    '      fraction: thresholds.firstExitFraction,\n      reason: "FUTURES_HALF_TAKE_PROFIT_ROE_15",',
    '      fraction: thresholds.firstTakeProfitFraction,\n      reason: "FUTURES_HALF_TAKE_PROFIT_ROE_15",',
    "futures tp fraction",
)
futures = replace_once(
    futures,
    '      fraction: thresholds.firstExitFraction,\n      reason: "FUTURES_HALF_STOP_LOSS_ROE_12",',
    '      fraction: thresholds.hardStopFraction,\n      reason: "FUTURES_HALF_STOP_LOSS_ROE_12",',
    "futures stop fraction",
)

approved_start = futures.index("export const FUTURES_EXIT_APPROVED_REASONS")
approved_end = futures.index("];", approved_start) + 2
futures = futures[:approved_start] + '''export const FUTURES_EXIT_APPROVED_REASONS: readonly FuturesSplitExitReason[] = [
  "FUTURES_HALF_TAKE_PROFIT_ROE_15",
  "FUTURES_HALF_STOP_LOSS_ROE_12",
  "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",
];''' + futures[approved_end:]
write(futures_path, futures)

FUTURES_TEST = '''import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_FUTURES_LEVERAGE,
  FUTURES_MIN_ENTRY_MARGIN_USDT,
  futuresEntryMinimums,
  futuresPriceReturnPctForRoe,
  futuresRoePct,
  futuresSplitExitDecision,
  normalizeFuturesLeverage,
} from "./futures-exit-policy.ts";

function decide(overrides: Record<string, unknown> = {}) {
  return futuresSplitExitDecision({
    residualStage: false,
    recoveryMode: false,
    leverage: DEFAULT_FUTURES_LEVERAGE,
    grossReturnPct: 0,
    peakGrossReturnPct: 0,
    netReturnPct: 0,
    executableNetAllowed: false,
    expectedNetProfitQuote: -1,
    safetyRequested: false,
    ...overrides,
  });
}

Deno.test("default futures leverage remains 3x", () => {
  assertEquals(DEFAULT_FUTURES_LEVERAGE, 3);
  assertEquals(normalizeFuturesLeverage(undefined), 3);
});

Deno.test("futures entry floor remains 50 USDT margin", () => {
  assertEquals(FUTURES_MIN_ENTRY_MARGIN_USDT, 50);
  assertEquals(futuresEntryMinimums(3, 5), { marginQuote: 50, notionalQuote: 150, leverage: 3 });
});

Deno.test("3x converts -4/+5 price return to -12/+15 ROE", () => {
  assertEquals(futuresRoePct(-4, 3), -12);
  assertEquals(futuresRoePct(5, 3), 15);
  assertEquals(futuresPriceReturnPctForRoe(-12, 3), -4);
  assertEquals(futuresPriceReturnPctForRoe(15, 3), 5);
});

Deno.test("futures takes 50% at +15% ROE", () => {
  const d = decide({ grossReturnPct: 5, peakGrossReturnPct: 5 });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 0.5);
  assertEquals(d.reason, "FUTURES_HALF_TAKE_PROFIT_ROE_15");
});

Deno.test("futures hard stop closes 100% at -12% ROE", () => {
  const d = decide({ grossReturnPct: -4, peakGrossReturnPct: 0 });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "FUTURES_HALF_STOP_LOSS_ROE_12");
});

Deno.test("futures residual at +15% ROE peak protects at +10.5% ROE", () => {
  const hold = decide({ residualStage: true, grossReturnPct: 3.6, peakGrossReturnPct: 5 });
  assertEquals(hold.action, "NONE");
  assertEquals(hold.peakRoePct, 15);
  assertEquals(hold.residualProtectRoePct, 10.5);
  const exit = decide({ residualStage: true, grossReturnPct: 3.5, peakGrossReturnPct: 5 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.fraction, 1);
});

Deno.test("futures +24% ROE peak exits residual at +19.5% ROE", () => {
  const d = decide({ residualStage: true, grossReturnPct: 6.5, peakGrossReturnPct: 8 });
  assertEquals(d.peakRoePct, 24);
  assertEquals(d.residualProtectRoePct, 19.5);
  assertEquals(d.action, "STOP");
  assertEquals(d.reason, "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT");
});

Deno.test("futures residual protection floor is never below +9% ROE", () => {
  const d = decide({ residualStage: true, grossReturnPct: 3, peakGrossReturnPct: 4 });
  assertEquals(d.residualProtectRoePct, 9);
  assertEquals(d.action, "STOP");
});
'''
write("supabase/functions/market-autotrader/futures-exit-policy.test.ts", FUTURES_TEST)

# Runtime wiring and policy display.
index_path = "supabase/functions/market-autotrader/index.ts"
index = read(index_path)
index = replace_once(
    index,
    '      // Spot: +5/-4 first 50%, then +10/-4 residual. Futures keeps its isolated ROE/recovery policy.\n      if ((lobMode || futuresLane) && !settings.emergency_liquidation) {\n        const activeSplitPolicyVersion = futuresLane\n          ? "FUTURES-SPLIT-ROE15-SL12-ROE30-RECOVERY-V1"\n          : "SPOT-SPLIT-TP5-SL4-TP10-SL4-V1";',
    '      // Spot: -4% hard stop, +5% half TP, then +3% floor / 1.5pp trailing.\n      // Futures 3x: -12% ROE hard stop, +15% ROE half TP, then +9% floor / 4.5pp trailing.\n      if ((lobMode || futuresLane) && !settings.emergency_liquidation) {\n        const activeSplitPolicyVersion = futuresLane\n          ? "FUTURES-PROTECTED-TRAIL-ROE15-SL12-FLOOR9-TRAIL4P5-V1"\n          : "SPOT-PROTECTED-TRAIL-TP5-SL4-FLOOR3-TRAIL1P5-V1";',
    "runtime policy version",
)

old_returns = '''        const residualNetReturnPct = entryPrice > 0
          ? (executableExitPrice * (1 - policyFeeRate) /
              (entryPrice * (1 + policyFeeRate)) - 1) * 100
          : 0;
        const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);
'''
new_returns = '''        const residualNetReturnPct = entryPrice > 0
          ? (executableExitPrice * (1 - policyFeeRate) /
              (entryPrice * (1 + policyFeeRate)) - 1) * 100
          : 0;
        const peakExecutablePrice = Math.max(
          executableExitPrice,
          finite(position.peak_price, entryPrice),
        );
        const peakGrossReturnPct = entryPrice > 0
          ? (peakExecutablePrice / entryPrice - 1) * 100
          : grossReturnPct;
        const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);
'''
index = replace_once(index, old_returns, new_returns, "runtime peak return")
index = replace_once(
    index,
    "            grossReturnPct,\n            netReturnPct: residualNetReturnPct,",
    "            grossReturnPct,\n            peakGrossReturnPct,\n            netReturnPct: residualNetReturnPct,",
    "futures runtime peak input",
)
index = replace_once(
    index,
    "            grossReturnPct,\n            residualNetReturnPct,",
    "            grossReturnPct,\n            peakGrossReturnPct,\n            residualNetReturnPct,",
    "spot runtime peak input",
)

old_recovery = '''          const nextRecovery = futuresRecoveryLatched({
            residualStage: !hasTradableHalf,
            alreadyLatched: recoveryMode,
            netReturnPct: residualNetReturnPct,
          });
          recoveryLatchedNow = nextRecovery && !recoveryMode;
          recoveryMode = nextRecovery;
'''
index = replace_once(
    index,
    old_recovery,
    '''          // Protected trailing replaces the legacy negative-to-positive recovery latch.
          recoveryLatchedNow = false;
          recoveryMode = false;
''',
    "disable futures recovery latch",
)

old_status = '''  if (row?.exchange === "binance_futures") return { ...row, exit_policy: "FUTURES_SPLIT_EXIT", strategy_revision: revision, marked_pnl_quote: markedPnl, active_exit_policy: { revision, price_basis: "QUANTITY_AWARE_EXECUTABLE_BID", return_basis: "RETURN_ON_MARGIN", leverage: positionLeverage(row), first_take_profit_roe_pct: 15, first_stop_loss_roe_pct: -12, first_tranche_sell_fraction: 0.5, residual_take_profit_roe_pct: 30, residual_loss_mode: "RESIDUAL_NET_POSITIVE", stop_price: row?.stop_price, target_1: row?.target_1, target_2: row?.target_2, marked_pnl_quote: markedPnl, measured_at: row?.metadata?.live_mark?.measured_at || null }};
  return { ...row, exit_policy: "SPOT_SPLIT_EXIT", strategy_revision: revision, stop_bps: 400, marked_pnl_quote: markedPnl, active_exit_policy: { revision, price_basis: "QUANTITY_AWARE_EXECUTABLE_BID", return_basis: "RETURN_ON_PRICE", first_take_profit_pct: 5, first_stop_loss_pct: -4, first_tranche_sell_fraction: 0.5, residual_take_profit_pct: 10, residual_stop_loss_pct: -4, residual_sell_fraction: 1, stop_price: row?.stop_price, target_1: row?.target_1, target_2: row?.target_2, marked_pnl_quote: markedPnl, measured_at: row?.metadata?.live_mark?.measured_at || null }, historical_entry_signal: { engine_version: row?.metadata?.engine_version || null, strategy_revision: row?.metadata?.lob_signal?.strategy_revision || null, stop_bps: row?.metadata?.lob_signal?.stop_bps ?? null }};
'''
new_status = '''  if (row?.exchange === "binance_futures") return { ...row, exit_policy: "FUTURES_SPLIT_EXIT", strategy_revision: revision, marked_pnl_quote: markedPnl, active_exit_policy: { revision, price_basis: "QUANTITY_AWARE_EXECUTABLE_BID", return_basis: "RETURN_ON_MARGIN", leverage: positionLeverage(row), first_take_profit_roe_pct: 15, first_stop_loss_roe_pct: -12, hard_stop_sell_fraction: 1, first_tranche_sell_fraction: 0.5, residual_profit_floor_roe_pct: 9, residual_trailing_drawdown_roe_pct: 4.5, residual_sell_fraction: 1, stop_price: row?.stop_price, target_1: row?.target_1, target_2: null, marked_pnl_quote: markedPnl, measured_at: row?.metadata?.live_mark?.measured_at || null }};
  return { ...row, exit_policy: "SPOT_SPLIT_EXIT", strategy_revision: revision, stop_bps: 400, marked_pnl_quote: markedPnl, active_exit_policy: { revision, price_basis: "QUANTITY_AWARE_EXECUTABLE_BID", return_basis: "RETURN_ON_PRICE", first_take_profit_pct: 5, first_stop_loss_pct: -4, hard_stop_sell_fraction: 1, first_tranche_sell_fraction: 0.5, residual_profit_floor_pct: 3, residual_trailing_drawdown_pct: 1.5, residual_sell_fraction: 1, stop_price: row?.stop_price, target_1: row?.target_1, target_2: null, marked_pnl_quote: markedPnl, measured_at: row?.metadata?.live_mark?.measured_at || null }, historical_entry_signal: { engine_version: row?.metadata?.engine_version || null, strategy_revision: row?.metadata?.lob_signal?.strategy_revision || null, stop_bps: row?.metadata?.lob_signal?.stop_bps ?? null }};
'''
index = replace_once(index, old_status, new_status, "status policy display")
write(index_path, index)

# New DB authority: dynamic trailing thresholds and full hard-stop exits.
MIGRATION = r'''begin;

create or replace function public.position_exit_levels_v760(
  p_exchange text,
  p_leverage numeric,
  p_entry numeric
)
returns table (
  stop_price numeric,
  target_1 numeric,
  target_2 numeric,
  first_tp_pct numeric,
  first_sl_pct numeric,
  residual_tp_pct numeric,
  leverage numeric,
  futures boolean
)
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_futures boolean := lower(coalesce(p_exchange, '')) = 'binance_futures';
  v_leverage numeric := case
    when v_futures then least(20, greatest(1, coalesce(nullif(p_leverage, 0), 3)))
    else 1
  end;
  v_first_tp numeric;
  v_first_sl numeric;
begin
  if v_futures then
    v_first_tp := 15 / v_leverage;
    v_first_sl := -12 / v_leverage;
  else
    v_first_tp := 5;
    v_first_sl := -4;
  end if;
  return query select
    p_entry * (1 + v_first_sl / 100),
    p_entry * (1 + v_first_tp / 100),
    null::numeric,
    v_first_tp,
    v_first_sl,
    null::numeric,
    v_leverage,
    v_futures;
end;
$function$;

create or replace function public.enforce_residual_exit_position_policy_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
  v_levels record;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;
  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(new.initial_quantity, 0) <= 0 then
    return new;
  end if;
  v_step := greatest(0, coalesce(new.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, new.initial_quantity * 0.00000001);
  v_residual_stage := coalesce(new.remaining_quantity, new.initial_quantity) <=
    new.initial_quantity * 0.5 + v_tolerance;
  select * into v_levels
  from public.position_exit_levels_v760(new.exchange, new.leverage, v_entry);

  new.stop_price := v_levels.stop_price;
  new.target_1 := v_levels.target_1;
  new.target_2 := null;
  new.t1_allocation_pct := 50;
  new.t1_completed := v_residual_stage;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := case
    when v_levels.futures then 4.5 / v_levels.leverage
    else 1.5
  end;
  new.metadata := (coalesce(new.metadata, '{}'::jsonb) - 'recovery_exit') || jsonb_build_object(
    'exit_policy_revision', '7.6.0-BINANCE-FUTURES',
    'exit_policy_profile', 'PROTECTED_TRAIL_V1',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'first_tranche_ratio', 0.5,
      'residual_ratio', 0.5,
      'hard_stop_sell_fraction', 1,
      'leverage', v_levels.leverage,
      'basis', case when v_levels.futures then 'RETURN_ON_MARGIN' else 'RETURN_ON_PRICE' end,
      'first_take_profit_pct', v_levels.first_tp_pct,
      'first_stop_loss_pct', v_levels.first_sl_pct,
      'first_take_profit_roe_pct', case when v_levels.futures then 15 else null end,
      'first_stop_loss_roe_pct', case when v_levels.futures then -12 else null end,
      'residual_profit_floor_pct', case when v_levels.futures then 9 / v_levels.leverage else 3 end,
      'residual_trailing_drawdown_pct', case when v_levels.futures then 4.5 / v_levels.leverage else 1.5 end,
      'residual_profit_floor_roe_pct', case when v_levels.futures then 9 else null end,
      'residual_trailing_drawdown_roe_pct', case when v_levels.futures then 4.5 else null end,
      'residual_mode', 'PROTECTED_TRAILING',
      'residual_sell_fraction', 1,
      'stage', case when v_residual_stage then 'RESIDUAL' else 'FIRST_TRANCHE' end,
      'enforced_at', now()
    )
  );
  return new;
end;
$function$;

create or replace function public.guard_residual_sell_order_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_price numeric;
  v_quote_at timestamptz;
  v_gross_return_pct numeric;
  v_gross_roe_pct numeric;
  v_peak_price numeric;
  v_peak_return_pct numeric;
  v_peak_roe_pct numeric;
  v_protect_pct numeric;
  v_protect_roe_pct numeric;
  v_protected_qty numeric;
  v_sellable_qty numeric;
  v_requested_qty numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
  v_approved_reason text;
  v_min_exit_notional numeric;
  v_futures boolean;
  v_leverage numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;
  select * into p from public.trading_positions where id = new.position_id for update;
  if not found then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_POSITION_NOT_FOUND';
  end if;
  if p.state not in ('OPEN','EXITING') then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_POSITION_NOT_SELLABLE state=%s market=%s', p.state, p.market
    );
  end if;
  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(p.initial_quantity, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_INVALID_POSITION_BASIS';
  end if;
  v_price := coalesce(
    nullif(new.requested_price, 0),
    nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,executable_vwap}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,sell_price}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,executable_price}', '')::numeric
  );
  v_quote_at := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz,
    nullif(p.metadata#>>'{live_mark,measured_at}', '')::timestamptz
  );
  if coalesce(v_price, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_MISSING_EXECUTABLE_PRICE';
  end if;
  if new.requested_price is null and (v_quote_at is null or now() - v_quote_at > interval '30 seconds') then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_STALE_EXECUTABLE_PRICE';
  end if;

  v_futures := lower(coalesce(p.exchange, '')) = 'binance_futures';
  v_leverage := case when v_futures
    then least(20, greatest(1, coalesce(nullif(p.leverage, 0), 3))) else 1 end;
  v_gross_return_pct := (v_price / v_entry - 1) * 100;
  v_gross_roe_pct := v_gross_return_pct * v_leverage;
  v_peak_price := greatest(v_price, coalesce(nullif(p.peak_price, 0), v_price));
  v_peak_return_pct := (v_peak_price / v_entry - 1) * 100;
  v_peak_roe_pct := v_peak_return_pct * v_leverage;
  v_protect_pct := greatest(3, v_peak_return_pct - 1.5);
  v_protect_roe_pct := greatest(9, v_peak_roe_pct - 4.5);
  v_step := greatest(0, coalesce(p.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, p.initial_quantity * 0.00000001);
  v_protected_qty := greatest(0, p.initial_quantity * 0.5);
  v_residual_stage := p.remaining_quantity <= v_protected_qty + v_tolerance;
  v_approved_reason := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
    nullif(p.metadata->>'pending_exit_reason', ''),
    ''
  );
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));

  if v_residual_stage then
    if v_futures then
      if v_approved_reason <> 'FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT' then
        raise exception using errcode='23514', message=format(
          'FUTURES_PROTECTED_TRAIL_REASON_REQUIRED market=%s approved_reason=%s', p.market, v_approved_reason
        );
      end if;
      if v_gross_roe_pct > v_protect_roe_pct + 0.001 then
        raise exception using errcode='23514', message=format(
          'FUTURES_PROTECTED_TRAIL_NOT_REACHED market=%s roe=%s protect_roe=%s peak_roe=%s',
          p.market, round(v_gross_roe_pct, 6), round(v_protect_roe_pct, 6), round(v_peak_roe_pct, 6)
        );
      end if;
    else
      if v_approved_reason <> 'RESIDUAL_PROTECTED_TRAIL_EXIT' then
        raise exception using errcode='23514', message=format(
          'SPOT_PROTECTED_TRAIL_REASON_REQUIRED market=%s approved_reason=%s', p.market, v_approved_reason
        );
      end if;
      if v_gross_return_pct > v_protect_pct + 0.001 then
        raise exception using errcode='23514', message=format(
          'SPOT_PROTECTED_TRAIL_NOT_REACHED market=%s return=%s protect=%s peak=%s',
          p.market, round(v_gross_return_pct, 6), round(v_protect_pct, 6), round(v_peak_return_pct, 6)
        );
      end if;
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif v_futures then
    if v_gross_roe_pct >= 14.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
    elsif v_gross_roe_pct <= -11.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity);
    else
      raise exception using errcode='23514', message=format(
        'FUTURES_FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_roe_pct=%s leverage=%s',
        p.market, round(v_gross_roe_pct, 6), v_leverage
      );
    end if;
  else
    if v_gross_return_pct >= 4.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
    elsif v_gross_return_pct <= -3.999 then
      v_sellable_qty := greatest(0, p.remaining_quantity);
    else
      raise exception using errcode='23514', message=format(
        'FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_return_pct=%s',
        p.market, round(v_gross_return_pct, 6)
      );
    end if;
  end if;

  if v_step > 0 then
    v_sellable_qty := floor((v_sellable_qty + v_step * 0.000000001) / v_step) * v_step;
  end if;
  new.requested_volume := least(v_requested_qty, v_sellable_qty);
  if coalesce(new.requested_volume, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_NO_AUTHORIZED_QUANTITY market=%s residual_stage=%s remaining_qty=%s',
      p.market, v_residual_stage, p.remaining_quantity
    );
  end if;
  v_min_exit_notional := case when lower(p.exchange) = 'upbit' then 5000 else 5 end;
  if new.requested_volume * v_price < v_min_exit_notional then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_EXIT_BELOW_EXCHANGE_MINIMUM market=%s notional=%s minimum=%s',
      p.market, round(new.requested_volume * v_price, 8), v_min_exit_notional
    );
  end if;
  new.requested_notional_quote := new.requested_volume * v_price;
  return new;
end;
$function$;

comment on function public.enforce_residual_exit_position_policy_v751() is
  'Protected trailing v1: spot -4 full / +5 half / floor +3 / trail 1.5pp; futures ROE -12 full / +15 half / floor +9 / trail 4.5pp';
comment on function public.guard_residual_sell_order_v751() is
  'Protected trailing v1 durable sell guard with full hard-stop exits and peak-aware residual protection';

-- Re-stamp currently open positions with the new canonical policy metadata/levels.
update public.trading_positions
set metadata = coalesce(metadata, '{}'::jsonb) - 'recovery_exit',
    updated_at = now()
where state in ('OPEN','EXITING')
  and lower(coalesce(exchange, '')) in ('upbit','binance','binance_futures');

commit;
'''
migration_path = "supabase/migrations/20260810133000_protected_trailing_exit_v761.sql"
write(migration_path, MIGRATION)

# Keep future CI/deploys aligned with the new canonical policy.
workflow_path = ".github/workflows/deploy-market-autotrader-v707.yml"
workflow = read(workflow_path)
workflow = workflow.replace(
    '      - "supabase/migrations/20260810010000_binance_futures_lane_v760.sql"\n',
    '      - "supabase/migrations/20260810010000_binance_futures_lane_v760.sql"\n      - "supabase/migrations/20260810133000_protected_trailing_exit_v761.sql"\n',
)
workflow = workflow.replace(
    "          grep -q 'SPOT-SPLIT-TP5-SL4-TP10-SL4-V1' supabase/functions/market-autotrader/index.ts\n",
    "          grep -q 'SPOT-PROTECTED-TRAIL-TP5-SL4-FLOOR3-TRAIL1P5-V1' supabase/functions/market-autotrader/index.ts\n",
)
workflow = workflow.replace(
    "          grep -q 'residual_stop_loss_pct: -4' supabase/functions/market-autotrader/index.ts\n",
    "          grep -q 'residual_profit_floor_pct: 3' supabase/functions/market-autotrader/index.ts\n          grep -q 'residual_trailing_drawdown_pct: 1.5' supabase/functions/market-autotrader/index.ts\n",
)
workflow = workflow.replace(
    "          grep -q 'FUTURES_RECOVERY_NET_POSITIVE_EXIT' supabase/functions/market-autotrader/index.ts\n",
    "          grep -q 'FUTURES-PROTECTED-TRAIL-ROE15-SL12-FLOOR9-TRAIL4P5-V1' supabase/functions/market-autotrader/index.ts\n          grep -q 'residualProfitFloorRoePct: 9' supabase/functions/market-autotrader/futures-exit-policy.ts\n          grep -q 'residualTrailingDrawdownRoePct: 4.5' supabase/functions/market-autotrader/futures-exit-policy.ts\n",
)
write(workflow_path, workflow)

main_deploy_path = ".github/workflows/main.deploy-supabase.yml"
main_deploy = read(main_deploy_path)
old_apply = '''          psql "${SUPABASE_DB_URL}" \\
            --set=ON_ERROR_STOP=1 \\
            --single-transaction \\
            --file supabase/migrations/20260810010000_binance_futures_lane_v760.sql
'''
new_apply = old_apply + '''          psql "${SUPABASE_DB_URL}" \\
            --set=ON_ERROR_STOP=1 \\
            --single-transaction \\
            --file supabase/migrations/20260810133000_protected_trailing_exit_v761.sql
'''
main_deploy = replace_once(main_deploy, old_apply, new_apply, "main deploy migration replay")
write(main_deploy_path, main_deploy)

print("protected trailing exit patch prepared")
