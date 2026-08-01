from pathlib import Path
import re

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


def regex_once(pattern: str, replacement: str, label: str) -> None:
    global text
    text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, found {count}")


if "7.1.5-EXECUTABLE-NET-EXIT" not in text:
    raise SystemExit("v7.1.5 runtime patch must run before v7.1.6")
text = text.replace(
    "7.1.5-EXECUTABLE-NET-EXIT",
    "7.1.6-PROTECTED-TARGET-BALANCE-RECONCILE",
)

regex_once(
    r"async function sellLive\(position: Position, quantity: number, purpose: string, cycleId: string\) \{.*?\n\}\nasync function finalizeExitFill",
    r'''type ProtectedTargetQuote = {
  limitPrice: number;
  expectedNetProfitQuote: number;
  availableQuantity: number;
  measuredAt: string;
};

function exactUnrecoveredPositionCost(position: Position): number {
  return Math.max(
    0,
    finite(position.realized_cost_quote) + finite(position.paid_fees_quote) -
      finite(position.realized_proceeds_quote),
  );
}

function protectedTargetProfitBuffer(position: Position): number {
  return position.exchange === "upbit" ? 1 : 0.01;
}

async function prepareProtectedTarget(
  position: Position,
  quantity: number,
  purpose: string,
  cycleId: string,
): Promise<ProtectedTargetQuote | null> {
  const quote = await marketQuote(position.exchange, position.market);
  const feeRate = clamp(FEE_PCT[position.exchange] / 100, 0, 0.01);
  const cost = exactUnrecoveredPositionCost(position);
  const profitBuffer = protectedTargetProfitBuffer(position);
  const tick = Math.max(0.000000000001, finite(position.tick_size, 0.00000001));
  const plannedTarget = purpose === "TARGET_2"
    ? Math.max(finite(position.target_2), finite(position.target_1))
    : finite(position.target_1);
  const economicFloor = quantity > 0 && 1 - feeRate > 0
    ? (cost + profitBuffer) / (quantity * (1 - feeRate))
    : Number.POSITIVE_INFINITY;
  const limitPrice = tickRound(Math.max(plannedTarget, economicFloor), tick, "up");
  const bids = (quote?.bids || []).map((row: any) => ({
    price: finite(row?.price ?? row?.[0]),
    size: finite(row?.size ?? row?.[1]),
  })).filter((row: any) => row.price > 0 && row.size > 0 && row.price + tick * 1e-9 >= limitPrice);
  const availableQuantity = bids.reduce((sum: number, row: any) => sum + row.size, 0);
  const expectedNetProfitQuote = limitPrice * quantity * (1 - feeRate) - cost;
  const measuredAt = new Date().toISOString();
  const protectedQuote = {
    revision: "7.1.6-PROTECTED-TARGET",
    purpose,
    measured_at: measuredAt,
    limit_price: limitPrice,
    planned_target: plannedTarget,
    economic_floor: economicFloor,
    requested_quantity: quantity,
    available_quantity_at_or_above_floor: availableQuantity,
    exact_unrecovered_cost_quote: cost,
    exit_fee_rate: feeRate,
    minimum_profit_quote: profitBuffer,
    expected_net_profit_quote: expectedNetProfitQuote,
  };
  if (
    !(limitPrice > 0) || expectedNetProfitQuote <= profitBuffer ||
    availableQuantity + Math.max(1e-12, quantity * 1e-8) < quantity
  ) {
    await patch("trading_positions", `id=eq.${position.id}`, {
      metadata: {
        ...(position.metadata || {}),
        target_net_guard: { ...protectedQuote, allowed: false },
      },
    });
    await event(
      "TARGET_NET_GUARD_BLOCKED",
      `${position.exchange}:${position.market} protected target not executable at positive net`,
      { ...protectedQuote, allowed: false },
      { cycleId, positionId: position.id, level: "INFO" },
    );
    return null;
  }
  await patch("trading_positions", `id=eq.${position.id}`, {
    metadata: {
      ...(position.metadata || {}),
      target_net_guard: { ...protectedQuote, allowed: true },
    },
  });
  return { limitPrice, expectedNetProfitQuote, availableQuantity, measuredAt };
}

async function sellLive(
  position: Position,
  quantity: number,
  purpose: string,
  cycleId: string,
  protectedTarget: ProtectedTargetQuote | null = null,
) {
  const portfolio = await gateway(position.exchange, { action: "portfolio" });
  const available = accountQuantity(portfolio, position.base_asset, true);
  const step = finite(position.quantity_step, 0.00000001);
  const qty = floorToStep(Math.min(position.remaining_quantity, quantity, available), step);
  if (!(qty > 0)) throw new Error(`no available ${position.base_asset} balance for exit`);
  const identifier = uniqueId("x", position.id);
  const isProtectedTarget = purpose === "TARGET_1" || purpose === "TARGET_2";
  if (isProtectedTarget && !protectedTarget) {
    throw new Error("protected target quote is required for target exit");
  }
  const orderType = isProtectedTarget ? "LIMIT" : "MARKET";
  const timeInForce = isProtectedTarget ? "FOK" : null;
  const requestedPrice = isProtectedTarget ? protectedTarget!.limitPrice : null;
  const orderRow = await createOrderRecord({
    position_id: position.id,
    candidate_id: position.candidate_id,
    cycle_id: cycleId,
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    identifier,
    market: position.market,
    side: "SELL",
    purpose,
    order_type: orderType,
    time_in_force: timeInForce,
    requested_price: requestedPrice,
    requested_volume: qty,
    requested_notional_quote: requestedPrice ? requestedPrice * qty : null,
    state: "REQUESTED",
  });
  try {
    const result = await gateway(position.exchange, {
      action: "create_order",
      order: isProtectedTarget
        ? {
          market: position.market,
          side: "SELL",
          type: "LIMIT",
          price: requestedPrice,
          quantity: qty,
          time_in_force: "FOK",
          identifier,
        }
        : { market: position.market, side: "SELL", type: "MARKET", quantity: qty, identifier },
      wait_for_final_ms: 4000,
    }, 20_000);
    const updated = await updateOrderFromGateway(orderRow, result);
    if (finite(updated.fill.executedVolume) <= 0) {
      if (isProtectedTarget) return { orderRow, ...updated, noFill: true };
      throw new Error("market sell returned no fill");
    }
    return { orderRow, ...updated, noFill: false };
  } catch (error) {
    await patch("trading_orders", `id=eq.${orderRow.id}`, {
      state: "UNKNOWN",
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
async function finalizeExitFill''',
    "replace live exit with protected target execution",
)

