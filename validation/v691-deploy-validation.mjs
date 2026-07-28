import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures = [];
const passed = [];
const check = (name, condition) => (condition ? passed : failures).push(name);

const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migration = read("supabase/migrations/202607280001_fee_ledger_integrity_v691.sql");
const autotrader = read("supabase/functions/market-autotrader/index.ts");
const feeModule = read("supabase/functions/market-autotrader/fee-accounting.ts");
const feeTests = read("supabase/functions/market-autotrader/fee-accounting.test.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const gateway = read("gateway/server.mjs");
const dashboard = read("docs/index.html");

const version = engine.match(/ENGINE_VERSION\s*=\s*"([^"]+)"/)?.[1];
check("v6.9.1 migration is newest", migrations.at(-1) === "202607280001_fee_ledger_integrity_v691.sql");
check(
  "release versions agree",
  version === "6.9.1-FEE-LEDGER-INTEGRITY" &&
    [autotrader, gateway, dashboard].every((source) => source.includes(version)),
);
check(
  "autotrader uses centralized fee resolution",
  autotrader.includes('from "./fee-accounting.ts"') &&
    autotrader.includes("allocateNormalizedTradeFees") &&
    autotrader.includes("resolveFeeQuote") &&
    autotrader.includes("fee_accounting"),
);
check(
  "aggregate quote fee fallback is explicit",
  feeModule.includes('source: "AGGREGATE_QUOTE"') &&
    feeModule.includes("aggregatePaidFee > 0") &&
    feeModule.includes("positiveTradeFeeCount === 0") &&
    feeModule.includes('source: "ESTIMATED_MISSING"') &&
    feeModule.includes("estimateWhenMissing === true"),
);
check(
  "Upbit confirmed values are regression tested",
  feeTests.includes("10.99999999329") &&
    feeTests.includes("11.001018941945") &&
    feeTests.includes("-19.963121625235"),
);
check(
  "migration backfills order fill position and learning ledgers",
  migration.includes("normalize_upbit_order_fee_v691") &&
    migration.includes("allocate_upbit_order_fee_to_fills_v691") &&
    migration.includes("realized_pnl_quote = case") &&
    migration.includes("delete from public.lob_online_outcomes") &&
    migration.includes("backfill_lob_online_learning(5000)") &&
    migration.includes("binance_order_fees") &&
    migration.includes("guard_lob_outcome_fee_quality_v691") &&
    migration.includes("ESTIMATED_FEE_DETAIL"),
);
check(
  "base-asset fees remain quantity accounting",
  feeModule.includes('source: "BASE_ASSET"') && feeModule.includes("feeQuote: 0"),
);

for (const name of passed) console.log(`  ok   ${name}`);
for (const name of failures) console.log(`  FAIL ${name}`);
console.log(failures.length ? `\n${failures.length} FAILED` : `\nall ${passed.length} v6.9.1 deploy invariants hold`);
process.exit(failures.length ? 1 : 0);
