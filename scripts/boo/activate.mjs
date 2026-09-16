#!/usr/bin/env node
/**
 * LIVE_READY preflight and operator activation tool (brief section 10).
 *
 * Section 10 requires that the activation tool itself FAIL while validation has
 * not passed, and that no single environment variable can wave an unapproved
 * state through. This implements both literally:
 *
 *   - Every precondition is re-derived from the live database at run time.
 *     There is no cached verdict, no "--force", no "SKIP_CHECKS" variable, and
 *     no code path that turns a FAIL into a PASS. Grep this file for an escape
 *     hatch; there isn't one, and adding one should fail review.
 *   - `--activate` refuses unless ALL preconditions pass in the same run that
 *     performs the flip, so a check that passed an hour ago cannot authorise a
 *     change now.
 *   - The tool never places, cancels or modifies an order, and never changes an
 *     account mode. It flips exactly two DB flags, both reversible.
 *
 * Usage:
 *   node scripts/boo/activate.mjs --check                 # default; read-only
 *   node scripts/boo/activate.mjs --activate --operator "<name>" --reason "<why>"
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ACTIVATE = has("--activate");
const OPERATOR = val("--operator");
const REASON = val("--reason");
const EXPECTED_EXECUTOR_SHA = val("--executor-sha");
// Supplied by the caller after reading the deployed function, so the tool
// compares two independently obtained values rather than trusting one.
const DEPLOYED_EXECUTOR_SHA = val("--deployed-sha");

if (!URL_ || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(2);
}

async function rest(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: init.method && init.method !== "GET" ? "return=representation" : undefined,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`REST ${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function gatherState() {
  const [settings] = await rest(
    "trading_settings?select=mode,pause_new_entries,risk_per_trade_pct,max_daily_loss_pct," +
      "max_open_positions,max_open_positions_per_exchange,max_weekly_loss_pct," +
      "max_consecutive_losses,boo_edge_source,boo_measured_net_edge_bps,boo_required_edge_bps&id=eq.1",
  );
  const { resolveRiskPolicy } = await import(
    "../../supabase/functions/_shared/boo/risk-policy.mjs"
  );

  const [ledgerExceptions, approvals, shadowClosed, gateDecisions, openPositions, pendingOrders] =
    await Promise.all([
      rest("boo_ledger_exceptions?select=symbol,finding_code,residual_quote&resolved_at=is.null"),
      rest(
        "boo_strategy_approvals?select=revoked,valid_until,net_expectancy_lower_bound," +
          "expected_edge_source,approved_by,trade_count,independent_periods",
      ),
      rest("boo_shadow_positions?select=id&state=eq.CLOSED"),
      rest("boo_entry_gate_decisions?select=id&limit=1000"),
      rest("v11_long_regime_positions?select=symbol&state=neq.CLOSED"),
      rest(
        "v11_long_regime_orders?select=symbol&state=in.(PLANNED,DISPATCHED," +
          "RECONCILIATION_PENDING,RECONCILIATION_FAILED)",
      ),
    ]);

  return {
    now: Date.now(),
    ledgerExceptions,
    riskPolicy: resolveRiskPolicy(settings),
    edge: {
      source: settings?.boo_edge_source,
      netBps: settings?.boo_measured_net_edge_bps,
      requiredBps: settings?.boo_required_edge_bps,
    },
    approvals,
    shadowClosedCount: shadowClosed.length,
    gateDecisionCount: gateDecisions.length,
    // The deployed sha must be supplied by the caller AND matched against the
    // reviewed build; neither half alone proves anything.
    expectedExecutorSha: EXPECTED_EXECUTOR_SHA ?? "",
    deployedExecutorSha: DEPLOYED_EXECUTOR_SHA ?? "",
    openPositionCount: openPositions.length,
    pendingOrderCount: pendingOrders.length,
    settings,
  };
}

async function main() {
  const observedAt = new Date().toISOString();
  console.log("BOO live activation preflight");
  console.log(`observed_at_utc : ${observedAt}`);
  console.log(`mode            : ${ACTIVATE ? "ACTIVATE (writes only on a full pass)" : "CHECK (read-only)"}`);
  console.log("");

  const { evaluatePreflight } = await import(
    "../../supabase/functions/_shared/boo/preflight.mjs"
  );
  // One rule, shared with preflight.test.ts, which enumerates all 2^8 failure
  // subsets and proves none of them yields liveReady.
  const verdict = evaluatePreflight(await gatherState());

  console.log("## preflight");
  for (const c of verdict.checks) {
    console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.id.padEnd(24)} ${c.detail}`);
  }
  console.log("");
  console.log(`live_ready = ${verdict.liveReady}`);

  if (verdict.blocking.length) {
    console.log("");
    console.log("## blocking, with the remedy for each");
    for (const c of verdict.blocking) console.log(`  - ${c.id}: ${c.remedy}`);
  }

  if (!ACTIVATE) {
    console.log("");
    console.log("Read-only check complete. Nothing was written.");
    process.exit(verdict.liveReady ? 0 : 1);
  }

  if (!verdict.liveReady) {
    console.error("");
    console.error(`REFUSING TO ACTIVATE: ${verdict.blocking.length} precondition(s) failed.`);
    console.error("This tool has no bypass. Fix the causes above and run it again.");
    process.exit(1);
  }
  if (!OPERATOR || !REASON) {
    console.error("");
    console.error("REFUSING TO ACTIVATE: --operator and --reason are required and recorded.");
    process.exit(2);
  }

  await rest("boo_entry_gate_control?singleton=eq.true", {
    method: "PATCH",
    body: JSON.stringify({
      enforcement: "ENFORCE",
      set_by: OPERATOR,
      set_reason: REASON,
      updated_at: new Date().toISOString(),
    }),
  });
  await rest("trading_settings?id=eq.1", {
    method: "PATCH",
    body: JSON.stringify({ pause_new_entries: false }),
  });

  console.log("");
  console.log("ACTIVATED: gate enforcement=ENFORCE, pause_new_entries=false.");
  console.log(`operator: ${OPERATOR}`);
  console.log(`reason  : ${REASON}`);
  console.log("");
  console.log("Next: follow runbook 7.9 after the first real fill.");
  process.exit(0);
}

main().catch((e) => {
  console.error(`PREFLIGHT FAILED: ${e.message}`);
  // A preflight that cannot complete is NOT a pass.
  process.exit(2);
});
