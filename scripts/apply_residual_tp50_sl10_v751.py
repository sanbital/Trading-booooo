from pathlib import Path

NEW_VERSION = "7.5.1-RESIDUAL-TP50-SL10"
OLD_VERSION = "7.5.0-HALF-HOLD-TP5-SL4"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)


autotrader_path = Path("supabase/functions/market-autotrader/index.ts")
autotrader = autotrader_path.read_text()
autotrader = replace_once(
    autotrader,
    f'const VERSION = "{OLD_VERSION}";',
    f'const VERSION = "{NEW_VERSION}";',
    "market-autotrader VERSION",
)

old_quantity = '''  const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);
  const maxExitQuantity = Math.max(
    0,
    finite(position.remaining_quantity) - protectedHoldQuantity,
  );
  const desiredQuantity = targetAction && position.metadata?.lob_signal
    ? finite(position.remaining_quantity)
    : action === "TARGET_1"
    ? t1SellQuantity(
      position.initial_quantity,
      position.remaining_quantity,
      position.t1_allocation_pct,
    )
    : finite(position.remaining_quantity);
  let quantity = Math.min(desiredQuantity, maxExitQuantity);
  // Entry sizing deliberately keeps the internal Binance 90 USDT floor. Exit sizing must
  // use the venue floor, otherwise a 50% tranche below 90 USDT is silently rewritten to a
  // 100% liquidation. Upbit's executable floor remains 5,000 KRW.
  const minNotional = position.exchange === "binance" ? 5 : 5000;
  if (quantity * price < minNotional) {
    return { action: "NONE", reason: "tradable half is below exchange minimum notional" };
  }
  quantity = floorToStep(quantity, finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0)) {
    return { action: "NONE", reason: "protected 50 percent hold floor reached" };
  }
'''
new_quantity = '''  const residualThresholdExit = decisionReason === "RESIDUAL_TAKE_PROFIT_50" ||
    decisionReason === "RESIDUAL_STOP_LOSS_10";
  const protectedHoldQuantity = residualThresholdExit
    ? 0
    : Math.max(0, finite(position.initial_quantity) * 0.5);
  const maxExitQuantity = Math.max(
    0,
    finite(position.remaining_quantity) - protectedHoldQuantity,
  );
  const desiredQuantity = targetAction && position.metadata?.lob_signal
    ? finite(position.remaining_quantity)
    : action === "TARGET_1"
    ? t1SellQuantity(
      position.initial_quantity,
      position.remaining_quantity,
      position.t1_allocation_pct,
    )
    : finite(position.remaining_quantity);
  let quantity = Math.min(desiredQuantity, maxExitQuantity);
  // Entry sizing deliberately keeps the internal Binance 90 USDT floor. Exit sizing uses
  // the venue floor. A residual TP50/SL10 decision is the only non-emergency route allowed
  // to liquidate the formerly protected half.
  const minNotional = position.exchange === "binance" ? 5 : 5000;
  if (quantity * price < minNotional) {
    return { action: "NONE", reason: "exit quantity is below exchange minimum notional" };
  }
  quantity = floorToStep(quantity, finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0)) {
    return { action: "NONE", reason: "no threshold-authorized sell quantity" };
  }
'''
autotrader = replace_once(
    autotrader,
    old_quantity,
    new_quantity,
    "applyExit residual quantity",
)

old_comment = '''      // HALF-HOLD-TP5-SL4-V1: every position is split into a permanently protected 50%
      // tranche and one tradable 50% tranche. The tradable tranche exits only at +5% or
      // -4%; time, reversal, order-book-collapse and planned-stop exits are disabled.
      if (lobMode && !settings.emergency_liquidation) {
        const BURST_POLICY_VERSION = "HALF-HOLD-TP5-SL4-V1";
'''
new_comment = '''      // HALF-HOLD-RESIDUAL-TP50-SL10-V2: the first 50% still exits at +5% or -4%.
      // Once that tranche is gone, the remaining inventory exits in full only when its
      // executable return reaches +50% or -10%. Time and signal exits remain disabled.
      if (lobMode && !settings.emergency_liquidation) {
        const BURST_POLICY_VERSION = "HALF-HOLD-RESIDUAL-TP50-SL10-V2";
'''
autotrader = replace_once(
    autotrader,
    old_comment,
    new_comment,
    "LOB policy comment/version",
)

