from pathlib import Path

TRADER = Path("supabase/functions/market-autotrader/index.ts")
OLD_VERSION = "7.1.2-LOB-CONSISTENCY"
NEW_VERSION = "7.1.3-ENTRY-DUST-GUARD"
MARKER = "ENTRY_PARTIAL_FILL_BELOW_MIN_NOTIONAL"

text = TRADER.read_text()

if MARKER in text and NEW_VERSION in text:
    print("entry dust guard already applied")
    raise SystemExit(0)

if OLD_VERSION not in text:
    raise SystemExit(f"expected source version {OLD_VERSION}")

needle = '''    const opened = await applyEntryAccounting(position, orderRow, updated.fill);\n'''
if text.count(needle) != 1:
    raise SystemExit(f"expected one entry-accounting call, found {text.count(needle)}")

guard = '''    // v7.1.3: IOC can legally return a microscopic partial fill before canceling the\n    // remainder. That quantity cannot be sold because it is below the exchange minimum.\n    // Do not promote it to an OPEN position or start an impossible exit/reconciliation\n    // loop. Preserve the real asset as residual inventory and close the position ledger.\n    const executedVolume = Math.max(0, finite(updated.fill.executedVolume));\n    const executedPrice = Math.max(0, finite(updated.fill.averagePrice));\n    const executedFunds = Math.max(\n      0,\n      finite(updated.fill.executedFunds, executedVolume * executedPrice),\n    );\n    const paidFeeQuote = Math.max(0, finite(updated.fill.paidFeeQuote));\n    const paidFeeBase = Math.max(0, finite(updated.fill.paidFeeBase));\n    const netExecutedVolume = Math.max(0, executedVolume - paidFeeBase);\n    const minimumExecutedNotional = Math.max(limits.minOrder, rules.min_notional);\n    if (executedFunds + 1e-12 < minimumExecutedNotional) {\n      const residualValueQuote = netExecutedVolume * executedPrice;\n      const now = new Date().toISOString();\n      await db("trading_residual_inventory?on_conflict=position_id", {\n        method: "POST",\n        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },\n        body: JSON.stringify({\n          position_id: position.id,\n          exchange,\n          asset: base,\n          market: candidate.market,\n          original_quantity: netExecutedVolume,\n          remaining_quantity: netExecutedVolume,\n          mark_price: executedPrice,\n          value_quote: residualValueQuote,\n          state: "AVAILABLE",\n          swept_quantity: 0,\n          realized_proceeds_quote: 0,\n          paid_fees_quote: 0,\n          paid_fee_base_quantity: paidFeeBase,\n          residual_pnl_quote: 0,\n          created_at: now,\n          updated_at: now,\n        }),\n      });\n      const closedRows = await patch("trading_positions", `id=eq.${position.id}`, {\n        state: "CLOSED",\n        initial_quantity: netExecutedVolume,\n        remaining_quantity: 0,\n        average_entry_price: executedPrice,\n        reserved_quote: 0,\n        reserved_quantity: 0,\n        reservation_expires_at: null,\n        realized_cost_quote: executedFunds,\n        paid_fees_quote: paidFeeQuote,\n        realized_pnl_quote: residualValueQuote - executedFunds - paidFeeQuote,\n        residual_quantity: netExecutedVolume,\n        residual_value_quote: residualValueQuote,\n        residual_fee_base: paidFeeBase,\n        close_reason: "ENTRY_PARTIAL_FILL_BELOW_MIN_NOTIONAL",\n        closed_at: now,\n        max_holding_at: now,\n        metadata: {\n          ...(position.metadata || {}),\n          entry_dust_guard: {\n            version: NEW_VERSION,\n            detected_at: now,\n            executed_volume: executedVolume,\n            net_executed_volume: netExecutedVolume,\n            executed_funds_quote: executedFunds,\n            minimum_executable_notional: minimumExecutedNotional,\n          },\n        },\n      });\n      await event(\n        "ENTRY_DUST_CAPTURED",\n        `${exchange}:${candidate.market} sub-minimum IOC fill moved to residual inventory`,\n        {\n          executed_volume: executedVolume,\n          net_executed_volume: netExecutedVolume,\n          executed_funds_quote: executedFunds,\n          minimum_executable_notional: minimumExecutedNotional,\n          residual_value_quote: residualValueQuote,\n        },\n        { cycleId, positionId: position.id, orderId: orderRow.id, level: "WARNING" },\n      );\n      return {\n        entered: false,\n        residual_dust: true,\n        exchange,\n        market: candidate.market,\n        position: closedRows[0] || position,\n        reason: "partial IOC fill below executable minimum moved to residual inventory",\n      };\n    }\n'''

text = text.replace(needle, guard + needle, 1)
text = text.replace(OLD_VERSION, NEW_VERSION)
TRADER.write_text(text)
print(f"patched {TRADER} -> {NEW_VERSION}")
