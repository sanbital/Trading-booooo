from pathlib import Path

SCANNER = Path("supabase/functions/market-scanner/index.ts")
SELF = Path("validation/apply-v706-per-symbol-observation.py")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_n(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches, found {count}")
    return text.replace(old, new)


source = SCANNER.read_text(encoding="utf-8")

source = replace_once(
    source,
    "const MAX_DYNAMIC_OBSERVATION_MS = 60_000;\n"
    "const MAX_DYNAMIC_BOOK_EVENTS = 1_200;",
    "const MAX_DYNAMIC_OBSERVATION_MS = 60_000;\n"
    "// Every symbol must receive its own full 30-second wall-clock observation window.\n"
    "// The global socket-open timer alone is insufficient because a symbol's first frame can arrive late.\n"
    "const REQUIRED_PER_MARKET_OBSERVATION_MS = 30_000;\n"
    "const DYNAMIC_STREAM_HARD_TIMEOUT_BUFFER_MS = 35_000;\n"
    "const DYNAMIC_COVERAGE_POLL_MS = 250;\n"
    "const MAX_DYNAMIC_BOOK_EVENTS = 1_200;",
    "observation constants",
)

source = replace_once(
    source,
    "type DynamicStreamBundle = {\n"
    "  snapshots: Map<string, OrderbookSnapshot[]>;\n"
    "  trades: Map<string, TradeRow[]>;\n"
    "};",
    "type DynamicMarketCoverage = {\n"
    "  firstBookReceivedAt: number | null;\n"
    "  lastBookReceivedAt: number | null;\n"
    "  observedForMs: number;\n"
    "  complete: boolean;\n"
    "};\n"
    "\n"
    "type DynamicStreamBundle = {\n"
    "  snapshots: Map<string, OrderbookSnapshot[]>;\n"
    "  trades: Map<string, TradeRow[]>;\n"
    "  coverage: Map<string, DynamicMarketCoverage>;\n"
    "};",
    "dynamic stream type",
)

source = replace_once(
    source,
    "function normalizeStreamMarket(value: unknown): string {\n"
    "  return String(value || \"\").toUpperCase().replace(/\\.(1|5|15|30)$/, \"\");\n"
    "}",
    "function normalizeStreamMarket(value: unknown): string {\n"
    "  return String(value || \"\").toUpperCase().replace(/\\.(1|5|15|30)$/, \"\");\n"
    "}\n"
    "\n"
    "function initializeDynamicCoverage(\n"
    "  markets: string[],\n"
    "): Map<string, DynamicMarketCoverage> {\n"
    "  return new Map(markets.map((market) => [market, {\n"
    "    firstBookReceivedAt: null,\n"
    "    lastBookReceivedAt: null,\n"
    "    observedForMs: 0,\n"
    "    complete: false,\n"
    "  }]));\n"
    "}\n"
    "\n"
    "function recordDynamicBookFrame(\n"
    "  coverage: Map<string, DynamicMarketCoverage>,\n"
    "  market: string,\n"
    "  receivedAt: number,\n"
    "): void {\n"
    "  const state = coverage.get(market);\n"
    "  if (!state) return;\n"
    "  if (state.firstBookReceivedAt == null) state.firstBookReceivedAt = receivedAt;\n"
    "  state.lastBookReceivedAt = receivedAt;\n"
    "}\n"
    "\n"
    "function refreshDynamicCoverage(\n"
    "  coverage: Map<string, DynamicMarketCoverage>,\n"
    "  now = Date.now(),\n"
    "): void {\n"
    "  for (const state of coverage.values()) {\n"
    "    state.observedForMs = state.firstBookReceivedAt == null\n"
    "      ? 0\n"
    "      : Math.max(0, now - state.firstBookReceivedAt);\n"
    "    state.complete = state.observedForMs >= REQUIRED_PER_MARKET_OBSERVATION_MS;\n"
    "  }\n"
    "}\n"
    "\n"
    "function allDynamicMarketsCovered(\n"
    "  coverage: Map<string, DynamicMarketCoverage>,\n"
    "): boolean {\n"
    "  return coverage.size > 0 && [...coverage.values()].every((state) => state.complete);\n"
    "}",
    "coverage helpers",
)

source = replace_n(
    source,
    "  const trades = new Map(markets.map((market) => [market, [] as TradeRow[]]));\n"
    "  if (!markets.length) return Promise.resolve({ snapshots, trades });",
    "  const trades = new Map(markets.map((market) => [market, [] as TradeRow[]]));\n"
    "  const coverage = initializeDynamicCoverage(markets);\n"
    "  if (!markets.length) return Promise.resolve({ snapshots, trades, coverage });",
    2,
    "coverage initialization",
)

source = replace_n(
    source,
    "    let observationTimer: ReturnType<typeof setTimeout> | undefined;",
    "    let observationTimer: ReturnType<typeof setTimeout> | undefined;\n"
    "    let coverageTimer: ReturnType<typeof setInterval> | undefined;",
    2,
    "coverage timer declaration",
)

source = replace_n(
    source,
    "      if (observationTimer != null) clearTimeout(observationTimer);",
    "      if (observationTimer != null) clearTimeout(observationTimer);\n"
    "      if (coverageTimer != null) clearInterval(coverageTimer);",
    2,
    "coverage timer cleanup",
)

source = replace_n(
    source,
    "      else resolve({ snapshots, trades });",
    "      else {\n"
    "        refreshDynamicCoverage(coverage);\n"
    "        resolve({ snapshots, trades, coverage });\n"
    "      }",
    2,
    "coverage result",
)

source = replace_n(
    source,
    "      observationTimer = setTimeout(() => finish(), observationMs);",
    "      coverageTimer = setInterval(() => {\n"
    "        refreshDynamicCoverage(coverage);\n"
    "        if (allDynamicMarketsCovered(coverage)) finish();\n"
    "      }, DYNAMIC_COVERAGE_POLL_MS);\n"
    "      observationTimer = setTimeout(\n"
    "        () => finish(),\n"
    "        observationMs + DYNAMIC_STREAM_HARD_TIMEOUT_BUFFER_MS,\n"
    "      );",
    2,
    "per-symbol observation timer",
)

source = replace_once(
    source,
    "          if (row.type === \"orderbook\" && Array.isArray(row.orderbook_units)) {\n"
    "            const bucket = snapshots.get(market)!;\n"
    "            if (bucket.length < MAX_DYNAMIC_BOOK_EVENTS) {\n"
    "              bucket.push({ ...row, market } as OrderbookSnapshot);\n"
    "            }\n"
    "          } else if (row.type === \"trade\") {",
    "          if (row.type === \"orderbook\" && Array.isArray(row.orderbook_units)) {\n"
    "            const receivedAt = Date.now();\n"
    "            recordDynamicBookFrame(coverage, market, receivedAt);\n"
    "            const bucket = snapshots.get(market)!;\n"
    "            if (bucket.length < MAX_DYNAMIC_BOOK_EVENTS) {\n"
    "              bucket.push({ ...row, market, timestamp: receivedAt } as OrderbookSnapshot);\n"
    "            }\n"
    "          } else if (row.type === \"trade\") {",
    "Upbit local receipt coverage",
)

source = replace_once(
    source,
    "      timestamp: Number(row.E || receivedAt),",
    "      timestamp: receivedAt,",
    "Binance local receipt timestamp",
)

source = replace_once(
    source,
    "        if (stream.includes(\"@depth\") || Array.isArray(row.bids)) {\n"
    "          const snapshot = binanceOrderbookSnapshot(symbol, row);\n"
    "          const bucket = snapshots.get(symbol)!;\n"
    "          if (snapshot && bucket.length < MAX_DYNAMIC_BOOK_EVENTS) {\n"
    "            bucket.push(snapshot);\n"
    "          }\n"
    "        } else if (stream.includes(\"@trade\") || row.e === \"trade\") {",
    "        if (stream.includes(\"@depth\") || Array.isArray(row.bids)) {\n"
    "          const receivedAt = Date.now();\n"
    "          const snapshot = binanceOrderbookSnapshot(symbol, row, receivedAt);\n"
    "          recordDynamicBookFrame(coverage, symbol, receivedAt);\n"
    "          const bucket = snapshots.get(symbol)!;\n"
    "          if (snapshot && bucket.length < MAX_DYNAMIC_BOOK_EVENTS) {\n"
    "            bucket.push(snapshot);\n"
    "          }\n"
    "        } else if (stream.includes(\"@trade\") || row.e === \"trade\") {",
    "Binance local receipt coverage",
)

source = replace_n(
    source,
    "      const streamedBooks = dynamic.snapshots.get(market) || [];\n"
    "      const streamedTrades = dynamic.trades.get(market) || [];\n"
    "      if (streamedBooks.length >= 2) {\n"
    "        snapshots.set(market, streamedBooks);\n"
    "        websocketMarkets++;\n"
    "      }\n"
    "      if (streamedTrades.length) {\n"
    "        trades.set(market, [\n"
    "          ...(trades.get(market) || []),\n"
    "          ...streamedTrades,\n"
    "        ]);\n"
    "      }",
    "      const streamedBooks = dynamic.snapshots.get(market) || [];\n"
    "      const streamedTrades = dynamic.trades.get(market) || [];\n"
    "      const marketCoverage = dynamic.coverage.get(market);\n"
    "      if (marketCoverage?.complete && streamedBooks.length >= 2) {\n"
    "        snapshots.set(market, streamedBooks);\n"
    "        websocketMarkets++;\n"
    "        if (streamedTrades.length) {\n"
    "          trades.set(market, [\n"
    "            ...(trades.get(market) || []),\n"
    "            ...streamedTrades,\n"
    "          ]);\n"
    "        }\n"
    "      }",
    2,
    "complete coverage admission",
)

SCANNER.write_text(source, encoding="utf-8")
SELF.unlink()
