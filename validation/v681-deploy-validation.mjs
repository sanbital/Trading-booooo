import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures = [];
const passed = [];
const check = (name, condition) => (condition ? passed : failures).push(name);

const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migration = read("supabase/migrations/202607270021_residual_label_integrity_v681.sql");
const core = read("supabase/functions/market-autotrader/core.ts");
const autotrader = read("supabase/functions/market-autotrader/index.ts");
const feeAccounting = read("supabase/functions/market-autotrader/fee-accounting.ts");
const performance = read("supabase/functions/market-performance/index.ts");
const settlement = read("supabase/functions/market-performance/account-settlement.ts");
const tests = read("supabase/functions/market-autotrader/residual-accounting.test.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const gateway = read("gateway/server.mjs");
const dashboard = read("docs/index.html");

const version = engine.match(/ENGINE_VERSION\s*=\s*"([^"]+)"/)?.[1];
check(
  "v6.8.1 migration remains present",
  migrations.includes("202607270021_residual_label_integrity_v681.sql"),
);
check(
  "release versions agree",
  Boolean(version) &&
    [autotrader, gateway, dashboard].every((source) => source.includes(version)),
);
check(
  "position residual ledger exists",
  migration.includes("add column if not exists residual_quantity") &&
    migration.includes("add column if not exists residual_value_quote") &&
    migration.includes("add column if not exists residual_fee_base"),
);
check(
  "economic pnl includes residual value",
  migration.includes("v_proceeds + v_residual_value - v_position.realized_cost_quote - v_fees"),
);
check(
  "base-asset sell fee reduces physical residual",
  migration.includes("upper(coalesce(f.fee_asset, '')) = upper(coalesce(v_position.base_asset, ''))") &&
    migration.includes("v_remaining := greatest(0, v_after_sale - v_base_fee)"),
);
check(
  "base fee is not double charged in quote",
  feeAccounting.includes('source: "BASE_ASSET"') &&
    feeAccounting.includes("feeQuote: 0") &&
    feeAccounting.includes("feeQuoteEstimate: 0") &&
    migration.includes("then 0\n        when upper(coalesce(f.fee_asset"),
);
check(
  "entry books exact net inventory",
  autotrader.includes("Store the exact net quantity received") &&
    !autotrader.includes("const quantity = floorToStep(\n    Math.max(0, grossQuantity - baseFee)"),
);
check(
  "unverified legacy labels fail closed",
  migration.includes("'LEGACY_UNVERIFIED' then\n    return null") &&
    migration.includes("delete from public.lob_market_profiles") &&
    migration.includes("select public.backfill_lob_online_learning(5000)"),
);
check(
  "runtime emits residual accounting evidence",
  autotrader.includes("EXIT_RESIDUAL_VALUED") &&
    autotrader.includes("calculateExitResidualAccounting"),
);
check(
  // The engine's measured realized PnL still wins over the API's own recomputation. The
  // one exception is a manual reconcile, where `manualReconcileAccounting` writes a
  // hard-coded zero that would erase the operator's own sell from every total.
  "performance API uses authoritative corrected pnl",
  performance.includes("residual_value_quote") &&
    performance.includes("ledgerRealizedPnlQuote: position.realized_pnl_quote") &&
    settlement.includes("finite(input.ledgerRealizedPnlQuote, calculatedNetPnl)") &&
    settlement.includes("input.closedByLedger && manualExitQuantity <= 0"),
);
check(
  "regression cases cover BNB and ETH",
  tests.includes("BNB one-step exit dust") &&
    tests.includes("ETH quote-fee exit") &&
    tests.includes("material remainder stays open"),
);
check(
  "migration cannot change trading authority",
  !migration.includes("update public.trading_settings") &&
    !migration.includes("scalp_position_slots =") &&
    !migration.includes("max_new_entries_per_scan ="),
);
check(
  "v6.8 Pareto migration remains present",
  migrations.includes("202607270020_validated_pareto_learning_v680.sql"),
);

for (const name of passed) console.log(`  ok   ${name}`);
for (const name of failures) console.log(`  FAIL ${name}`);
console.log(failures.length ? `\n${failures.length} FAILED` : `\nall ${passed.length} v6.8.1 deploy invariants hold`);
process.exit(failures.length ? 1 : 0);
