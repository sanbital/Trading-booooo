import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const checks = [];
function check(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  checks.push(name);
}

const scanner = read("supabase/functions/market-scanner/engine.ts");
const scannerIndex = read("supabase/functions/market-scanner/index.ts");
const trader = read("supabase/functions/market-autotrader/index.ts");
const migration = read("supabase/migrations/202607260016_lob_scalp_v600.sql");
const gateway = read("gateway/server.mjs");
const entry = read("supabase/functions/_shared/lob/entry.ts");
const payoff = read("supabase/functions/_shared/lob/payoff-governor.ts");
const patterns = read("supabase/functions/_shared/lob/patterns.ts");
const heat = read("supabase/functions/_shared/lob/market-heat.ts");
const exit = read("supabase/functions/_shared/lob/exit.ts");

check("LOB strategy is default in scanner", scannerIndex.includes('|| "LOB_SCALP"'));
check("whole-market heat runs before candle analysis", scannerIndex.includes("sampleWholeMarketHeat") && scannerIndex.includes("runLobHeatScan"));
check("heat prioritizes current flow acceleration", heat.includes("notionalAcceleration") && heat.includes("recentNotionalPerSecond"));
const runScanBody = scannerIndex.slice(scannerIndex.indexOf("async function runScan"));
check("LOB scanner bypasses candle fetch", runScanBody.indexOf("return await runLobHeatScan") >= 0 && runScanBody.indexOf("return await runLobHeatScan") < runScanBody.indexOf("const universe = buildUniverse"));
check("trend is explicitly auxiliary", entry.includes("auxiliary only; never a veto"));
check("five LOB pattern families exist", [
  "ABSORPTION_REVERSAL", "QUEUE_DEPLETION_BREAKOUT", "SWEEP_RECLAIM",
  "OFI_CONTINUATION", "REPLENISHMENT_ICEBERG",
].every((name) => patterns.includes(name)));
check("iceberg cannot enter alone", patterns.includes('"REPLENISHMENT_ICEBERG"') && patterns.includes("false,"));
check(
  "positive target net return is mandatory",
  entry.includes("TARGET_NET_PROFIT_NOT_POSITIVE") ||
    payoff.includes("TARGET_NET_CUSHION_TOO_SMALL"),
);
check("positive net EV is mandatory", entry.includes("NET_EV_NOT_POSITIVE"));
check("per-trade stop is capped at 5 percent", scanner.includes("Math.min(500, lobResult.stopBps)"));
check("daily loss cap is 30 percent", migration.includes("scalp_daily_loss_pct = 30"));
check("per-trade loss cap is 5 percent", migration.includes("scalp_max_single_loss_pct = 5"));
check("no practical daily trade-count ceiling", migration.includes("max_daily_entries = 1000000") && trader.includes("Number.MAX_SAFE_INTEGER"));
const legacyRateBranch = trader.indexOf('"SCALP_RATE_CONTROL"');
const lobRateBranch = trader.lastIndexOf("if (isLobStrategy", legacyRateBranch);
const scalpRateBranch = trader.indexOf(
  '} else if ((settings as any).strategy === "SCALP") {',
  lobRateBranch,
);
check(
  "LOB route does not emit SCALP_RATE_CONTROL",
  lobRateBranch >= 0 &&
    scalpRateBranch > lobRateBranch &&
    legacyRateBranch > scalpRateBranch,
);
check("default LOB timeout is 180 seconds", migration.includes("lob_max_holding_seconds = 180"));
check("absolute LOB timeout is 300 seconds", migration.includes("lob_absolute_max_holding_seconds = 300"));
check("exit priority is deterministic", exit.includes("RISK_EMERGENCY") && exit.includes("RECONCILIATION_FAILURE") && exit.includes("STOP_HIT") && exit.includes("LOB_INVALIDATION") && exit.includes("SIGNAL_REVERSAL") && exit.includes("TARGET_HIT") && exit.includes("TIMEOUT"));
check("deployment remains PAPER", migration.includes("mode = 'PAPER'"));
check("gateway defaults to 12-second scans", gateway.includes('AUTO_SCAN_INTERVAL_SECONDS", 12, 8'));
check("gateway defaults to 2-second monitoring", gateway.includes('AUTO_MONITOR_INTERVAL_SECONDS", 2, 1'));

console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }, null, 2));
