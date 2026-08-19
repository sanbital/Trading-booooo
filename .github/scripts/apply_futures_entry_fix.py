from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one patch anchor, found {count}")
    p.write_text(text.replace(old, new, 1))


policy = "supabase/functions/market-autotrader/futures-exit-policy.ts"
marker = "/** Return on margin: a 4% price move on 3x margin is a 12% move on the money posted. */"
helper = r'''export type FuturesAffordableEntryInput = {
  availableMarginQuote: number;
  requestedNotionalQuote: number;
  entryPrice: number;
  quantityStep: number;
  leverage: number;
  /** One-side entry commission in percentage units, e.g. 0.05 means 0.05%. */
  feePerSidePct: number;
};

export type FuturesAffordableEntry = {
  quantity: number;
  notionalQuote: number;
  marginQuote: number;
  entryFeeQuote: number;
  totalWalletDebitQuote: number;
};

/**
 * Bound a USDⓈ-M entry by the wallet amount that can fund both initial margin and
 * entry commission. Quantity is floored to the venue step, so affordability can
 * never be broken by the generic futures round-up path.
 */
export function futuresAffordableEntry(
  input: FuturesAffordableEntryInput,
): FuturesAffordableEntry {
  const available = Math.max(0, finite(input.availableMarginQuote));
  const requestedNotional = Math.max(0, finite(input.requestedNotionalQuote));
  const entryPrice = Math.max(0, finite(input.entryPrice));
  const quantityStep = Math.max(0, finite(input.quantityStep));
  const leverage = normalizeFuturesLeverage(input.leverage);
  const feeRate = Math.max(0, finite(input.feePerSidePct)) / 100;
  if (!(available > 0 && requestedNotional > 0 && entryPrice > 0)) {
    return {
      quantity: 0,
      notionalQuote: 0,
      marginQuote: 0,
      entryFeeQuote: 0,
      totalWalletDebitQuote: 0,
    };
  }

  // notional/leverage + notional*entryFeeRate <= free wallet
  const walletNotionalCap = available / (1 / leverage + feeRate);
  const targetNotional = Math.min(requestedNotional, walletNotionalCap);
  const rawQuantity = targetNotional / entryPrice;
  const quantity = quantityStep > 0
    ? Math.floor(rawQuantity / quantityStep) * quantityStep
    : rawQuantity;
  const notionalQuote = Math.max(0, quantity * entryPrice);
  const marginQuote = notionalQuote / leverage;
  const entryFeeQuote = notionalQuote * feeRate;
  return {
    quantity,
    notionalQuote,
    marginQuote,
    entryFeeQuote,
    totalWalletDebitQuote: marginQuote + entryFeeQuote,
  };
}

'''
replace_once(policy, marker, helper + marker)

test = "supabase/functions/market-autotrader/futures-exit-policy.test.ts"
replace_once(
    test,
    'import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";',
    'import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";',
)
replace_once(
    test,
    "  FUTURES_SPLIT_EXIT_THRESHOLDS,\n  futuresEntryMinimums,\n",
    "  FUTURES_SPLIT_EXIT_THRESHOLDS,\n  futuresAffordableEntry,\n  futuresEntryMinimums,\n",
)
affordability_tests = r'''Deno.test("futures entry reserves live commission headroom instead of spending 100% of wallet as margin", () => {
  const available = 66.38173576;
  const result = futuresAffordableEntry({
    availableMarginQuote: available,
    requestedNotionalQuote: available * 3,
    entryPrice: 0.5,
    quantityStep: 0.1,
    leverage: 3,
    feePerSidePct: 0.05,
  });
  assert(result.quantity > 0);
  assert(result.marginQuote >= FUTURES_MIN_ENTRY_MARGIN_USDT);
  assert(result.notionalQuote < available * 3);
  assert(result.totalWalletDebitQuote <= available + 1e-9);
});

Deno.test("futures affordable quantity floors coarse steps and never exceeds wallet capacity", () => {
  const available = 66.38173576;
  const result = futuresAffordableEntry({
    availableMarginQuote: available,
    requestedNotionalQuote: available * 3,
    entryPrice: 60_000,
    quantityStep: 0.001,
    leverage: 3,
    feePerSidePct: 0.05,
  });
  assertEquals(result.quantity, 0.003);
  assert(result.totalWalletDebitQuote <= available + 1e-9);
});

'''
replace_once(
    test,
    'Deno.test("3x converts -4/+5 price return to -12/+15 ROE", () => {',
    affordability_tests + 'Deno.test("3x converts -4/+5 price return to -12/+15 ROE", () => {',
)

engine = "supabase/functions/market-autotrader/index.ts"
replace_once(
    engine,
    "  FUTURES_SPLIT_EXIT_THRESHOLDS,\n  futuresEntryMinimums,\n",
    "  FUTURES_SPLIT_EXIT_THRESHOLDS,\n  futuresAffordableEntry,\n  futuresEntryMinimums,\n",
)

