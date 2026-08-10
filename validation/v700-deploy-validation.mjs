import { readdirSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures = [];
const passed = [];
const check = (name, condition) => (condition ? passed : failures).push(name);

// This script runs on every dashboard push and exits non-zero, so pinning release
// literals here turned each deliberate version bump into a red build. The engine is the
// single source of truth and everything else is checked for agreement with it.
const engineSource = readFileSync(
  new URL("../supabase/functions/market-scanner/engine.ts", import.meta.url),
  "utf8",
);
const version = engineSource.match(/ENGINE_VERSION = "([^"]+)"/)?.[1];
const dashboardRevision = readFileSync(
  new URL("../docs/config.js", import.meta.url),
  "utf8",
).match(/const DASHBOARD_REVISION = "([^"]+)"/)?.[1];
const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrationVersions = migrations.map((name) => name.split("_", 1)[0]);
const scanner = read("supabase/functions/market-scanner/index.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const trader = read("supabase/functions/market-autotrader/index.ts");
const traderCore = read("supabase/functions/market-autotrader/core.ts");
const traderCoreTest = read("supabase/functions/market-autotrader/core.test.ts");
const entry = read("supabase/functions/_shared/lob/entry.ts");
const dashboard = read("docs/index.html");
const dashboardConfig = read("docs/config.js");
const dashboardJs = read("docs/app.js");
const dashboardTest = read("docs/version-runtime.test.mjs");
const migration = read("supabase/migrations/202607290021_top10_lob_only_v700.sql");
const settlementMigration = read(
  "supabase/migrations/20260729230827_tp_settlement_integrity_v701.sql",
);
const profitProtectionMigration = read(
  "supabase/migrations/20260729232553_profit_protection_constraint_integrity_v702.sql",
);
const residualLedgerMigration = read(
  "supabase/migrations/20260729233331_residual_balance_ledger_integrity_v703.sql",
);
const exitLearningMigration = read(
  "supabase/migrations/20260730031800_exit_learning_integrity_v704.sql",
);
const observationMigration = read(
  "supabase/migrations/20260730041336_min_lob_observation_30s_v705.sql",
);
const deployWorkflow = read(".github/workflows/main.deploy-supabase.yml");
const dashboardWorkflow = read(".github/workflows/validate-dashboard.yml");

check(
  // The scanner entrypoint imports ENGINE_VERSION instead of repeating the literal, which
  // is the behaviour we want everywhere; requiring the string to appear in that file
  // punished the one module that got it right. Runtimes that do declare their own copy
  // must match, and the scanner must be importing rather than declaring.
  "scanner, trader, engine and dashboard agree on the deployed version",
  Boolean(version) &&
    [trader, engine, dashboard, dashboardConfig].every((source) => source.includes(version)) &&
    scanner.includes("ENGINE_VERSION") &&
    !/const\s+(?:ENGINE_)?VERSION\s*=\s*"/.test(scanner),
);
check(
  "each exchange fixes its 24h gainer Top 10 before flow exclusions",
  scanner.includes("const topTen = heatSample.heat.slice(0, 10)") &&
    scanner.includes("const selectedRows = heatRanked") &&
    scanner.includes("ranking: heatSample.heat.slice(0, 10)") &&
    scanner.includes("TOP10_24H_GAINERS_LOB_ONLY"),
);
check(
  // The window was 30s at v7.0.5, then 15s with the Top-10 composite pressure release.
  // The scanner now pins minimum, maximum and default to the same value, so the window is
  // a fixed 15s rather than a floor an operator can raise.
  "every live Top-10 LOB scan observes a fixed 15-second window",
  scanner.includes("const MIN_DYNAMIC_OBSERVATION_MS = 15_000;") &&
    scanner.includes("const MAX_DYNAMIC_OBSERVATION_MS = 15_000;") &&
    scanner.includes("const DEFAULT_DYNAMIC_OBSERVATION_MS = 15_000;") &&
    entry.includes("minObservationMs: 15_000") &&
    // Below 15s an entry is admitted only on measured evidence, never on the clock alone.
    entry.includes("export const EFFECTIVE_OBSERVATION_MIN_MS = 13_500;") &&
    entry.includes("hasEffectiveLobObservation") &&
    entry.includes("INSUFFICIENT_EFFECTIVE_OBSERVATION"),
);
check(
  // f937230 lowered the floor from 90 to 40 USDT. The value lives in one constant, so the
  // check is that every sizing path routes through it rather than repeating a number.
  "Binance entry and partial-exit sizing route through the operator floor constant",
  /export const BINANCE_MIN_ORDER_USDT = \d+;/.test(traderCore) &&
    traderCore.includes(
      "clamp(finite(value, BINANCE_MIN_ORDER_USDT), BINANCE_MIN_ORDER_USDT, 1000)",
    ) &&
    trader.includes("merged.min_order_usdt = binanceMinOrderUsdt(merged.min_order_usdt)") &&
    trader.includes("minOrder: binanceMinOrderUsdt(settings.min_order_usdt)") &&
    trader.includes("min_order_usdt: [BINANCE_MIN_ORDER_USDT, 1000]") &&
    trader.includes("positionMinNotionalQuote(position)") &&
    traderCoreTest.includes("Binance operator minimum is the admission floor") &&
    // Both Binance venues use fill-or-kill so a futures partial fill can never leave a
    // position below the dedicated 50-USDT posted-margin floor. Upbit remains IOC.
    trader.includes('const entryTimeInForce = exchange === "upbit" ? "IOC" : "FOK"'),
);
check(
  "pre-target protected profit is executable and semantic exits remain auditable",
  traderCore.includes(
    "const trailActive = finite(position.trailing_stop) > finite(position.stop_price)",
  ) &&
    traderCoreTest.includes("pre-target profit protection trail is executable") &&
    exitLearningMigration.includes("label_trading_exit_reason_v704") &&
    exitLearningMigration.includes("LOB_INVALIDATION") &&
    exitLearningMigration.includes("SIGNAL_REVERSAL") &&
    exitLearningMigration.includes("TIMEOUT"),
);
check(
  "online learning accepts verified current engines and momentum entries",
  exitLearningMigration.includes("regexp_match(coalesce(new.engine_version") &&
    exitLearningMigration.includes("'MOMENTUM_CONTINUATION'") &&
    exitLearningMigration.includes("backfill_lob_online_learning(5000)"),
);
check(
  "account snapshots preserve exchange-observation time for cash-flow attribution",
  trader.includes("portfolioCapturedAt[exchange] = new Date().toISOString()") &&
    trader.includes("portfolioCapturedAt[exchange]") &&
    exitLearningMigration.includes("detection_mode") &&
    exitLearningMigration.includes("executed_funds_quote"),
);
check(
  "the v7 entry path is order-book and tape only",
  entry.includes("Entry permission here is current order-book/tape only") &&
    !entry.includes("trendAssist") &&
    !entry.includes("features.fundingEdge") &&
    !entry.includes('reasons.push("NET_EV_NOT_POSITIVE")') &&
    !entry.includes("PWIN_LOWER_BOUND_BELOW") &&
    !entry.includes("PFILL_LOWER_BOUND_TOO_LOW"),
);
check(
  "the database keeps one v7 Top 10 LOB admission trigger",
  migration.includes("security invoker") &&
    migration.includes("aa_trading_positions_top10_lob_only_v700") &&
    migration.includes("OUTSIDE_24H_GAINER_TOP10") &&
    migration.includes("FLOW_NOTIONAL_DECLINING") &&
    migration.includes("FLOW_TRADE_SPEED_DECLINING"),
);
check(
  "historical and modeled admission triggers are removed",
  [
    "aa0_trading_positions_momentum_ioc_v6142",
    "ab0_trading_positions_lob_momentum_v6140",
    "ab_trading_positions_lob_direction_geometry_v6123",
    "ac_trading_positions_lob_realized_edge_v6130",
    "trading_positions_lob_live_guard_v6121",
  ].every((name) => migration.includes(`drop trigger if exists ${name}`)),
);
check(
  // The fallback banner tracks the engine; the cache key tracks the dashboard release.
  // They move independently, so each is checked against its own declared source.
  "dashboard cache revision and visible strategy are current",
  Boolean(version) && Boolean(dashboardRevision) &&
    dashboardConfig.includes(`const UI_VERSION = "${version}"`) &&
    dashboard.includes(`config.js?v=${dashboardRevision}`) &&
    dashboard.includes(`app.js?v=${dashboardRevision}`) &&
    dashboard.includes("거래소별 Top 10"),
);
check(
  "dashboard DOM contract regression test remains enabled",
  dashboardTest.includes("provides every static element required by app.js") &&
    dashboardWorkflow.includes("node --test docs/version-runtime.test.mjs"),
);
check(
  "all static app.js element references exist in the dashboard HTML",
  [...dashboardJs.matchAll(/\$\("([^"]+)"\)/g)]
    .every((match) => dashboard.includes(`id="${match[1]}"`)),
);
check(
  "migration versions are globally unique",
  new Set(migrationVersions).size === migrationVersions.length,
);
check(
  "engine deployment validates v7 and applies only the idempotent current migration",
  deployWorkflow.includes("node validation/v700-deploy-validation.mjs") &&
    deployWorkflow.includes("--single-transaction") &&
    deployWorkflow.includes("20260810010000_binance_futures_lane_v760.sql") &&
    !deployWorkflow.includes("--file supabase/migrations/202607") &&
    deployWorkflow.includes('".github/workflows/main.deploy-supabase.yml"'),
);
check(
  "TP settlement is ordered before balance reconciliation and fails closed on material overfill",
  trader.includes("TP_PRE_RECONCILIATION_FAILED") &&
    trader.includes("BALANCE_REDUCTION_DEFERRED_FOR_BOT_EXIT") &&
    trader.indexOf("await syncRestingTakeProfit(position, cycleId)") <
      trader.indexOf("const open = await db(") &&
    settlementMigration.includes("materially exceeds remaining position") &&
    settlementMigration.includes(
      "v_position_fill_funds := v_fill_funds_total * v_allocation_ratio",
    ) &&
    settlementMigration.includes("TP_SETTLEMENT_ACCOUNTING_REPAIRED"),
);
check(
  "profit protection preserves the static-stop constraint and writes only the trail",
  profitProtectionMigration.includes(
    "constraint v702_static_stop_below_entry check (stop_price < average_entry_price)",
  ) &&
    profitProtectionMigration.includes("new.trailing_stop := v_candidate_stop") &&
    !profitProtectionMigration.includes("new.stop_price := v_candidate_stop") &&
    profitProtectionMigration.includes("V702_STATIC_STOP_WAS_MUTATED") &&
    profitProtectionMigration.includes("V702_PROFIT_TRAIL_WAS_NOT_RAISED"),
);
check(
  "residual repair is fail-closed and never writes to the exchange account",
  residualLedgerMigration.includes("cfg.pause_new_entries = true") &&
    residualLedgerMigration.includes("s.captured_at >= now() - interval '2 minutes'") &&
    residualLedgerMigration.includes("'RESIDUAL_BALANCE_LEDGER_REPAIRED'") &&
    residualLedgerMigration.includes("V703_RESIDUAL_RECONCILIATION_FAILED") &&
    !residualLedgerMigration.includes("create_order"),
);

for (const name of passed) console.log(`  ok   ${name}`);
for (const name of failures) console.log(`  FAIL ${name}`);
console.log(
  failures.length
    ? `\n${failures.length} FAILED`
    : `\nall ${passed.length} v7 deploy invariants hold`,
);
process.exit(failures.length ? 1 : 0);
