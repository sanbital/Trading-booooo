import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const results = [];
function check(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  results.push(name);
}

const scanner = read("supabase/functions/market-scanner/index.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const trader = read("supabase/functions/market-autotrader/index.ts");
const gateway = read("gateway/server.mjs");
const gatewayFly = read("gateway/fly.toml");
const gatewayWorkflow = read(".github/workflows/deploy-order-gateway.yml");
const dashboard = read("docs/index.html");
const workflow = read(".github/workflows/main.deploy-supabase.yml");
const oldMigration = read("supabase/migrations/202607260016_lob_scalp_v600.sql");
const migration = read("supabase/migrations/202607260017_lob_heat_v610.sql");
const deno = read("deno.json");

check("applied v6 migration is not reused for v6.1", oldMigration.includes("v6.0.0-LOB") && migration.includes("v6.1.0-HEAT"));
check("new v6.1 migration exists", fs.existsSync(path.join(root, "supabase/migrations/202607260017_lob_heat_v610.sql")));
check("scan constraint is replaced before 12-second update", migration.indexOf("drop constraint if exists trading_settings_full_scan_interval_seconds_check") < migration.indexOf("full_scan_interval_seconds = 12"));
check("monitor constraint is replaced before 2-second update", migration.indexOf("drop constraint if exists trading_settings_monitor_interval_seconds_check") < migration.indexOf("monitor_interval_seconds = 2"));
check("LOB scan constraint permits 12 seconds", migration.includes("lob_scan_interval_seconds between 8 and 60"));
check("workflow deploys LOB strategy", workflow.includes('"TRADING_STRATEGY=LOB_SCALP"'));
check("workflow deploys heat engine settings", ["LOB_HEAT_SAMPLE_COUNT=3", "LOB_HEAT_SAMPLE_INTERVAL_MS=900", "LOB_HEAT_FINALIST_LIMIT=12", "LOB_OBSERVATION_MS=8000"].every((value) => workflow.includes(value)));
check("workflow scan and monitor match runtime", workflow.includes("AUTO_SCAN_INTERVAL_SECONDS=12") && workflow.includes("AUTO_MONITOR_INTERVAL_SECONDS=2"));
check(
  "Fly scheduler scan and monitor match runtime",
  gatewayFly.includes('AUTO_SCAN_INTERVAL_SECONDS = "12"') &&
    gatewayFly.includes('AUTO_MONITOR_INTERVAL_SECONDS = "2"') &&
    gatewayWorkflow.includes('"AUTO_SCAN_INTERVAL_SECONDS=12"') &&
    gatewayWorkflow.includes('"AUTO_MONITOR_INTERVAL_SECONDS=2"'),
);
check("heat branch precedes candle branch", scanner.indexOf("return await runLobHeatScan") > 0 && scanner.indexOf("return await runLobHeatScan") < scanner.indexOf("loadBaseline15(eligible)", scanner.indexOf("async function runScan")));
check(
  "candidate validity covers scan completion before live recheck",
  engine.includes("recommendationValidMinutes ?? 2") &&
    engine.includes("? clamp(risk.recommendationValidMinutes"),
);
check("maker entry TTL is 8 seconds", trader.includes('SCALP_MAKER_ENTRY_TTL_SECONDS"), 8'));
// The release string moves; this script protects agreement rather than one historical tag.
const currentVersion = engine.match(/ENGINE_VERSION\s*=\s*"([^"]+)"/)?.[1];
check(
  "version is consistent",
  Boolean(currentVersion) &&
    [trader, gateway, dashboard].every((source) => source.includes(currentVersion)),
);
check(
  "Deno check covers the LOB import roots",
  deno.includes("market-scanner/index.ts") && deno.includes("market-autotrader/index.ts"),
);
check("workflow validates before migrations", workflow.indexOf("deno task check") < workflow.indexOf("Apply database migrations"));

console.log(JSON.stringify({ ok: true, checks: results.length, names: results }, null, 2));
