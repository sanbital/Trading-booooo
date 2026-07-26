// v6.2 deploy invariants. The v6.1 script asserted that every deploy resets the mode to
// PAPER; that assertion was removed along with the behaviour it protected, because
// re-arming after each deploy was the largest source of idle time for a strategy whose
// premise is capital turnover.
import { readFileSync, readdirSync } from "node:fs";

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}`); failures++; }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((f) => f.endsWith(".sql"));
const newest = migrations.sort().at(-1);
const heat = read("../supabase/migrations/202607260017_lob_heat_v610.sql");
const readiness = read("../supabase/migrations/202607260019_deploy_readiness_v620.sql");
const gateway = read("../gateway/server.mjs");
const entry = read("../supabase/functions/_shared/lob/entry.ts");
const traps = read("../supabase/functions/_shared/lob/traps.ts");
const workflow = read("../.github/workflows/main.deploy-supabase.yml");
const deno = JSON.parse(read("../deno.json"));

console.log("v6.2.0-HEAT deploy invariants");
check("no deploy migration disarms trading", !heat.includes("mode = 'PAPER'"));
check("readiness migration is the newest", newest === "202607260019_deploy_readiness_v620.sql");
check("readiness migration preserves operator halts",
  readiness.includes("manual_intervention_required") && readiness.includes("withdrawal_mode"));
check("cold start scan is configurable and short", gateway.includes("COLD_START_SCAN_MS") &&
  gateway.includes('integerEnv("LOB_COLD_START_SCAN_SECONDS", 3'));
check("probability is anchored to barrier geometry", entry.includes("neutralWinRate + signalEdge"));
check("signal edge is bounded", entry.includes("MAX_SIGNAL_EDGE"));
check("trap vetoes are wired into entry reasons", entry.includes("TRAP_${name}"));
check("stop respects the measured noise band", entry.includes("traps.requiredStopBps"));
check("funding is capped and cannot veto", entry.includes("clamp(features.fundingEdge, -0.03, 0.03)"));
check("chop widens the stop rather than blocking", traps.includes("veto: false"));
check("calibration jobs are deployed by CI", workflow.includes("lob-calibration"));
check("tests run with filesystem read permission", deno.tasks.test.includes("--allow-read"));
check("check task covers the new modules",
  deno.tasks.check.includes("traps.ts") && deno.tasks.check.includes("learning.ts"));

console.log(failures ? `\n${failures} FAILED` : "\nall invariants hold");
process.exit(failures ? 1 : 0);