universe_helper = r'''const BINANCE_FUTURES_PUBLIC_URL = "https://fapi.binance.com";
let activeFuturesSymbolCache: { expires: number; symbols: Set<string> } | null = null;

/** Active USDⓈ-M perpetual membership is not the same thing as spot symbol grammar. */
async function activeBinanceFuturesSymbols(): Promise<Set<string>> {
  const now = Date.now();
  if (activeFuturesSymbolCache && activeFuturesSymbolCache.expires > now) {
    return activeFuturesSymbolCache.symbols;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${BINANCE_FUTURES_PUBLIC_URL}/fapi/v1/exchangeInfo`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Binance futures exchangeInfo ${response.status}: ${text.slice(0, 160)}`);
    }
    const payload = text ? JSON.parse(text) : {};
    const rows = Array.isArray(payload?.symbols) ? payload.symbols : [];
    const symbols = new Set<string>(
      rows
        .filter((row: any) =>
          String(row?.status || "") === "TRADING" &&
          String(row?.contractType || "") === "PERPETUAL" &&
          String(row?.quoteAsset || "") === "USDT"
        )
        .map((row: any) => String(row?.symbol || "").toUpperCase())
        .filter(Boolean),
    );
    if (!symbols.size) {
      throw new Error("Binance futures exchangeInfo returned no active USDT perpetuals");
    }
    activeFuturesSymbolCache = { expires: now + 5 * 60_000, symbols };
    return symbols;
  } finally {
    clearTimeout(timer);
  }
}

'''
replace_once(
    engine,
    'const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";',
    universe_helper + 'const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";',
)

old_mirror = '''  const already = new Set((existing || []).map((row) => String(row.market)));
  const clones = (spot || [])
    .filter((row) => !already.has(String(row.market)))
    .map((row) => {
'''
new_mirror = '''  const already = new Set((existing || []).map((row) => String(row.market)));
  const unmirroredSpot = (spot || []).filter((row) => !already.has(String(row.market)));
  let activeFuturesSymbols: Set<string>;
  try {
    activeFuturesSymbols = await activeBinanceFuturesSymbols();
  } catch (error) {
    await event(
      "FUTURES_UNIVERSE_REFRESH_FAILED",
      "Binance futures universe unavailable; skipping futures mirror for this scan",
      { scan_id: scanId, error: error instanceof Error ? error.message : String(error) },
      { cycleId, level: "WARNING" },
    );
    return 0;
  }
  const skippedMarkets = unmirroredSpot
    .map((row) => String(row.market || "").toUpperCase())
    .filter((market) => market && !activeFuturesSymbols.has(market));
  if (skippedMarkets.length) {
    await event(
      "FUTURES_SPOT_ONLY_SYMBOL_SKIPPED",
      "Spot BUY candidates without an active USDⓈ-M perpetual were not mirrored",
      { scan_id: scanId, markets: skippedMarkets, count: skippedMarkets.length },
      { cycleId, level: "INFO" },
    );
  }
  const clones = unmirroredSpot
    .filter((row) => activeFuturesSymbols.has(String(row.market || "").toUpperCase()))
    .map((row) => {
'''
replace_once(engine, old_mirror, new_mirror)

replace_once(
    engine,
    "  const managedAvailable = finite(managed.managedAvailableQuote);\n  const strategyExposureFraction = allocationOnly\n",
    '''  const managedAvailable = finite(managed.managedAvailableQuote);
  const futuresEntryFeePct = exchange === "binance_futures"
    ? await liveFeePct(exchange, settings)
    : 0;
  const futuresMarginCapacity = exchange === "binance_futures"
    ? managedAvailable / (1 + leverage * Math.max(0, futuresEntryFeePct) / 100)
    : managedAvailable;
  const strategyExposureFraction = allocationOnly
''',
)

replace_once(
    engine,
    '''  const allocationSizing = (entryPrice: number) => {
    const marginQuote = floorToStep(Math.min(managedAvailable, maxOrder), limits.quoteStep);
    const notionalQuote = floorToStep(marginQuote * leverage, limits.quoteStep);
''',
    '''  const allocationSizing = (entryPrice: number) => {
    const marginQuote = floorToStep(
      Math.min(futuresMarginCapacity, maxOrder),
      limits.quoteStep,
    );
    const notionalQuote = floorToStep(marginQuote * leverage, limits.quoteStep);
''',
)

replace_once(
    engine,
    '''  let quantity = entryQuantityForNotional(
    exchange,
    sizing.notionalQuote,
    entryPrice,
    rules.quantity_step || 0.00000001,
  );
''',
    '''  const entryQuantityStep = rules.quantity_step || 0.00000001;
  const executableEntryQuantity = (requestedNotionalQuote: number): number => {
    if (exchange !== "binance_futures") {
      return entryQuantityForNotional(
        exchange,
        requestedNotionalQuote,
        entryPrice,
        entryQuantityStep,
      );
    }
    return futuresAffordableEntry({
      availableMarginQuote: managedAvailable,
      requestedNotionalQuote,
      entryPrice,
      quantityStep: entryQuantityStep,
      leverage,
      feePerSidePct: futuresEntryFeePct,
    }).quantity;
  };
  let quantity = executableEntryQuantity(sizing.notionalQuote);
''',
)

replace_once(
    engine,
    '''      quantity = entryQuantityForNotional(
        exchange,
        decision.notional,
        entryPrice,
        rules.quantity_step || 0.00000001,
      );
''',
    "      quantity = executableEntryQuantity(decision.notional);\n",
)
