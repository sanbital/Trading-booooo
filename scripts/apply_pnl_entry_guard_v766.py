from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected source fragment missing: {path}: {old[:100]!r}")
    if text.count(old) != 1:
        raise SystemExit(f"source fragment is not unique: {path}: count={text.count(old)}")
    p.write_text(text.replace(old, new, 1))


ledger = "supabase/functions/market-autotrader/exposure-ledger.ts"
replace_once(
    ledger,
    "  remainingQuantity?: number | null;\n  reservedQuote?: number | null;",
    "  initialQuantity?: number | null;\n  remainingQuantity?: number | null;\n  reservedQuote?: number | null;",
)
replace_once(
    ledger,
    "  currentPrice?: number | null;\n  realizedCostQuote?: number | null;",
    "  currentPrice?: number | null;\n  /** Backward-compatible alias used by the live monitor call sites. */\n  markPrice?: number | null;\n  realizedCostQuote?: number | null;",
)
replace_once(
    ledger,
    "  estimatedExitCostQuote: number;\n  markedNetPnlQuote: number;",
    "  estimatedExitCostQuote: number;\n  /** Full economic entry basis used for mark-to-market PnL. */\n  markedCostBasisQuote: number;\n  markedNetPnlQuote: number;",
)
replace_once(
    ledger,
    "  const remaining = Math.max(0, finite(row.remainingQuantity));\n  const entry = Math.max(0, finite(row.averageEntryPrice, finite(row.plannedEntryPrice)));\n  const current = Math.max(0, finite(row.currentPrice, entry));",
    "  const initial = Math.max(0, finite(row.initialQuantity, finite(row.remainingQuantity)));\n  const remaining = Math.max(0, finite(row.remainingQuantity));\n  const entry = Math.max(0, finite(row.averageEntryPrice, finite(row.plannedEntryPrice)));\n  // Some live monitor paths historically called this field markPrice while reservation\n  // paths used currentPrice. Accept both explicitly so a live mark can never silently\n  // fall back to the entry price.\n  const current = Math.max(0, finite(row.currentPrice, finite(row.markPrice, entry)));",
)
replace_once(
    ledger,
    "  const liquidationValueQuote = filledCurrentValue + Math.max(0, finite(row.residualValueQuote));\n  const markedNetPnlQuote = Math.max(0, finite(row.realizedProceedsQuote)) +\n    liquidationValueQuote -\n    Math.max(0, finite(row.realizedCostQuote)) -",
    "  const liquidationValueQuote = filledCurrentValue + Math.max(0, finite(row.residualValueQuote));\n  const persistedCostBasis = Math.max(0, finite(row.realizedCostQuote));\n  // Futures OPEN rows intentionally do not book realized_cost_quote until reconciliation.\n  // Their economic basis still exists: it is the filled contract quantity at average entry.\n  // Spot rows already persist realized_cost_quote, so that canonical value continues to win.\n  const markedCostBasisQuote = persistedCostBasis > 0\n    ? persistedCostBasis\n    : initial * entry;\n  const markedNetPnlQuote = Math.max(0, finite(row.realizedProceedsQuote)) +\n    liquidationValueQuote -\n    markedCostBasisQuote -",
)
replace_once(
    ledger,
    "    estimatedExitCostQuote,\n    markedNetPnlQuote,",
    "    estimatedExitCostQuote,\n    markedCostBasisQuote,\n    markedNetPnlQuote,",
)

index = "supabase/functions/market-autotrader/index.ts"
replace_once(
    index,
    "      const markCostBasis = Math.max(\n        1e-12,\n        finite(position.realized_cost_quote) + finite(position.paid_fees_quote),\n      );",
    "      const markCostBasis = Math.max(\n        1e-12,\n        liveMark.markedCostBasisQuote + finite(position.paid_fees_quote),\n      );",
)

entry = "supabase/functions/_shared/lob/entry.ts"
replace_once(
    entry,
    "/** Continuation families that lost money on live fills; overridable via LobEntryConfig. */\nconst DEFAULT_BLOCKED_LOB_PATTERNS: string[] = [];",
    "/** Continuation families that lost money on live fills; overridable via LobEntryConfig.\n * MOMENTUM_CONTINUATION is disabled as a standalone primary pattern after live-fill review:\n * both spot and futures samples were net-negative. Confirmation families remain available.\n */\nconst DEFAULT_BLOCKED_LOB_PATTERNS: string[] = [\"MOMENTUM_CONTINUATION\"];",
)

test = Path("supabase/functions/market-autotrader/exposure-ledger.test.ts")
test.write_text(r'''import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateExposureLedger } from "./exposure-ledger.ts";

Deno.test("open futures mark uses markPrice and filled entry basis when realized cost is zero", () => {
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

print("v7.6.6 accounting/entry guard patch applied")