old_decision = '''        const entryPrice = finite(position.average_entry_price, position.planned_entry_price);
        const grossReturnPct = entryPrice > 0
          ? (executableExitPrice / entryPrice - 1) * 100
          : 0;
        const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);
        const hasTradableHalf = finite(position.remaining_quantity) - protectedHoldQuantity >
          Math.max(1e-12, finite(position.quantity_step, 0) * 0.5);

        if (!hasTradableHalf) {
          decision = {
            action: "NONE",
            fraction: 0,
            reason: "PROTECTED_50_PERCENT_HOLD_ACTIVE",
          } as any;
        } else if (grossReturnPct >= 5) {
          decision = {
            action: "STOP",
            fraction: 0.5,
            reason: "HALF_HOLD_TAKE_PROFIT_5",
          } as any;
        } else if (grossReturnPct <= -4) {
          decision = {
            action: "STOP",
            fraction: 0.5,
            reason: "HALF_HOLD_STOP_LOSS_4",
          } as any;
        } else {
          decision = {
            action: "NONE",
            fraction: 0,
            reason: safetyRequested
              ? "HALF_HOLD_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
              : "HALF_HOLD_AWAITING_TP5_OR_SL4",
          } as any;
        }
'''
new_decision = '''        const entryPrice = finite(position.average_entry_price, position.planned_entry_price);
        const grossReturnPct = entryPrice > 0
          ? (executableExitPrice / entryPrice - 1) * 100
          : 0;
        const residualNetReturnPct = entryPrice > 0
          ? (executableExitPrice * (1 - policyFeeRate) / entryPrice - 1) * 100
          : 0;
        const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);
        const residualTolerance = Math.max(
          1e-12,
          finite(position.quantity_step, 0) * 1.001,
        );
        const hasTradableHalf = finite(position.remaining_quantity) - protectedHoldQuantity >
          residualTolerance;

        if (!hasTradableHalf) {
          if (residualNetReturnPct >= 50) {
            decision = {
              action: "STOP",
              fraction: 1,
              reason: "RESIDUAL_TAKE_PROFIT_50",
            } as any;
          } else if (residualNetReturnPct <= -10) {
            decision = {
              action: "STOP",
              fraction: 1,
              reason: "RESIDUAL_STOP_LOSS_10",
            } as any;
          } else {
            decision = {
              action: "NONE",
              fraction: 0,
              reason: "RESIDUAL_AWAITING_TP50_OR_SL10",
            } as any;
          }
        } else if (grossReturnPct >= 5) {
          decision = {
            action: "STOP",
            fraction: 0.5,
            reason: "HALF_HOLD_TAKE_PROFIT_5",
          } as any;
        } else if (grossReturnPct <= -4) {
          decision = {
            action: "STOP",
            fraction: 0.5,
            reason: "HALF_HOLD_STOP_LOSS_4",
          } as any;
        } else {
          decision = {
            action: "NONE",
            fraction: 0,
            reason: safetyRequested
              ? "HALF_HOLD_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
              : "HALF_HOLD_AWAITING_TP5_OR_SL4",
          } as any;
        }
'''
autotrader = replace_once(
    autotrader,
    old_decision,
    new_decision,
    "LOB staged exit decision",
)

old_reason_list = '''          decision.reason === "HARD_STOP_MINUS_2" ||
          decision.reason === "HALF_HOLD_TAKE_PROFIT_5" ||
          decision.reason === "HALF_HOLD_STOP_LOSS_4" ||
          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||
          decision.reason === "BB_RECLAIM_FAILED" ||
          decision.reason === "ORDERBOOK_COLLAPSE";'''
new_reason_list = '''          decision.reason === "HARD_STOP_MINUS_2" ||
          decision.reason === "HALF_HOLD_TAKE_PROFIT_5" ||
          decision.reason === "HALF_HOLD_STOP_LOSS_4" ||
          decision.reason === "RESIDUAL_TAKE_PROFIT_50" ||
          decision.reason === "RESIDUAL_STOP_LOSS_10" ||
          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||
          decision.reason === "BB_RECLAIM_FAILED" ||
          decision.reason === "ORDERBOOK_COLLAPSE";'''
autotrader = replace_once(
    autotrader,
    old_reason_list,
    new_reason_list,
    "resting TP reason allowlist",
)

autotrader_path.write_text(autotrader)

scanner_path = Path("supabase/functions/market-scanner/engine.ts")
scanner = scanner_path.read_text()
scanner = replace_once(
    scanner,
    f'export const ENGINE_VERSION = "{OLD_VERSION}";',
    f'export const ENGINE_VERSION = "{NEW_VERSION}";',
    "market-scanner ENGINE_VERSION",
)
scanner_path.write_text(scanner)

gateway_path = Path("gateway/server.mjs")
gateway = gateway_path.read_text()
gateway = replace_once(
    gateway,
    f'const VERSION = "{OLD_VERSION}";',
    f'const VERSION = "{NEW_VERSION}";',
    "gateway VERSION",
)
gateway_path.write_text(gateway)

required = [
    f'const VERSION = "{NEW_VERSION}";',
    'reason: "RESIDUAL_TAKE_PROFIT_50"',
    'reason: "RESIDUAL_STOP_LOSS_10"',
    'reason: "RESIDUAL_AWAITING_TP50_OR_SL10"',
    'decisionReason === "RESIDUAL_TAKE_PROFIT_50"',
    'const residualTolerance = Math.max(',
]
for marker in required:
    if marker not in autotrader:
        raise SystemExit(f"required autotrader marker missing: {marker}")

print(f"Applied {NEW_VERSION} staged residual exit policy")
