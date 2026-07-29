import { readdirSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures = [];
const passed = [];
const check = (name, condition) => (condition ? passed : failures).push(name);

const version = "7.0.3-RESIDUAL-BALANCE-LEDGER-INTEGRITY";
const dashboardRevision = "7.0.0-r2-TOP10-LOB-ONLY-DASHBOARD-RESTORE";
const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrationVersions = migrations.map((name) => name.split("_", 1)[0]);
const scanner = read("supabase/functions/market-scanner/index.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const trader = read("supabase/functions/market-autotrader/index.ts");
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
const deployWorkflow = read(".github/workflows/main.deploy-supabase.yml");
const dashboardWorkflow = read(".github/workflows/validate-dashboard.yml");

check(
  "scanner, trader, engine and dashboard agree on v7",
  [scanner, trader, engine, dashboard, dashboardConfig].every((source) => source.includes(version)),
);
check(
  "each exchange fixes its 24h gainer Top 10 before flow exclusions",
  scanner.includes("const topTen = heatSample.heat.slice(0, 10)") &&
    scanner.includes("const selectedRows = heatRanked") &&
    scanner.includes("ranking: heatSample.heat.slice(0, 10)") &&
    scanner.includes("TOP10_24H_GAINERS_LOB_ONLY"),
);
check(
  "every live Top-10 LOB scan observes for at least 20 seconds",
  scanner.includes("const MIN_DYNAMIC_OBSERVATION_MS = 20_000;") &&
    scanner.includes('finite(Deno.env.get("LOB_OBSERVATION_MS"), 20_000)') &&
    scanner.includes('lob: "Top 10 중 흐름 유지 종목 최소 20초 실시간 호가·체결"') &&
    engine.includes("const DYNAMIC_MIN_OBSERVATION_MS = 20_000;") &&
    deployWorkflow.includes('"LOB_OBSERVATION_MS=20000"'),
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
  "dashboard cache revision and visible strategy are current",
  dashboardConfig.includes(`const UI_VERSION = "${version}"`) &&
    dashboardConfig.includes(`const DASHBOARD_REVISION = "${dashboardRevision}"`) &&
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
    deployWorkflow.includes("202607290021_top10_lob_only_v700.sql") &&
    deployWorkflow.includes("20260729230827_tp_settlement_integrity_v701.sql") &&
    deployWorkflow.includes(
      "20260729232553_profit_protection_constraint_integrity_v702.sql",
    ) &&
    deployWorkflow.includes(
      "20260729233331_residual_balance_ledger_integrity_v703.sql",
    ),
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
