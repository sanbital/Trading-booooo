/**
 * The single admission gate every new entry must pass (brief section 4).
 *
 *   strategy_eligible AND validation_approved AND data_healthy AND
 *   cost_acceptable AND risk_budget_available AND execution_ready AND
 *   trading_authorized
 *
 * Design rules this encodes, all from section 4:
 *   - Fail CLOSED.  An input that is missing, unreadable or not understood is a
 *     refusal, not a pass.  `undefined` never means "fine".
 *   - A filter being switched OFF is not an ALLOW.  A disabled check reports
 *     UNPROVEN, and UNPROVEN blocks.
 *   - `validation_approved` cannot be satisfied by a boolean or by a
 *     hand-typed expectedEdgeBps.  It requires a validation record whose code
 *     hash, parameter hash, data hash, cost-model version and approval all
 *     match what is about to run.
 *   - The gate is evaluated twice: once at admission and once immediately
 *     before the order is sent.  `phase` records which.
 *
 * Pure function, no I/O, so the shadow runner and the live executor share it.
 */

import { dec } from "./decimal.mjs";

export const ENTRY_GATE_VERSION = "BOO-ENTRY-GATE-1";

export const CONDITIONS = Object.freeze([
  "strategy_eligible",
  "validation_approved",
  "data_healthy",
  "cost_acceptable",
  "risk_budget_available",
  "execution_ready",
  "trading_authorized",
]);

/** A condition result. `state` is PASS | BLOCK | UNPROVEN; only PASS admits. */
function cond(state, code, detail) {
  return { state, code, detail: detail === undefined ? null : String(detail) };
}
const PASS = (code, d) => cond("PASS", code ?? "OK", d);
const BLOCK = (code, d) => cond("BLOCK", code, d);
const UNPROVEN = (code, d) => cond("UNPROVEN", code, d);

/**
 * Does this validation record actually authorise THIS policy, on THIS data,
 * under THIS cost model, right now?
 *
 * Section 4: a hash matching proves identity, not truth, so the record must
 * ALSO carry a real evaluation result and a named approver, and the approval
 * must still be inside its stated validity window.
 */
/** @param {any} approval @param {any} running @param {number} [now] @returns {any} */
export function checkValidationApproval(approval, running, now = Date.now()) {
  if (!approval || typeof approval !== "object") {
    return BLOCK("VALIDATION_RECORD_MISSING");
  }
  if (approval.parametersValidatedByBacktest !== undefined && Object.keys(approval).length <= 2) {
    // The exact shape section 4 forbids: a bare boolean standing in for a result.
    return BLOCK("VALIDATION_BOOLEAN_ONLY");
  }
  const required = [
    ["policyCodeHash", running?.policyCodeHash],
    ["parameterHash", running?.parameterHash],
    ["datasetHash", running?.datasetHash],
    ["costModelVersion", running?.costModelVersion],
    ["executionModelVersion", running?.executionModelVersion],
  ];
  for (const [field, expected] of required) {
    const got = approval[field];
    if (!got) return BLOCK("VALIDATION_FIELD_MISSING", field);
    if (!expected) return BLOCK("RUNNING_FIELD_MISSING", field);
    if (String(got) !== String(expected)) {
      return BLOCK("VALIDATION_HASH_MISMATCH", `${field}: approved=${got} running=${expected}`);
    }
  }
  if (!approval.resultFileHash) return BLOCK("VALIDATION_RESULT_MISSING");
  if (!approval.approvedBy) return BLOCK("VALIDATION_APPROVER_MISSING");
  if (!approval.evaluationWindow?.start || !approval.evaluationWindow?.end) {
    return BLOCK("VALIDATION_WINDOW_MISSING");
  }
  // A real evaluation result, not a claimed edge.
  const lb = approval.netExpectancyLowerBound;
  if (lb === undefined || lb === null) return BLOCK("VALIDATION_EXPECTANCY_MISSING");
  let lbDec;
  try {
    lbDec = dec(lb);
  } catch {
    return BLOCK("VALIDATION_EXPECTANCY_UNREADABLE", String(lb));
  }
  if (!lbDec.isPos()) {
    return BLOCK("VALIDATION_EXPECTANCY_NOT_POSITIVE", lbDec.toString());
  }
  if (approval.expectedEdgeBpsSource === "MANUAL" || approval.expectedEdgeBpsSource === "OPERATOR") {
    return BLOCK("VALIDATION_EDGE_MANUALLY_ENTERED", String(approval.expectedEdgeBpsSource));
  }
  const until = approval.validUntil ? Date.parse(approval.validUntil) : NaN;
  if (!Number.isFinite(until)) return BLOCK("VALIDATION_VALIDITY_MISSING");
  if (now > until) return BLOCK("VALIDATION_EXPIRED", approval.validUntil);
  return PASS("VALIDATION_APPROVED", approval.resultFileHash);
}

