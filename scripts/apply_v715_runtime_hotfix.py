from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "supabase/functions/market-autotrader/index.ts"

text = ENGINE.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    text = text.replace(old, new, 1)


def replace_count(old: str, new: str, expected: int, label: str) -> None:
    global text
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches, found {count}")
    text = text.replace(old, new)


replace_once(
    'const VERSION = "7.1.4-VOLATILITY-AWARE-EXIT";',
    'const VERSION = "7.1.5-EXECUTABLE-NET-EXIT";',
    "engine version",
)

replace_once(
    '  const isScalp = isScalpStrategy((settings as any)?.strategy);',
    '  const isScalp = isScalpStrategy((settings as any)?.strategy);\n'
    '  const isLob = isLobStrategy((settings as any)?.strategy);',
    "candidate plan strategy flags",
)
replace_once(
    '    exitPolicy: isScalp\n      ? "TRAIL_AFTER_T1"',
    '    exitPolicy: isLob\n      ? "FIXED_T1"\n      : isScalp\n      ? "TRAIL_AFTER_T1"',
    "LOB exit policy label",
)

replace_once(
    '      prices[result.market] = finite(\n'
    '        result.value.current,\n'
    '        (finite(result.value.best_ask) + finite(result.value.best_bid)) / 2,\n'
    '      );',
    '      prices[result.market] = finite(\n'
    '        result.value.best_bid,\n'
    '        finite(\n'
    '          result.value.current,\n'
    '          (finite(result.value.best_ask) + finite(result.value.best_bid)) / 2,\n'
    '        ),\n'
    '      );',
    "portfolio mark uses executable bid",
)

replace_once(
    'function bidDepthQuote(book: any): number {\n'
    '  return (Array.isArray(book?.bids) ? book.bids : []).reduce(\n'
    '    (total: number, level: any) =>\n'
    '      total + finite(level?.price ?? level?.[0]) * finite(level?.size ?? level?.[1]),\n'
    '    0,\n'
    '  );\n'
    '}\n',
    'function bidDepthQuote(book: any): number {\n'
    '  return (Array.isArray(book?.bids) ? book.bids : []).reduce(\n'
    '    (total: number, level: any) =>\n'
    '      total + finite(level?.price ?? level?.[0]) * finite(level?.size ?? level?.[1]),\n'
    '    0,\n'
    '  );\n'
    '}\n\n'
    '/** Quantity-aware executable sell price. If visible depth is incomplete, value the\n'
    ' * entire quantity at the lowest visible bid instead of falling back to ticker/mid. */\n'
    'function executableBidVwap(book: any, requestedQuantity: number): number {\n'
    '  const requested = Math.max(0, finite(requestedQuantity));\n'
    '  if (!(requested > 0)) return 0;\n'
    '  let remaining = requested;\n'
    '  let filled = 0;\n'
    '  let funds = 0;\n'
    '  let lowestVisibleBid = 0;\n'
    '  for (const level of Array.isArray(book?.bids) ? book.bids : []) {\n'
    '    const price = Math.max(0, finite(level?.price ?? level?.[0]));\n'
    '    const size = Math.max(0, finite(level?.size ?? level?.[1]));\n'
    '    if (!(price > 0 && size > 0)) continue;\n'
    '    lowestVisibleBid = price;\n'
    '    const take = Math.min(remaining, size);\n'
    '    funds += take * price;\n'
    '    filled += take;\n'
    '    remaining -= take;\n'
    '    if (remaining <= 1e-12) break;\n'
    '  }\n'
    '  if (filled + 1e-12 >= requested) return funds / requested;\n'
    '  return lowestVisibleBid > 0 ? lowestVisibleBid : Math.max(0, finite(book?.best_bid));\n'
    '}\n',
    "quantity-aware bid VWAP helper",
)

replace_count(
    'estimatedExitCostPct: FEE_PCT[exchange] / 100 + 0.0005,',
    'estimatedExitCostPct: FEE_PCT[exchange] / 100,',
    3,
    "remove fake extra 5bp from marks",
)

replace_once(
    '    strategy_revision: "7.1.1-LOB-45S-PROFIT-OR-5PCT",',
    '    strategy_revision: "7.1.5-EXECUTABLE-NET-EXIT",',
    "active strategy revision",
)