regex_once(
    r"async function applyExit\(\n  position: Position,.*?\n\}\n\nfunction clearedReconciliationMetadata",
    r'''async function applyExit(
  position: Position,
  price: number,
  action: string,
  cycleId: string,
  breakevenAfterT1 = true,
  decisionReason?: string,
) {
  const targetAction = action === "TARGET_1" || action === "TARGET_2";
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

  const protectedTarget = !position.is_paper && targetAction
    ? await prepareProtectedTarget(position, quantity, action, cycleId)
    : null;
  if (!position.is_paper && targetAction && !protectedTarget) {
    return { action: "NONE", reason: "target net guard blocked or insufficient protected depth" };
  }

  if (!position.is_paper) {
    position = {
      ...position,
      ...(await patch("trading_positions", `id=eq.${position.id}`, {
        state: "EXITING",
        metadata: {
          ...(position.metadata || {}),
          pending_exit_action: action,
          pending_exit_reason: decisionReason || action,
          pending_exit_at: new Date().toISOString(),
        },
      }))[0],
    };
  }
  const result = position.is_paper
    ? await sellPaper(position, quantity, price, action, cycleId)
    : await sellLive(position, quantity, action, cycleId, protectedTarget);

  if (!position.is_paper && result?.noFill) {
    const reopened = (await patch("trading_positions", `id=eq.${position.id}`, {
      state: "OPEN",
      metadata: {
        ...(position.metadata || {}),
        pending_exit_action: null,
        pending_exit_reason: null,
        pending_exit_at: null,
        protected_target_last_unfilled_at: new Date().toISOString(),
      },
    }))[0] || position;
    await event(
      "TARGET_PROTECTED_ORDER_NOT_FILLED",
      `${position.exchange}:${position.market} protected target FOK did not fill; position retained`,
      {
        action,
        limit_price: protectedTarget?.limitPrice,
        expected_net_profit_quote: protectedTarget?.expectedNetProfitQuote,
      },
      { cycleId, positionId: position.id, orderId: result.orderRow?.id, level: "INFO" },
    );
    return { action: "NONE", reason: "protected target not filled", position: reopened };
  }

  let finalized = await finalizeExitFill(
    position,
    result,
    action,
    protectedTarget?.limitPrice || price,
    cycleId,
    breakevenAfterT1,
  );
  if (
    targetAction && finalized?.closed &&
    finite(finalized?.position?.realized_pnl_quote) <= 0
  ) {
    const corrected = (await patch("trading_positions", `id=eq.${position.id}`, {
      close_reason: "TARGET_NET_GUARD_BREACH",
      metadata: {
        ...(finalized.position?.metadata || position.metadata || {}),
        original_close_reason: action,
        target_net_guard_breached_at: new Date().toISOString(),
      },
    }))[0] || finalized.position;
    await event(
      "TARGET_NET_GUARD_BREACH",
      `${position.exchange}:${position.market} protected target accounting was non-positive`,
      {
        action,
        realized_pnl_quote: finite(corrected?.realized_pnl_quote),
        limit_price: protectedTarget?.limitPrice,
      },
      { cycleId, positionId: position.id, orderId: result.orderRow?.id, level: "CRITICAL" },
    );
    finalized = { ...finalized, position: corrected };
  }
  return finalized;
}

function clearedReconciliationMetadata''',
    "replace applyExit target gate",
)

