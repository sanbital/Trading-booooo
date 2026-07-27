import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures = [];
const passed = [];
const check = (name, condition) => (condition ? passed : failures).push(name);

const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migration = read("supabase/migrations/202607270022_evidence_sized_live_validation_v690.sql");
const autotrader = read("supabase/functions/market-autotrader/index.ts");
const calibration = read("supabase/functions/lob-calibration/index.ts");
const governance = read("supabase/functions/_shared/lob/governance.ts");
const adaptive = read("supabase/functions/_shared/lob/adaptive-policy.ts");
const evidence = read("supabase/functions/_shared/lob/evidence-sizing.ts");
const latency = read("supabase/functions/_shared/scalp/latency.ts");
const evBias = read("supabase/functions/_shared/lob/ev-bias.ts");
const engine = read("supabase/functions/market-scanner/engine.ts");
const gateway = read("gateway/server.mjs");
const dashboard = read("docs/index.html");

const version = engine.match(/ENGINE_VERSION\s*=\s*"([^"]+)"/)?.[1];
check("v6.9 migration is newest", migrations.at(-1) === "202607270022_evidence_sized_live_validation_v690.sql");
check(
  "release versions agree",
  version === "6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION" &&
    [autotrader, gateway, dashboard].every((source) => source.includes(version)),
);
check(
  "configured slot count is the hard capital denominator",
  autotrader.includes("const slots = configuredSlots;") && !autotrader.includes("effectiveSlots("),
);
check(
  "insufficient evidence is size-capped rather than hard-vetoed",
  autotrader.includes("lobEvidenceSizeFraction") &&
    autotrader.includes("sizeFraction: evidenceSize") &&
    evidence.includes("insufficientStatusCap") && evidence.includes("unprovenFloorFraction"),
);
check(
  "policy evolution is bounded and auditable",
  migration.includes("policy_definition jsonb") &&
    adaptive.includes("normalizeLobAdaptivePolicy") &&
    adaptive.includes("may not generate") &&
    migration.includes("Source-code generation and safety-rail relaxation are forbidden"),
);
check(
  "unmeasured latency cannot be silently zero",
  latency.includes("NOISE_BAND_X_ASSUMED_P95") &&
    latency.includes("CONSERVATIVE_UNMEASURED_FLOOR") &&
    migration.includes("scalp_unmeasured_latency_penalty_bps"),
);
check(
  "realized forecast optimism is charged to entry EV",
  evBias.includes("realized net bps - entry-time EV lower bound") &&
    autotrader.includes("forecastBiasPenaltyBps") &&
    migration.includes("scalp_ev_bias_penalty_bps"),
);
check(
  "backtest and unverified labels cannot vote",
  migration.includes("accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')") &&
    migration.includes("'liveVerified', true") &&
    migration.includes("'backtest_shadow_can_vote', false") &&
    governance.includes("live_verified_labels"),
);
check(
  "promotion is staged canary then expanded cohort",
  migration.includes("0.15") && migration.includes("v_decision = 'EXPAND'") &&
    migration.includes("traffic_fraction = 0.50") && governance.includes('decision: "EXPAND"'),
);
check(
  "Pareto gate uses positive expectancy plus bounded non-inferiority",
  governance.includes("positive_net_after_costs") &&
    governance.includes("netNonInferiorityBps") &&
    governance.includes("winRateNonInferiority") &&
    governance.includes("turnoverNonInferiorityRatio") &&
    governance.includes("meaningful_improvement"),
);
check(
  "calibration proposes policies but cannot self-activate raw profiles",
  calibration.includes("proposeLobAdaptivePolicy") &&
    calibration.includes("p_policy_definition") &&
    calibration.includes("active: false") && !calibration.includes("active: true"),
);
check(
  "migration does not relax capital or loss rails",
  !migration.includes("scalp_position_slots =") &&
    !migration.includes("scalp_max_single_loss_pct =") &&
    !migration.includes("scalp_daily_loss_pct =") &&
    !migration.includes("max_daily_loss_pct ="),
);

for (const name of passed) console.log(`  ok   ${name}`);
for (const name of failures) console.log(`  FAIL ${name}`);
console.log(failures.length ? `\n${failures.length} FAILED` : `\nall ${passed.length} v6.9 deploy invariants hold`);
process.exit(failures.length ? 1 : 0);