replace_once(
    '    const targetPct = decision.targetBps / 10000;\n'
    '    // v7.1.3: every target must remain at least one quote-currency unit profitable\n'
    '    // after round-trip fees and a conservative p95 exit-price shortfall.\n'
    '    const targetFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);\n'
    '    const targetShortfallBps = exchange === "upbit" ? 20 : 50;\n'
    '    const targetEntryCost = entryPrice * quantity * (1 + targetFeeRate);\n'
    '    const netOneTargetPrice = ((targetEntryCost + 1) / (quantity * (1 - targetFeeRate))) /\n'
    '      (1 - targetShortfallBps / 10000);\n'
    '    const stopPct = 0.03;\n'
    '    scalpStopPrice = tickRound(entryPrice * (1 - stopPct), rules.price_tick, "down");\n'
    '    scalpTarget1 = tickRound(\n'
    '      Math.max(entryPrice * (1 + targetPct), netOneTargetPrice),\n'
    '      rules.price_tick,\n'
    '      "up",\n'
    '    );',
    '    const targetPct = decision.targetBps / 10000;\n'
    '    // The target only needs to clear actual entry/exit fees plus one minimum\n'
    '    // quote-currency display unit. No second synthetic price haircut is applied.\n'
    '    const targetFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);\n'
    '    const targetEntryFeeRate = exchange === "upbit" ? targetFeeRate : 0;\n'
    '    const targetProfitBufferQuote = exchange === "upbit" ? 1 : 0.01;\n'
    '    const targetEntryCost = entryPrice * quantity * (1 + targetEntryFeeRate);\n'
    '    const netPositiveTargetPrice = (targetEntryCost + targetProfitBufferQuote) /\n'
    '      (quantity * (1 - targetFeeRate));\n'
    '    const stopPct = 0.03;\n'
    '    scalpStopPrice = tickRound(entryPrice * (1 - stopPct), rules.price_tick, "down");\n'
    '    scalpTarget1 = tickRound(\n'
    '      Math.max(entryPrice * (1 + targetPct), netPositiveTargetPrice),\n'
    '      rules.price_tick,\n'
    '      "up",\n'
    '    );',
    "target economics",
)

replace_once(
    'function restingTpEnabled(settings: TradingSettings, position: Position): boolean {\n'
    '  return isScalpStrategy((settings as any).strategy) &&\n'
    '    (settings as any).scalp_resting_tp === true &&\n'
    '    !position.is_paper;\n'
    '}',
    'function restingTpEnabled(settings: TradingSettings, position: Position): boolean {\n'
    '  const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));\n'
    '  const heldSeconds = Number.isFinite(openedAt)\n'
    '    ? Math.max(0, (Date.now() - openedAt) / 1000)\n'
    '    : 0;\n'
    '  return isScalpStrategy((settings as any).strategy) &&\n'
    '    (settings as any).scalp_resting_tp === true &&\n'
    '    !position.is_paper &&\n'
    '    heldSeconds >= 60;\n'
    '}',
    "delay resting TP until 60 seconds",
)

replace_once(
    '      if (restingTpEnabled(settings, position)) {\n'
    '        position = await syncRestingTakeProfit(position, cycleId);',
    '      if (restingTpEnabled(settings, position)) {\n'
    '        if (!restingTpIdentifier(position)) {\n'
    '          position = await placeRestingTakeProfit(position, settings, cycleId);\n'
    '        }\n'
    '        position = await syncRestingTakeProfit(position, cycleId);',
    "place resting TP only after lock",
)

replace_once(
    '      const current = prices[position.market];',
    '      const current = executableBidVwap(\n'
    '        books[position.market],\n'
    '        finite(position.remaining_quantity),\n'
    '      ) || prices[position.market];',
    "position executable price",
)

