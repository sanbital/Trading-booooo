import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures = [];
const passed = [];
const check = (name, condition) => {
  (condition ? passed : failures).push(name);
};

const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migration = read(
  "supabase/migrations/202607270020_validated_pareto_learning_v680.sql",
);
const governance = read("supabase/functions/_shared/lob/governance.ts");
const tests = read("supabase/functions/_shared/lob/governance.test.ts");
const calibration = read("supabase/functions/lob-calibration/index.ts");
const autotrader = read("supabase/functions/market-autotrader/index.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const gateway = read("gateway/server.mjs");
const dashboard = read("docs/index.html");
const dashboardApp = read("docs/app.js");
const performance = read("docs/performance.js");
const deno = JSON.parse(read("deno.json"));

const version = engine.match(/ENGINE_VERSION\s*=\s*"([^"]+)"/)?.[1];
check(
  "v6.8 migration is present",
  migrations.includes("202607270020_validated_pareto_learning_v680.sql"),
);
check(
  "release versions agree",
  Boolean(version) &&
    [autotrader, gateway, dashboard].every((source) => source.includes(version)),
);
check(
  "policy ledger exists",
  migration.includes("create table if not exists public.lob_policy_versions"),
);
check(
  "cohort exposure ledger exists",
  migration.includes("create table if not exists public.lob_policy_cycle_exposures"),
);
check(
  "single champion is enforced",
  migration.includes("lob_policy_versions_single_champion_idx"),
);
check(
  "promotion and rollback are atomic",
  migration.includes("apply_lob_policy_decision") &&
    migration.includes("AUTO_ROLLBACK_CONTROL_RESTORED"),
);
check(
  "migration cannot mutate capital settings",
  !migration.includes("update public.trading_settings") &&
    !migration.includes("scalp_position_slots =") &&
    !migration.includes("scalp_size_fraction ="),
);
check(
  "joint objective includes turnover and mix guards",
  governance.includes("capital_turnover_preserved") &&
    governance.includes("completed_trade_rate_preserved") &&
    governance.includes("exchange_pattern_mix_preserved"),
);
check(
  "raw calibration cannot activate itself",
  calibration.includes("active: false") && !calibration.includes("active: true"),
);
check(
  "new entries fail closed without a validated policy",
  autotrader.includes("validated LOB policy unavailable") &&
    !autotrader.includes("async function loadLobLearning") &&
    !autotrader.includes("async function loadLobOnlineProfiles"),
);
check(
  "entry and exit policies are pinned",
  autotrader.includes("__policy_bundle") &&
    autotrader.includes("pinnedCoinPolicy.soft_exit_confirmations"),
);
check(
  "dashboard distinguishes raw samples from policy versions",
  dashboardApp.includes("CHAMPION P") &&
    dashboardApp.includes("정책 검증 표본") &&
    dashboardApp.includes("원시 원장 승률(참고)"),
);
check(
  "trade history is ten-row collapsed and fifty-row paginated",
  performance.includes("COLLAPSED_TRADE_LIMIT = 10") &&
    performance.includes("EXPANDED_PAGE_SIZE = 50") &&
    performance.includes("downloadTradesCsv") &&
    performance.includes("performance-page-next"),
);
check(
  "governance edge cases are tested",
  tests.includes("shrinking notional") &&
    tests.includes("completed trade rate falls") &&
    tests.includes("favourable exchange-pattern mix") &&
    tests.includes("second live comparison"),
);
check(
  "test task reads migration invariants",
  deno.tasks.test.includes("--allow-read") &&
    deno.tasks.test.includes("_shared/lob/*.test.ts"),
);
check(
  "type check covers calibration runtime",
  deno.tasks.check.includes("market-autotrader/index.ts") &&
    deno.tasks.check.includes("lob-calibration/index.ts"),
);

for (const name of passed) console.log(`  ok   ${name}`);
for (const name of failures) console.log(`  FAIL ${name}`);
console.log(
  failures.length
    ? `\n${failures.length} FAILED`
    : `\nall ${passed.length} v6.8 deploy invariants hold`,
);
process.exit(failures.length ? 1 : 0);