replace_once(
    '    const exchangePositions = open.filter((p) => p.exchange === exchange);',
    '''    const exchangePositions = open.filter((p) => p.exchange === exchange);
    const balanceTrackedPositions = tracked.filter((p) =>
      p.exchange === exchange && !p.is_paper &&
      ["OPEN", "RECONCILING", "RECONCILIATION_FAILED", "MANUAL_INTERVENTION_REQUIRED"].includes(
        String(p.state),
      )
    );''',
    "add balance-tracked states",
)
replace_once(
    "    const botLockedResult = await botLockedQuantities(exchange, exchangePositions);",
    "    const botLockedResult = await botLockedQuantities(exchange, balanceTrackedPositions);",
    "include stale states in bot lock reconciliation",
)
replace_once(
    "    for (const originalPosition of exchangePositions.filter((row) => !row.is_paper)) {",
    "    for (const originalPosition of balanceTrackedPositions) {",
    "compare all managed states with account balance",
)

replace_once(
    '''      const expected = finite(position.remaining_quantity);
      const actualTotal = totalByAsset.get(position.base_asset) || 0;
      const actualFree = freeByAsset.get(position.base_asset) || 0;
      const botLocked = botLockedByAsset.get(position.base_asset) || 0;

      // Reconciliation verdict.''',
    '''      const expected = finite(position.remaining_quantity);
      const actualTotal = totalByAsset.get(position.base_asset) || 0;
      const actualFree = freeByAsset.get(position.base_asset) || 0;
      const botLocked = botLockedByAsset.get(position.base_asset) || 0;

      // A stale non-OPEN row with an authenticated zero total balance and no exchange
      // order cannot represent a live holding. Reconcile it in this scan rather than
      // leaving a permanent RECONCILING ghost outside the OPEN-only monitor loop.
      if (
        position.state !== "OPEN" && actualTotal <= 1e-12 &&
        allOpenOrderAssets !== null && !allOpenOrderAssets.has(position.base_asset)
      ) {
        const pendingSellOrders = await unappliedBotSellOrders(position);
        if (!pendingSellOrders.length) {
          const reconciledAt = new Date().toISOString();
          await patch("trading_positions", `id=eq.${position.id}`, {
            state: "CLOSED",
            remaining_quantity: 0,
            reserved_quote: 0,
            reserved_quantity: 0,
            reservation_expires_at: null,
            closed_at: reconciledAt,
            close_reason: "EXCHANGE_BALANCE_ZERO_RECONCILED",
            marked_pnl_quote: null,
            metadata: {
              ...(position.metadata || {}),
              exclude_from_learning: true,
              display_data_status: "EXCHANGE_BALANCE_ZERO_RECONCILED",
              exchange_balance_reconciliation: {
                revision: "7.1.6-BALANCE-RECONCILE",
                observed_total_quantity: actualTotal,
                observed_free_quantity: actualFree,
                reconciled_at: reconciledAt,
                reason: "AUTHENTICATED_EXCHANGE_BALANCE_ZERO",
              },
            },
          });
          await event(
            "STALE_POSITION_BALANCE_RECONCILED",
            `${exchange}:${position.market} stale managed row closed after zero-balance check`,
            {
              previous_state: position.state,
              expected_quantity: expected,
              actual_total_quantity: actualTotal,
              revision: "7.1.6-BALANCE-RECONCILE",
            },
            { cycleId, positionId: position.id, level: "WARNING" },
          );
          continue;
        }
      }

      // Reconciliation verdict.''',
    "close zero-balance stale managed rows",
)