replace_once(
    '      const peak = Math.max(current, finite(position.peak_price, position.average_entry_price));\n'
    '      const trough = Math.min(current, finite(position.trough_price, position.average_entry_price));\n'
    '      const values: JsonRecord = { peak_price: peak, trough_price: trough };',
    '      const peak = Math.max(current, finite(position.peak_price, position.average_entry_price));\n'
    '      const trough = Math.min(current, finite(position.trough_price, position.average_entry_price));\n'
    '      const liveMark = calculateExposureLedger({\n'
    '        state: position.state,\n'
    '        remainingQuantity: position.remaining_quantity,\n'
    '        reservedQuote: position.reserved_quote,\n'
    '        reservedQuantity: position.reserved_quantity,\n'
    '        averageEntryPrice: position.average_entry_price,\n'
    '        plannedEntryPrice: position.planned_entry_price,\n'
    '        currentPrice: current,\n'
    '        realizedCostQuote: position.realized_cost_quote,\n'
    '        realizedProceedsQuote: position.realized_proceeds_quote,\n'
    '        paidFeesQuote: position.paid_fees_quote,\n'
    '        residualValueQuote: position.residual_value_quote,\n'
    '        estimatedExitCostPct: FEE_PCT[exchange] / 100,\n'
    '      });\n'
    '      const markCostBasis = Math.max(\n'
    '        1e-12,\n'
    '        finite(position.realized_cost_quote) + finite(position.paid_fees_quote),\n'
    '      );\n'
    '      const lobPosition = isLobStrategy(position.metadata?.lob_signal?.strategy);\n'
    '      const values: JsonRecord = {\n'
    '        peak_price: peak,\n'
    '        trough_price: trough,\n'
    '        marked_pnl_quote: liveMark.markedNetPnlQuote,\n'
    '        metadata: lobPosition\n'
    '          ? {\n'
    '            ...(position.metadata || {}),\n'
    '            active_exit_revision: VERSION,\n'
    '            exit_policy_revision: VERSION,\n'
    '            live_mark: {\n'
    '              revision: VERSION,\n'
    '              price_basis: "QUANTITY_AWARE_EXECUTABLE_BID",\n'
    '              executable_price: current,\n'
    '              quantity: finite(position.remaining_quantity),\n'
    '              gross_return_pct: finite(position.average_entry_price) > 0\n'
    '                ? (current / finite(position.average_entry_price) - 1) * 100\n'
    '                : 0,\n'
    '              fee_net_pnl_quote: liveMark.markedNetPnlQuote,\n'
    '              fee_net_return_pct: liveMark.markedNetPnlQuote / markCostBasis * 100,\n'
    '              measured_at: new Date().toISOString(),\n'
    '            },\n'
    '          }\n'
    '          : position.metadata,\n'
    '      };',
    "persist executable mark",
)

replace_once(
    '      if (\n'
    '        peak !== finite(position.peak_price) || trough !== finite(position.trough_price) ||\n'
    '        values.trailing_stop\n'
    '      ) {\n'
    '        position = {\n'
    '          ...position,\n'
    '          ...(await patch("trading_positions", `id=eq.${position.id}`, values))[0],\n'
    '        };\n'
    '      }',
    '      position = {\n'
    '        ...position,\n'
    '        ...(await patch("trading_positions", `id=eq.${position.id}`, values))[0],\n'
    '      };',
    "refresh mark every monitor cycle",
)

replace_once(
    '      const lobNetProfitQuote = lobExitNotional * (1 - lobFeeRate) -\n'
    '        lobEntryNotional * (1 + lobFeeRate);',
    '      const lobEntryFeeRate = exchange === "upbit" ? lobFeeRate : 0;\n'
    '      const lobNetProfitQuote = lobExitNotional * (1 - lobFeeRate) -\n'
    '        lobEntryNotional * (1 + lobEntryFeeRate);',
    "early LOB net calculation",
)

replace_once(
    '        const policyFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);\n'
    '        const policyQuantity = Math.max(0, finite(position.remaining_quantity));\n'
    '        const policyShortfallBps = exchange === "upbit" ? 20 : 50;\n'
    '        const guardedExitPrice = current * (1 - policyShortfallBps / 10000);\n'
    '        const policyEntryCost = lobEntryPrice * policyQuantity * (1 + policyFeeRate);\n'
    '        const guardedNetProfitQuote = guardedExitPrice * policyQuantity * (1 - policyFeeRate) -\n'
    '          policyEntryCost;',
    '        const policyFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);\n'
    '        const policyEntryFeeRate = exchange === "upbit" ? policyFeeRate : 0;\n'
    '        const policyQuantity = Math.max(0, finite(position.remaining_quantity));\n'
    '        const guardedExitPrice = current;\n'
    '        const policyEntryCost = lobEntryPrice * policyQuantity *\n'
    '          (1 + policyEntryFeeRate);\n'
    '        const guardedNetProfitQuote = guardedExitPrice * policyQuantity *\n'
    '            (1 - policyFeeRate) -\n'
    '          policyEntryCost;',
    "final LOB net calculation",
)

replace_once(
    '        if (heldSeconds < 60) {\n'
    '          decision = targetRequested\n'
    '            ? {\n'
    '              action: "TARGET_1",\n'
    '              fraction: 1,\n'
    '              reason: "lob:pre-60-target-only",\n'
    '            }\n'
    '            : {\n'
    '              action: "NONE",\n'
    '              fraction: 0,\n'
    '              reason: "lob:pre-60-sell-lock-except-target",\n'
    '            };',
    '        if (heldSeconds < 60) {\n'
    '          decision = {\n'
    '            action: "NONE",\n'
    '            fraction: 0,\n'
    '            reason: "lob:pre-60-absolute-sell-lock",\n'
    '          };',
    "absolute first-minute lock",
)

