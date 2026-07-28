import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures = [];
const passed = [];
const check = (name, condition) => (condition ? passed : failures).push(name);
const version = "6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION";
const migrationName = "202607290002_continuous_adaptive_execution_v611.sql";
const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migration = read(`supabase/migrations/${migrationName}`);
const trader = read("supabase/functions/market-autotrader/index.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const gateway = read("gateway/server.mjs");
const performance = read("supabase/functions/market-performance/index.ts");
const calibration = read("supabase/functions/lob-calibration/index.ts");
const dashboard = read("docs/index.html");
const dashboardConfig = read("docs/config.js");
const dashboardJs = read("docs/app.js");
const online = read("supabase/functions/_shared/lob/online.ts");
const allocator = read("supabase/functions/_shared/scalp/risk-allocator.ts");

check("v6.11 migration is newest", migrations.at(-1) === migrationName);
check(
  "release versions agree",
  [trader, engine, gateway, performance, calibration, dashboard, dashboardConfig]
    .every((source) => source.includes(version)),
);
check(
  "dashboard assets use the v6.11 cache key",
  dashboard.includes("config.js?v=6.11.0-r1") &&
    dashboard.includes("app.js?v=6.11.0-r1"),
);
check(
  "Upbit operator floor is KRW 40,000 in runtime, controls, dashboard, and database",
  trader.includes("min_order_krw: 40_000") &&
    trader.includes("min_order_krw: [40000, 1_000_000]") &&
    dashboardJs.includes("Math.max(40_000, finite(settings?.min_order_krw, 40_000))") &&
    migration.includes("check (min_order_krw >= 40000)"),
);
check(
  "minimum notional lift preserves all hard ceilings",
  allocator.includes("enforceMinimumExecutableNotional") &&
    allocator.includes("decision.remainingExposureCap") &&
    allocator.includes("decision.slotCap") &&
    allocator.includes("decision.riskCap") &&
    allocator.includes("decision.depthCap") &&
    allocator.includes("decision.exchangeCap") &&
    allocator.includes("capitalSupportedSlotCount") &&
    trader.includes("enforceMinimumExecutableNotional(") &&
    trader.includes("capitalSupportedSlotCount(") &&
    trader.includes("const executableMinimumNotional =") &&
    trader.includes("rules.quantity_step"),
);
check(
  "both exchanges use KST daily boundaries",
  trader.includes("function dayBoundary(_exchange: Exchange") &&
    trader.includes("const offset = 9;"),
);
check(
  "daily loss denominator is the first KST-day total-equity snapshot",
  trader.includes("dailySeedSnapshots") &&
    trader.includes("dailySeedEquityQuote") &&
    trader.includes("dailyEconomic / dailySeedEquityQuote"),
);
check(
  "only the 30 percent daily rail remains automatic in scalp circuit settings",
  trader.includes("max_daily_loss_pct: finite((settings as any).scalp_daily_loss_pct, 30)") &&
    trader.includes("max_weekly_loss_pct: Number.MAX_SAFE_INTEGER") &&
    trader.includes("max_consecutive_losses: Number.MAX_SAFE_INTEGER") &&
    migration.includes("scalp_daily_loss_pct = 30"),
);
check(
  "reconciliation and gateway degradation cannot latch a global pause",
  !trader.includes("if (decision.pauseNewEntries)") &&
    !trader.includes("const systemic = vanishedAssets.size") &&
    trader.includes("GATEWAY_DEGRADED_NO_GLOBAL_PAUSE") &&
    trader.includes('scope: "ASSET_ONLY"'),
);
check(
  "LOB spread uses database policy instead of the hidden gateway environment cap",
  trader.includes("const entryMaxSpreadBps = isLobStrategy") &&
    trader.includes("spreadBps > entryMaxSpreadBps"),
);
check(
  "hierarchical adverse evidence corrects EV while preserving exploration",
  online.includes('"globalSamples"') &&
    online.includes("0.5 * clamp(") &&
    online.includes("const evidenceWeight = Math.max(marketWeight, globalWeight)"),
);
check(
  "verified learning accepts predecessor and current release cohorts",
  migration.includes("'6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE'") &&
    migration.includes("'6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION'") &&
    calibration.includes("engine_version=in."),
);

for (const name of passed) console.log(`  ok   ${name}`);
for (const name of failures) console.log(`  FAIL ${name}`);
console.log(failures.length ? `\n${failures.length} FAILED` : `\nall ${passed.length} v6.11 deploy invariants hold`);
process.exit(failures.length ? 1 : 0);