/**
 * Evaluate the gate.
 *
 * Every argument is required to be explicitly present.  See the per-condition
 * comments for what each one must contain.
 */
/** @param {any} input @returns {any} */
export function evaluateEntryGate(input) {
  const {
    phase = "ADMISSION",
    now = Date.now(),
    strategy, // {eligible:boolean, setupId, reason}
    approval, // validation record (see checkValidationApproval)
    running, // {policyCodeHash, parameterHash, datasetHash, costModelVersion, executionModelVersion}
    data, // {bookHealthy, bookAgeMs, maxBookAgeMs, barsFinal, resyncComplete, reasons[]}
    cost, // {netEdgeBps, requiredEdgeBps, source}
    risk, // solveQuantity() result + loss-limit verdict
    execution, // {leaseHeld, leaseFencingToken, protectionSupported, gatewayReady, accountModeSupported}
    authorization, // {mode, pauseNewEntries, killSwitch, operatorEntryEnabled, liveEnabled, circuitOpen}
  } = input ?? {};

  const results = {};

  // ---- strategy_eligible ---------------------------------------------------
  results.strategy_eligible = !strategy || typeof strategy.eligible !== "boolean"
    ? BLOCK("STRATEGY_STATE_UNREADABLE")
    : strategy.eligible
    ? PASS("STRATEGY_ELIGIBLE", strategy.setupId)
    : BLOCK("STRATEGY_NOT_ELIGIBLE", strategy.reason);

  // ---- validation_approved -------------------------------------------------
  results.validation_approved = checkValidationApproval(approval, running, now);

  // ---- data_healthy --------------------------------------------------------
  if (!data || typeof data !== "object") {
    results.data_healthy = BLOCK("DATA_STATE_UNREADABLE");
  } else {
    const problems = [];
    if (data.bookHealthy !== true) problems.push(`book:${data.bookHealthy}`);
    if (data.barsFinal !== true) problems.push("bars_not_final");
    if (data.resyncComplete !== true) problems.push("book_resync_incomplete");
    const age = Number(data.bookAgeMs);
    const maxAge = Number(data.maxBookAgeMs);
    if (!Number.isFinite(age) || !Number.isFinite(maxAge)) problems.push("book_age_unknown");
    else if (age > maxAge) problems.push(`book_stale:${age}>${maxAge}`);
    for (const r of data.reasons ?? []) problems.push(String(r));
    results.data_healthy = problems.length
      ? BLOCK("DATA_UNHEALTHY", problems.join(","))
      : PASS("DATA_HEALTHY", `age=${age}ms`);
  }

  // ---- cost_acceptable -----------------------------------------------------
  if (!cost || typeof cost !== "object") {
    results.cost_acceptable = BLOCK("COST_STATE_UNREADABLE");
  } else if (cost.source === "MANUAL" || cost.source === "ASSUMED") {
    // Section 4: a hand-entered expectedEdgeBps does not clear this.
    results.cost_acceptable = BLOCK("COST_EDGE_NOT_MEASURED", String(cost.source));
  } else {
    let net, req;
    try {
      net = dec(cost.netEdgeBps);
      req = dec(cost.requiredEdgeBps);
    } catch {
      results.cost_acceptable = BLOCK("COST_UNREADABLE");
    }
    if (!results.cost_acceptable) {
      results.cost_acceptable = net.gte(req)
        ? PASS("COST_ACCEPTABLE", `${net}>=${req}bps`)
        : BLOCK("EDGE_BELOW_COST_THRESHOLD", `${net}<${req}bps`);
    }
  }

  // ---- risk_budget_available ----------------------------------------------
  if (!risk || typeof risk !== "object") {
    results.risk_budget_available = BLOCK("RISK_STATE_UNREADABLE");
  } else if (risk.limits && risk.limits.allowed === false) {
    results.risk_budget_available = BLOCK(
      "RISK_LIMIT_REACHED",
      (risk.limits.blocks ?? []).map((b) => b.code).join(","),
    );
  } else if (risk.sizing?.decision !== "ENTER") {
    results.risk_budget_available = BLOCK(
      "RISK_SIZING_REFUSED",
      risk.sizing?.reason ?? "NO_SIZING_RESULT",
    );
  } else {
    results.risk_budget_available = PASS(
      "RISK_BUDGET_AVAILABLE",
      `qty=${risk.sizing.plan.quantity} loss=${risk.sizing.plan.plannedLoss}`,
    );
  }

  // ---- execution_ready -----------------------------------------------------
  if (!execution || typeof execution !== "object") {
    results.execution_ready = BLOCK("EXECUTION_STATE_UNREADABLE");
  } else {
    const problems = [];
    if (execution.leaseHeld !== true) problems.push("no_lease");
    if (!execution.leaseFencingToken) problems.push("no_fencing_token");
    if (execution.gatewayReady !== true) problems.push("gateway_not_ready");
    // Section 7: entry is forbidden on an account mode whose protective order
    // combination is not supported. Unknown counts as unsupported.
    if (execution.accountModeSupported !== true) problems.push("account_mode_unsupported");
    if (execution.protectionSupported !== true) problems.push("protection_unsupported");
    results.execution_ready = problems.length
      ? BLOCK("EXECUTION_NOT_READY", problems.join(","))
      : PASS("EXECUTION_READY", execution.leaseFencingToken);
  }

  // ---- trading_authorized --------------------------------------------------
  if (!authorization || typeof authorization !== "object") {
    results.trading_authorized = BLOCK("AUTHORIZATION_STATE_UNREADABLE");
  } else {
    const problems = [];
    if (authorization.settingsReadOk !== true) problems.push("settings_read_failed");
    if (authorization.operatorEntryEnabled !== true) problems.push("operator_entry_disabled");
    if (authorization.liveEnabled !== true) problems.push("runtime_not_live");
    if (authorization.circuitOpen === true) problems.push("circuit_open");
    if (authorization.pauseNewEntries === true) problems.push("entries_paused");
    if (authorization.killSwitch === true) problems.push("kill_switch");
    const mode = String(authorization.mode ?? "");
    if (mode !== "LIVE_LIMITED" && mode !== "SHADOW") problems.push(`mode:${mode || "UNKNOWN"}`);
    results.trading_authorized = problems.length
      ? BLOCK("TRADING_NOT_AUTHORIZED", problems.join(","))
      : PASS("TRADING_AUTHORIZED", mode);
  }

  // ---- combine -------------------------------------------------------------
  const blocked = [];
  for (const key of CONDITIONS) {
    const r = results[key] ?? BLOCK("CONDITION_NOT_EVALUATED");
    results[key] = r;
    if (r.state !== "PASS") blocked.push({ condition: key, ...r });
  }

  return {
    version: ENTRY_GATE_VERSION,
    phase,
    allowed: blocked.length === 0,
    blocked,
    // A one-line reason suitable for a DB column.
    reason: blocked.length ? blocked.map((b) => `${b.condition}=${b.code}`).join(";") : null,
    conditions: results,
    evaluatedAt: new Date(now).toISOString(),
  };
}

/**
 * Both mandatory evaluations, with the pre-dispatch one authoritative.
 *
 * Section 4 requires the re-check "immediately before the actual send", not a
 * cached copy of the admission verdict.  Passing admission and then failing
 * pre-dispatch is a refusal AND a signal that state moved underneath the
 * decision, which the caller should record.
 */
/** @param {any} admission @param {any} predispatch @returns {any} */
export function confirmBeforeDispatch(admission, predispatch) {
  return {
    allowed: admission.allowed === true && predispatch.allowed === true,
    admission,
    predispatch,
    driftDetected: admission.allowed === true && predispatch.allowed !== true,
    reason: predispatch.allowed ? admission.reason : predispatch.reason,
  };
}