replace_once(
    '                  revision: "7.1.4-VOLATILITY-AWARE-EXIT",',
    '                  revision: "7.1.5-EXECUTABLE-NET-EXIT",',
    "exit policy quote revision",
)

replace_once(
    '    unrealized += qty * (current - entry);',
    '    unrealized += calculateExposureLedger({\n'
    '      state: position.state,\n'
    '      remainingQuantity: position.remaining_quantity,\n'
    '      averageEntryPrice: position.average_entry_price,\n'
    '      plannedEntryPrice: position.planned_entry_price,\n'
    '      currentPrice: current,\n'
    '      realizedCostQuote: position.realized_cost_quote,\n'
    '      realizedProceedsQuote: position.realized_proceeds_quote,\n'
    '      paidFeesQuote: position.paid_fees_quote,\n'
    '      residualValueQuote: position.residual_value_quote,\n'
    '      estimatedExitCostPct: FEE_PCT[exchange] / 100,\n'
    '    }).markedNetPnlQuote;',
    "account snapshot fee-net mark",
)

replace_once(
    'async function status(settings: TradingSettings & JsonRecord) {',
    'function displayPosition(row: any): any {\n'
    '  const lob = isLobStrategy(row?.metadata?.lob_signal?.strategy);\n'
    '  if (!lob) return row;\n'
    '  const revision = String(\n'
    '    row?.metadata?.active_exit_revision ||\n'
    '      row?.metadata?.exit_policy_revision ||\n'
    '      "7.1.5-EXECUTABLE-NET-EXIT",\n'
    '  );\n'
    '  return {\n'
    '    ...row,\n'
    '    exit_policy: "EXECUTABLE_NET_EXIT",\n'
    '    strategy_revision: revision,\n'
    '    stop_bps: 300,\n'
    '    marked_pnl_quote: finite(\n'
    '      row?.marked_pnl_quote,\n'
    '      finite(row?.metadata?.live_mark?.fee_net_pnl_quote),\n'
    '    ),\n'
    '    active_exit_policy: {\n'
    '      revision,\n'
    '      price_basis: "QUANTITY_AWARE_EXECUTABLE_BID",\n'
    '      minimum_hold_seconds: 60,\n'
    '      hard_stop_after_seconds: 180,\n'
    '      hard_stop_return_pct: -3,\n'
    '      hard_stop_price: row?.stop_price,\n'
    '      marked_pnl_quote: finite(\n'
    '        row?.marked_pnl_quote,\n'
    '        finite(row?.metadata?.live_mark?.fee_net_pnl_quote),\n'
    '      ),\n'
    '      measured_at: row?.metadata?.live_mark?.measured_at || null,\n'
    '    },\n'
    '    historical_entry_signal: {\n'
    '      engine_version: row?.metadata?.engine_version || null,\n'
    '      strategy_revision: row?.metadata?.lob_signal?.strategy_revision || null,\n'
    '      stop_bps: row?.metadata?.lob_signal?.stop_bps ?? null,\n'
    '    },\n'
    '  };\n'
    '}\n\n'
    'async function status(settings: TradingSettings & JsonRecord) {',
    "status display normalizer",
)

replace_once(
    '    positions: (positions || []).filter((row: any) =>\n'
    '      row.state === "ENTRY_PENDING" || finite(row.remaining_quantity) > 0 ||\n'
    '      finite(row.reserved_quote) > 0\n'
    '    ),',
    '    positions: (positions || []).filter((row: any) =>\n'
    '      row.state === "ENTRY_PENDING" || finite(row.remaining_quantity) > 0 ||\n'
    '      finite(row.reserved_quote) > 0\n'
    '    ).map(displayPosition),',
    "normalize active status positions",
)
replace_once(
    '    recently_closed_positions: closedPositions,',
    '    recently_closed_positions: (closedPositions || []).map(displayPosition),',
    "normalize closed status positions",
)

ENGINE.write_text(text, encoding="utf-8")

required = [
    'const VERSION = "7.1.5-EXECUTABLE-NET-EXIT";',
    'lob:pre-60-absolute-sell-lock',
    'function executableBidVwap',
    'marked_pnl_quote: liveMark.markedNetPnlQuote',
    'targetProfitBufferQuote = exchange === "upbit" ? 1 : 0.01',
    'exit_policy: "EXECUTABLE_NET_EXIT"',
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("v7.1.5 hotfix validation failed: " + ", ".join(missing))

for item in required:
    print("PASS:", item)
