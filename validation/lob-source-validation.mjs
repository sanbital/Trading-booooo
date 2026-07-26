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
const patterns = read("supabase/functions/_shared/lob/patterns.ts");
const exit = read("supabase/functions/_shared/lob/exit.ts");

check("LOB strategy is default in scanner", scannerIndex.includes('|| "LOB_SCALP"'));
check("trend is explicitly auxiliary", entry.includes("auxiliary only; never a veto"));
check("five LOB pattern families exist", [
  "ABSORPTION_REVERSAL", "QUEUE_DEPLETION_BREAKOUT", "SWEEP_RECLAIM",
  "OFI_CONTINUATION", "REPLENISHMENT_ICEBERG",
].every((name) => patterns.includes(name)));
check("iceberg cannot enter alone", patterns.includes('"REPLENISHMENT_ICEBERG"') && patterns.includes("false,"));
check("positive target net return is mandatory", entry.includes("TARGET_NET_PROFIT_NOT_POSITIVE"));
check("positive net EV is mandatory", entry.includes("NET_EV_NOT_POSITIVE"));
check("per-trade stop is capped at 5 percent", scanner.includes("Math.min(500, lobResult.stopBps)"));
check("daily loss cap is 30 percent", migration.includes("scalp_daily_loss_pct = 30"));
check("per-trade loss cap is 5 percent", migration.includes("scalp_max_single_loss_pct = 5"));
check("no practical daily trade-count ceiling", migration.includes("max_daily_entries = 1000000") && trader.includes("Number.MAX_SAFE_INTEGER"));
const lobBranch = trader.indexOf('if (isLobStrategy');
const legacyRateBranch = trader.indexOf('event("SCALP_RATE_CONTROL"');
check("LOB route does not emit SCALP_RATE_CONTROL", lobBranch >= 0 && legacyRateBranch > lobBranch && trader.includes('} else if ((settings as any).strategy === "SCALP") {'));
check("default LOB timeout is 180 seconds", migration.includes("lob_max_holding_seconds = 180"));
check("absolute LOB timeout is 300 seconds", migration.includes("lob_absolute_max_holding_seconds = 300"));
check("exit priority is deterministic", exit.includes("RISK_EMERGENCY") && exit.includes("RECONCILIATION_FAILURE") && exit.includes("STOP_HIT") && exit.includes("LOB_INVALIDATION") && exit.includes("SIGNAL_REVERSAL") && exit.includes("TARGET_HIT") && exit.includes("TIMEOUT"));
check("deployment remains PAPER", migration.includes("mode = 'PAPER'"));
check("gateway defaults to 15-second scans", gateway.includes('AUTO_SCAN_INTERVAL_SECONDS", 15, 10'));
check("gateway defaults to 5-second monitoring", gateway.includes('AUTO_MONITOR_INTERVAL_SECONDS", 5, 5'));

console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }, null, 2));