replace_once(
    '''      if (!totalMissing && !freeMissing) {
        if (previousCount > 0) {
          await patch("trading_positions", `id=eq.${position.id}`, {
            metadata: {
              ...(position.metadata || {}),
              account_mismatch_count: 0,
              last_account_mismatch_at: null,
            },
          });
        }
        continue;
      }''',
    '''      if (!totalMissing && !freeMissing) {
        const phaseMissing = !position.metadata?.reconciliation_phase;
        const recoverLegacyState =
          ["RECONCILING", "RECONCILIATION_FAILED"].includes(String(position.state)) && phaseMissing;
        if (previousCount > 0 || recoverLegacyState) {
          await patch("trading_positions", `id=eq.${position.id}`, {
            ...(recoverLegacyState ? { state: "OPEN" } : {}),
            metadata: {
              ...(position.metadata || {}),
              account_mismatch_count: 0,
              last_account_mismatch_at: null,
              balance_reconciliation_checked_at: new Date().toISOString(),
              observed_total_quantity: actualTotal,
              observed_free_quantity: actualFree,
              ...(recoverLegacyState
                ? { legacy_reconciliation_recovered_at: new Date().toISOString() }
                : {}),
            },
          });
          if (recoverLegacyState) {
            await event(
              "LEGACY_RECONCILING_POSITION_RECOVERED",
              `${exchange}:${position.market} balance-backed legacy row returned to OPEN`,
              { previous_state: position.state, actual_total_quantity: actualTotal },
              { cycleId, positionId: position.id, level: "WARNING" },
            );
          }
        }
        continue;
      }''',
    "recover balance-backed phase-less reconciliation rows",
)

regex_once(
    r'''      const lobEntryNotional = lobEntryPrice \* lobRemainingQuantity;\n      const lobExitNotional = current \* lobRemainingQuantity;\n      const lobNetProfitQuote = lobExitNotional \* \(1 - lobFeeRate\) -\n        lobEntryNotional \* \(1 \+ lobFeeRate\);''',
    '''      const lobUnrecoveredCost = exactUnrecoveredPositionCost(position);
      const lobExitNotional = current * lobRemainingQuantity;
      const lobNetProfitQuote = lobExitNotional * (1 - lobFeeRate) - lobUnrecoveredCost;''',
    "use exact economic cost for primary post-180 decision",
)

text, policy_cost_count = re.subn(
    r'''        const policyEntryCost = lobEntryPrice \* policyQuantity \* \(1 \+ policyFeeRate\);\n        const guardedNetProfitQuote = ([^;]+?) -\n          policyEntryCost;''',
    '''        const policyUnrecoveredCost = exactUnrecoveredPositionCost(position);
        const guardedNetProfitQuote = \1 - policyUnrecoveredCost;''',
    text,
    count=1,
    flags=re.S,
)
if policy_cost_count != 1:
    raise SystemExit(f"final LOB policy exact cost: expected one match, found {policy_cost_count}")

required = [
    'const VERSION = "7.1.6-PROTECTED-TARGET-BALANCE-RECONCILE";',
    'TARGET_NET_GUARD_BLOCKED',
    'time_in_force: "FOK"',
    'EXCHANGE_BALANCE_ZERO_RECONCILED',
    'exactUnrecoveredPositionCost(position)',
]
for marker in required:
    if marker not in text:
        raise SystemExit(f"missing v7.1.6 marker: {marker}")

PATH.write_text(text, encoding="utf-8")
print("applied v7.1.6 protected-target and balance-reconciliation hotfix")
