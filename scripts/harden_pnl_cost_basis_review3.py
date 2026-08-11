from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"unexpected source count in {path}: expected={expected} actual={count} fragment={old[:90]!r}")
    p.write_text(text.replace(old, new))


ledger = "supabase/functions/market-autotrader/exposure-ledger.ts"
replace_exact(
    ledger,
    "  const markedCostBasisQuote = persistedCostBasis > 0 ? persistedCostBasis : initial * entry;",
    "  // Persisted entry funds are canonical when present, while initial × average entry is\n"
    "  // the live fallback used by futures rows that can temporarily carry zero persisted cost.\n"
    "  // Taking the larger value also prevents a partially-exited row from ever treating only\n"
    "  // the sold slice as the cost basis of the whole economic position.\n"
    "  const markedCostBasisQuote = Math.max(persistedCostBasis, initial * entry);",
)

index = "supabase/functions/market-autotrader/index.ts"
replace_exact(
    index,
    "function exactUnrecoveredPositionCost(position: Position): number {\n"
    "  return Math.max(\n"
    "    0,\n"
    "    finite(position.realized_cost_quote) + finite(position.paid_fees_quote) -\n"
    "      finite(position.realized_proceeds_quote),\n"
    "  );\n"
    "}",
    "function positionEntryCostBasis(position: Position): number {\n"
    "  const persisted = Math.max(0, finite(position.realized_cost_quote));\n"
    "  const derived = Math.max(0, finite(position.initial_quantity)) *\n"
    "    Math.max(0, finite(position.average_entry_price, position.planned_entry_price));\n"
    "  // Spot normally persists exact executed funds; futures reconciliation can leave the\n"
    "  // field at zero while the live contract is already open. Never let that transient\n"
    "  // representation turn a real principal into zero cost.\n"
    "  return Math.max(persisted, derived);\n"
    "}\n\n"
    "function exactUnrecoveredPositionCost(position: Position): number {\n"
    "  return Math.max(\n"
    "    0,\n"
    "    positionEntryCostBasis(position) + finite(position.paid_fees_quote) -\n"
    "      finite(position.realized_proceeds_quote),\n"
    "  );\n"
    "}",
)
replace_exact(
    index,
    "buyPrincipalQuote: finite(position.realized_cost_quote),",
    "buyPrincipalQuote: positionEntryCostBasis(position),",
    expected=2,
)
replace_exact(
    index,
    "      state: row.state,\n      remainingQuantity: row.remaining_quantity,",
    "      state: row.state,\n      initialQuantity: row.initial_quantity,\n      remainingQuantity: row.remaining_quantity,",
    expected=3,
)
replace_exact(
    index,
    "      state: position.state,\n      remainingQuantity: position.remaining_quantity,",
    "      state: position.state,\n      initialQuantity: position.initial_quantity,\n      remainingQuantity: position.remaining_quantity,",
)
replace_exact(
    index,
    "        state: position.state,\n        remainingQuantity: position.remaining_quantity,",
    "        state: position.state,\n        initialQuantity: position.initial_quantity,\n        remainingQuantity: position.remaining_quantity,",
)

test = Path("supabase/functions/market-autotrader/exposure-ledger.test.ts")
test.write_text(r'''import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateExposureLedger,
  reservationAfterFill,
} from "./exposure-ledger.ts";

// Legacy regression coverage retained from the original exposure ledger tests.
Deno.test("pending maker reservation consumes exposure before it fills", () => {
  const out = calculateExposureLedger({
    state: "ENTRY_PENDING",
    reservedQuote: 100,
    reservedQuantity: 1,
    plannedEntryPrice: 100,
    currentPrice: 101,
  });
  assertEquals(out.filledExposureQuote, 0);
  assertEquals(out.reservedExposureQuote, 101);
  assertEquals(out.totalExposureQuote, 101);
});

Deno.test("winning open position cannot manufacture free allocation", () => {
  const out = calculateExposureLedger({
    state: "OPEN",
    initialQuantity: 2,
    remainingQuantity: 2,
    averageEntryPrice: 100,
    currentPrice: 120,
    realizedCostQuote: 200,
    paidFeesQuote: 0.2,
    estimatedExitCostPct: 0.001,
  });
  assertEquals(out.filledExposureQuote, 240);
  assertAlmostEquals(out.markedNetPnlQuote, 39.56, 1e-12);
});

Deno.test("partial fill releases only the executed reservation", () => {
  assertEquals(reservationAfterFill(100, 10, 40, 4), {
    reservedQuote: 60,
    reservedQuantity: 6,
  });
});

Deno.test("open futures mark uses live price and full entry basis when persisted cost is zero", () => {
  const result = calculateExposureLedger({
    state: "OPEN",
    initialQuantity: 704,
    remainingQuantity: 704,
    averageEntryPrice: 0.2133,
    markPrice: 0.212142755,
    realizedCostQuote: 0,
    realizedProceedsQuote: 0,
    paidFeesQuote: 0,
    estimatedExitCostPct: 0.0005,
  });

  assertAlmostEquals(result.markedCostBasisQuote, 150.1632, 1e-9);
  assertAlmostEquals(result.liquidationValueQuote, 149.34849952, 1e-9);
  assertAlmostEquals(result.markedNetPnlQuote, -0.88937472976, 1e-9);
});

Deno.test("partial futures position keeps original principal in economic PnL", () => {
  const result = calculateExposureLedger({
    state: "OPEN",
    initialQuantity: 100,
    remainingQuantity: 50,
    averageEntryPrice: 1,
    currentPrice: 1.10,
    // Defensive case: a ledger implementation reports only a 50 quote partial basis.
    realizedCostQuote: 50,
    realizedProceedsQuote: 55,
    paidFeesQuote: 0.10,
    estimatedExitCostPct: 0,
  });
  assertEquals(result.markedCostBasisQuote, 100);
  assertAlmostEquals(result.markedNetPnlQuote, 9.9, 1e-12);
});

Deno.test("spot persisted cost basis remains canonical", () => {
  const result = calculateExposureLedger({
    state: "OPEN",
    initialQuantity: 1,
    remainingQuantity: 1,
    averageEntryPrice: 40,
    currentPrice: 41,
    realizedCostQuote: 40,
    realizedProceedsQuote: 0,
    paidFeesQuote: 0.03,
    estimatedExitCostPct: 0.001,
  });
  assertEquals(result.markedCostBasisQuote, 40);
  assertAlmostEquals(result.markedNetPnlQuote, 0.929, 1e-12);
});

Deno.test("currentPrice remains preferred over markPrice for existing callers", () => {
  const result = calculateExposureLedger({
    initialQuantity: 2,
    remainingQuantity: 2,
    averageEntryPrice: 10,
    currentPrice: 11,
    markPrice: 99,
    realizedCostQuote: 20,
  });
  assertEquals(result.liquidationValueQuote, 22);
  assertEquals(result.markedNetPnlQuote, 2);
});
''')

print("review3 cost-basis hardening applied")
