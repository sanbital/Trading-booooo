/**
 * LIVE_READY preflight verdict (brief section 10), as a pure function.
 *
 * Kept separate from the activation script for one reason: section 10 requires
 * the activation tool to FAIL while validation has not passed, and an assertion
 * in a comment is not evidence. Here the rule is a function of its input, so a
 * test can enumerate inputs and prove that no combination produces
 * `liveReady: true` while any check fails -- including inputs an attacker or a
 * hurried operator might supply.
 *
 * Every check is derived from live state by the caller. There is no cached
 * verdict and no override parameter; adding one would break the property test.
 */

export const PREFLIGHT_VERSION = "BOO-PREFLIGHT-1";

/** The checks, in report order. Each maps live state -> {pass, detail}. */
export const CHECK_IDS = Object.freeze([
  "ledger_reconciled",
  "risk_config_valid",
  "edge_measured",
  "strategy_approved",
  "shadow_sample_present",
  "gate_live",
  "deployed_sha_pinned",
  "no_unsettled_state",
]);

const fail = (detail, remedy) => ({ pass: false, detail, remedy });
const pass = (detail) => ({ pass: true, detail, remedy: null });

/**
 * @param {any} state live state gathered by the caller
 * @returns {any} {liveReady, checks[], blocking[]}
 */
export function evaluatePreflight(state) {
  const s = state ?? {};
  const checks = [];
  const add = (id, result) => checks.push({ id, ...result });

  // 1. No unresolved ledger exceptions.
  const exceptions = Array.isArray(s.ledgerExceptions) ? s.ledgerExceptions : null;
  add(
    "ledger_reconciled",
    exceptions === null
      ? fail("ledger exceptions unreadable", "Make boo_ledger_exceptions readable; unknown is not clean.")
      : exceptions.length === 0
      ? pass("no unresolved ledger exceptions")
      : fail(
        `${exceptions.length} unresolved`,
        "Re-collect the missing fills via userTrades, then set resolved_at with evidence.",
      ),
  );

  // 2. Risk configuration converts and is plausible.
  add(
    "risk_config_valid",
    s.riskPolicy?.ok === true
      ? pass(`risk_per_trade_frac=${s.riskPolicy.policy?.riskPerTradeFrac}`)
      : fail(
        (s.riskPolicy?.errors ?? []).map((e) => e.code).join(";") || "risk policy unresolved",
        "Correct the *_pct columns; they are percentages.",
      ),
  );

  // 3. Edge is measured, never assumed or typed in.
  const src = String(s.edge?.source ?? "ASSUMED").toUpperCase();
  const measured = src !== "ASSUMED" && src !== "MANUAL" && src !== "OPERATOR";
  add(
    "edge_measured",
    measured && Number.isFinite(Number(s.edge?.netBps)) && Number.isFinite(Number(s.edge?.requiredBps))
      ? pass(`${src} net=${s.edge.netBps} required=${s.edge.requiredBps}`)
      : fail(`source=${src}`, "Populate a measured edge; a typed-in number does not qualify."),
  );

  // 4. A live, evaluated, positive approval exists.
  const approvals = Array.isArray(s.approvals) ? s.approvals : [];
  const now = Number(s.now ?? Date.now());
  const liveApprovals = approvals.filter((a) =>
    a && a.revoked !== true &&
    Date.parse(String(a.valid_until ?? "")) > now &&
    Number(a.net_expectancy_lower_bound) > 0 &&
    String(a.expected_edge_source) === "EVALUATED" &&
    !!a.approved_by
  );
  add(
    "strategy_approved",
    liveApprovals.length > 0
      ? pass(`${liveApprovals.length} live approval(s)`)
      : fail(
        `${approvals.length} row(s), none live/evaluated/positive`,
        "Insert an approval matching the running build with a positive EVALUATED lower bound.",
      ),
  );

  // 5. Sample size is not zero. Zero trades is zero evidence.
  const closed = Number(s.shadowClosedCount ?? 0);
  add(
    "shadow_sample_present",
    closed > 0
      ? pass(`${closed} closed SHADOW positions`)
      : fail("0 closed SHADOW positions", "Let the SHADOW produce trades; zero trades is not a result."),
  );

  // 6. The gate is deployed and has actually evaluated.
  const decisions = Number(s.gateDecisionCount ?? 0);
  add(
    "gate_live",
    decisions > 0
      ? pass(`${decisions} gate decision(s) recorded`)
      : fail("gate has never evaluated", "Deploy the executor build that calls the gate."),
  );

  // 7. Deployed code is pinned to what was reviewed.
  const expected = s.expectedExecutorSha ? String(s.expectedExecutorSha) : "";
  const actual = s.deployedExecutorSha ? String(s.deployedExecutorSha) : "";
  add(
    "deployed_sha_pinned",
    expected.length > 0 && actual.length > 0 && expected === actual
      ? pass(`executor sha matches (${expected.slice(0, 16)}…)`)
      : fail(
        !expected ? "no expected sha supplied" : !actual ? "deployed sha unknown" : "sha mismatch",
        "Pin --executor-sha to the reviewed build and compare it to the deployed function.",
      ),
  );

  // 8. No unsettled exposure or orders in our own books.
  const openPositions = Number(s.openPositionCount ?? NaN);
  const pendingOrders = Number(s.pendingOrderCount ?? NaN);
  add(
    "no_unsettled_state",
    openPositions === 0 && pendingOrders === 0
      ? pass("no open positions or pending orders (database view)")
      : fail(
        `open=${openPositions} pending=${pendingOrders}`,
        "Settle or quarantine them. Confirm the exchange separately; the DB is not the authority.",
      ),
  );

  const blocking = checks.filter((c) => !c.pass);
  return {
    version: PREFLIGHT_VERSION,
    // The ONLY way this is true. No parameter can short-circuit it, and the
    // property test in boo-safety.test.ts enumerates inputs to prove it.
    liveReady: blocking.length === 0,
    checks,
    blocking,
  };
}
