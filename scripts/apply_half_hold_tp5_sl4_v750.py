from pathlib import Path

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text()

old_version = 'const VERSION = "7.3.8-M1-CORE-SCORE-OBS-TOLERANCE";'
new_version = 'const VERSION = "7.5.0-HALF-HOLD-TP5-SL4";'
if old_version not in text and new_version not in text:
    raise SystemExit("market-autotrader VERSION anchor not found")
text = text.replace(old_version, new_version, 1)

old_quantity = '''  const targetAction = action === "TARGET_1" || action === "TARGET_2";
  const positiveNetAfter180 = decisionReason === "POSITIVE_NET_AFTER_180S";
  let quantity = targetAction && position.metadata?.lob_signal
    ? finite(position.remaining_quantity)
    : action === "TARGET_1"
    ? t1SellQuantity(
      position.initial_quantity,
      position.remaining_quantity,
      position.t1_allocation_pct,
    )
    : finite(position.remaining_quantity);
  const minNotional = positionMinNotionalQuote(position);
  if (
    quantity * price < minNotional || (position.remaining_quantity - quantity) * price < minNotional
  ) quantity = position.remaining_quantity;
  quantity = floorToStep(quantity, finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0)) return { action: "NONE", reason: "zero sell quantity" };
'''
new_quantity = '''  const targetAction = action === "TARGET_1" || action === "TARGET_2";
  const positiveNetAfter180 = decisionReason === "POSITIVE_NET_AFTER_180S";
  const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);
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
if old_quantity in text:
    text = text.replace(old_quantity, new_quantity, 1)
elif new_quantity not in text:
    raise SystemExit("applyExit quantity anchor not found")

old_comment = '''      // PREBREAKOUT-BURST-V1: no planned stop, no experimental arm stop, no fixed target
      // and no time-based exit. The only loss floor is -2% of executable net. Normal exits
      // follow the observed burst ending: bearish upper-band re-entry plus weak tape, a
      // failed reclaim, or an actual order-book collapse.
      if (lobMode && !settings.emergency_liquidation) {
        const BURST_POLICY_VERSION = "PREBREAKOUT-BURST-V1";
'''
new_comment = '''      // HALF-HOLD-TP5-SL4-V1: every position is split into a permanently protected 50%
      // tranche and one tradable 50% tranche. The tradable tranche exits only at +5% or
      // -4%; time, reversal, order-book-collapse and planned-stop exits are disabled.
      if (lobMode && !settings.emergency_liquidation) {
        const BURST_POLICY_VERSION = "HALF-HOLD-TP5-SL4-V1";
'''
if old_comment in text:
    text = text.replace(old_comment, new_comment, 1)
elif new_comment not in text:
    raise SystemExit("LOB policy comment/version anchor not found")

old_decision = '''        if (safetyRequested) {
          decision = { action: "STOP", fraction: 1, reason: requestedReason } as any;
        } else if (guardedNetReturnPct <= -2) {
          decision = { action: "STOP", fraction: 1, reason: "HARD_STOP_MINUS_2" } as any;
        } else if (orderbookCollapse) {
          decision = { action: "STOP", fraction: 1, reason: "ORDERBOOK_COLLAPSE" } as any;
        } else if (reentryConfirmed) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "BB_UPPER_REENTRY_CONFIRMED",
          } as any;
        } else if (reclaimFailed) {
          decision = { action: "STOP", fraction: 1, reason: "BB_RECLAIM_FAILED" } as any;
        } else {
          decision = {
            action: "NONE",
            fraction: 0,
            reason: "BURST_CONTINUES_OR_EXIT_NOT_CONFIRMED",
          } as any;
        }
'''
new_decision = '''        const entryPrice = finite(position.average_entry_price, position.planned_entry_price);
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
if old_decision in text:
    text = text.replace(old_decision, new_decision, 1)
elif new_decision not in text:
    raise SystemExit("LOB exit decision anchor not found")

# Keep historical reason recognition compatible while admitting the new threshold reasons.
old_reason_list = '''          decision.reason === "HARD_STOP_MINUS_2" ||
          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||
          decision.reason === "BB_RECLAIM_FAILED" ||
          decision.reason === "ORDERBOOK_COLLAPSE";'''
new_reason_list = '''          decision.reason === "HARD_STOP_MINUS_2" ||
          decision.reason === "HALF_HOLD_TAKE_PROFIT_5" ||
          decision.reason === "HALF_HOLD_STOP_LOSS_4" ||
          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||
          decision.reason === "BB_RECLAIM_FAILED" ||
          decision.reason === "ORDERBOOK_COLLAPSE";'''
if old_reason_list in text:
    text = text.replace(old_reason_list, new_reason_list, 1)
elif new_reason_list not in text:
    raise SystemExit("resting TP reason anchor not found")

required = [
    new_version,
    'const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);',
    'reason: "HALF_HOLD_TAKE_PROFIT_5"',
    'reason: "HALF_HOLD_STOP_LOSS_4"',
    'reason: "PROTECTED_50_PERCENT_HOLD_ACTIVE"',
    'const minNotional = position.exchange === "binance" ? 5 : 5000;',
]
for marker in required:
    if marker not in text:
        raise SystemExit(f"required marker missing after patch: {marker}")

PATH.write_text(text)
print("Applied v7.5.0 half-hold TP5/SL4 patch")
