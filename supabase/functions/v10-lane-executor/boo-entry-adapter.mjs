/**
 * Binds the common entry gate (brief section 4) into v10-lane-executor's real
 * entry path.
 *
 * WHAT THIS CHANGES OPERATIONALLY -- read before deploying:
 *
 * The executor currently admits entries through `decideEntry`, which is an
 * OPERATIONAL gate (exposure known? accounting settled? operator switches on?).
 * It has no concept of "is this strategy validated" or "does this quantity fit
 * a loss budget", so today an entry is sized by `sizeEntry()` at a fixed
 * 40 USDT margin / 120 USDT notional regardless of where the stop sits, and it
 * is admitted with no validated edge behind it.
 *
 * This adapter adds the second gate in front of the order, at BOTH points the
 * brief requires: admission, and again immediately before dispatch.
 *
 * Because no validation approval exists for any currently running policy, the
 * gate in ENFORCE mode REFUSES ALL NEW ENTRIES.  That is the intended
 * behaviour for an unvalidated policy (section 4: "미승인 정책은 SHADOW 또는
 * SKIP"), not a bug -- but it means deploying this build stops new entries
 * until an operator inserts an approval row.  Deploy it deliberately.
 *
 * What it deliberately does NOT touch:
 *   - exits, protection, reconciliation and settlement, which must keep running
 *     whatever the entry verdict is (section 6, section 11);
 *   - positions that are already open, which stay on the policy version that
 *     was fixed at their entry (section 7).
 */

import { confirmBeforeDispatch, evaluateEntryGate } from "../_shared/boo/entry-gate.mjs";
import { evaluateLossLimits, resolveRiskPolicy } from "../_shared/boo/risk-policy.mjs";
import { solveQuantity } from "../_shared/boo/risk-budget.mjs";
import { dec, ZERO } from "../_shared/boo/decimal.mjs";

export const BOO_ADAPTER_VERSION = "BOO-EXECUTOR-ADAPTER-1";

export const ENFORCEMENT = Object.freeze({
  /** Gate decides. A refusal blocks the entry. Default, and fail-closed. */
  ENFORCE: "ENFORCE",
  /** Gate evaluates and records, but does not block. For measuring impact. */
  OBSERVE: "OBSERVE",
});

/**
 * Read the gate's control row and the approval that matches the running policy.
 *
 * A failed read is NOT a pass: it returns enforcement=ENFORCE with no approval,
 * which the gate then refuses on.  Section 4 requires a settings read failure to
 * refuse new entries.
 */
export async function loadBooGateContext(db, runningIdentity) {
  const ctx = {
    enforcement: ENFORCEMENT.ENFORCE,
    approval: null,
    controlReadOk: false,
    approvalReadOk: false,
    errors: [],
  };

  const control = await db.from("boo_entry_gate_control").select("*").eq("singleton", true).maybeSingle();
  if (control.error) {
    ctx.errors.push(`CONTROL_READ:${control.error.message}`);
  } else {
    ctx.controlReadOk = true;
    const mode = String(control.data?.enforcement ?? ENFORCEMENT.ENFORCE).toUpperCase();
    ctx.enforcement = mode === ENFORCEMENT.OBSERVE ? ENFORCEMENT.OBSERVE : ENFORCEMENT.ENFORCE;
  }

  // The approval must match the RUNNING policy identity exactly. Selecting by
  // those hashes means an approval for a different build simply is not found,
  // rather than being found and then compared loosely.
  const approval = await db.from("boo_strategy_approvals").select("*")
    .eq("policy_code_hash", runningIdentity.policyCodeHash)
    .eq("parameter_hash", runningIdentity.parameterHash)
    .eq("dataset_hash", runningIdentity.datasetHash)
    .eq("cost_model_version", runningIdentity.costModelVersion)
    .eq("execution_model_version", runningIdentity.executionModelVersion)
    .eq("revoked", false)
    .order("approved_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (approval.error) {
    ctx.errors.push(`APPROVAL_READ:${approval.error.message}`);
  } else {
    ctx.approvalReadOk = true;
    ctx.approval = approval.data
      ? {
        policyCodeHash: approval.data.policy_code_hash,
        parameterHash: approval.data.parameter_hash,
        datasetHash: approval.data.dataset_hash,
        costModelVersion: approval.data.cost_model_version,
        executionModelVersion: approval.data.execution_model_version,
        resultFileHash: approval.data.result_file_hash,
        approvedBy: approval.data.approved_by,
        evaluationWindow: { start: approval.data.evaluation_start, end: approval.data.evaluation_end },
        netExpectancyLowerBound: approval.data.net_expectancy_lower_bound,
        expectedEdgeBpsSource: approval.data.expected_edge_source,
        validUntil: approval.data.valid_until,
      }
      : null;
  }
  return ctx;
}

/**
 * Evaluate the gate for one candidate entry.
 *
 * `input` carries what the executor already has in hand at that point; nothing
 * here performs I/O, so it can be called at both checkpoints without extra
 * round trips.
 */
export function evaluateBooEntry({
  phase,
  now = Date.now(),
  gateContext,
  runningIdentity,
  settings,
  runtime,
  operatorControl,
  signal,
  book,
  account,
  fees,
  lease,
  costEvidence,
}) {
  // Risk policy comes from the live settings row, and REFUSES rather than
  // coerces the values currently in production (risk_per_trade_pct = 100).
  const resolved = resolveRiskPolicy(settings);

  let limits = null;
  let sizing = null;
  if (resolved.ok) {
    limits = evaluateLossLimits({
      policy: resolved.policy,
      equity: account.equity,
      realizedToday: account.realizedToday,
      realizedThisWeek: account.realizedThisWeek,
      highWaterEquity: account.highWaterEquity,
      consecutiveLosses: account.consecutiveLosses,
    });
    const entryPriceCap = Number(signal.entryPriceCap);
    if (limits.allowed && !(entryPriceCap > 0 && Number.isFinite(entryPriceCap))) {
      sizing = { decision: "SKIP", reason: "ENTRY_PRICE_CAP_UNAVAILABLE" };
    } else if (limits.allowed && [fees.takerFeeRate,fees.stopFeeRate].every(
      rate => typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate < 1)) {
      sizing = solveQuantity({
        policy: resolved.policy,
        equity: account.equity,
        bookAsks: book.asks,
        bookBids: book.bids,
        structuralStop: signal.structuralStop,
        stopSlippageFrac: fees.stopSlippageFrac,
        takerFeeRate: fees.takerFeeRate,
        stopFeeRate: fees.stopFeeRate,
        expectedFundingCost: fees.expectedFundingCost,
        filters: signal.filters,
        reservedRisk: account.reservedRisk,
        openGrossNotional: account.openGrossNotional,
        availableMargin: account.availableMargin,
        leverage: account.leverage,
        entryPriceCap: signal.entryPriceCap,
        dailyRemaining: limits.dailyRemaining,
        weeklyRemaining: limits.weeklyRemaining,
      });
    } else if (limits.allowed) {
      sizing = { decision: "SKIP", reason: "ACCOUNT_FEE_UNAVAILABLE" };
    }
  }

  const verdict = evaluateEntryGate({
    phase,
    now,
    strategy: signal.strategy,
    approval: gateContext.approval,
    running: runningIdentity,
    data: book.health,
    cost: costEvidence,
    risk: {
      limits: limits ?? { allowed: false, blocks: resolved.errors.map((e) => ({ code: e.code })) },
      sizing: sizing ?? { decision: "SKIP", reason: resolved.ok ? "LIMITS_BLOCKED" : "RISK_POLICY_INVALID" },
    },
    execution: {
      leaseHeld: lease.held,
      leaseFencingToken: lease.fencingToken,
      gatewayReady: lease.gatewayReady,
      accountModeSupported: account.modeSupported,
      protectionSupported: account.protectionSupported,
    },
    authorization: {
      settingsReadOk: gateContext.controlReadOk && gateContext.approvalReadOk && !!settings,
      operatorEntryEnabled: operatorControl?.entry_enabled === true,
      liveEnabled: runtime?.live_enabled === true,
      circuitOpen: runtime?.circuit_open === true,
      pauseNewEntries: settings?.pause_new_entries === true,
      killSwitch: settings?.scalp_kill_switch === true || settings?.emergency_liquidation === true,
      mode: settings?.mode,
    },
  });

  return {
    version: BOO_ADAPTER_VERSION,
    enforcement: gateContext.enforcement,
    verdict,
    riskPolicy: resolved,
    limits,
    sizing,
    // In OBSERVE the executor proceeds on its legacy path, but the verdict is
    // still persisted so the operator can see exactly what ENFORCE would do.
    blocks: gateContext.enforcement === ENFORCEMENT.ENFORCE && !verdict.allowed,
  };
}

/** Both checkpoints, with the pre-dispatch verdict authoritative. */
export function finalizeBooEntry(admission, predispatch) {
  const combined = confirmBeforeDispatch(admission.verdict, predispatch.verdict);
  const enforcing = predispatch.enforcement === ENFORCEMENT.ENFORCE;
  return {
    ...combined,
    enforcement: predispatch.enforcement,
    blocks: enforcing && !combined.allowed,
    sizing: predispatch.sizing,
  };
}

/**
 * Persist the verdict.  Recording must never be able to block or crash the
 * entry path -- a dashboard write failing is not a trading decision (section 7
 * distinguishes dashboard logging failures from mandatory order records).
 */
export async function recordBooVerdict(db, { signalId, symbol, phase, result }) {
  try {
    await db.from("boo_entry_gate_decisions").insert({
      adapter_version: BOO_ADAPTER_VERSION,
      gate_version: result.verdict.version,
      signal_id: signalId ?? null,
      symbol,
      phase,
      enforcement: result.enforcement,
      allowed: result.verdict.allowed,
      blocked_by: result.verdict.reason,
      conditions: result.verdict.conditions,
      sizing: result.sizing
        ? {
          decision: result.sizing.decision,
          reason: result.sizing.reason,
          quantity: result.sizing.plan?.quantity?.toString() ?? null,
          plannedLoss: result.sizing.plan?.plannedLoss?.toString() ?? null,
          notional: result.sizing.plan?.notional?.toString() ?? null,
          entryVwap: result.sizing.plan?.entryVwap?.toString() ?? null,
        }
        : null,
      risk_policy_errors: result.riskPolicy?.errors ?? [],
    });
  } catch {
    // Intentionally swallowed: see the doc comment above.
  }
}

/**
 * Reserve the planned loss BEFORE the order is sent, atomically.
 *
 * The compare-and-set lives in `boo_reserve_risk()` rather than here on purpose:
 * doing read-then-write from the application is exactly how two concurrent
 * executor invocations both observe the same "available" figure and both
 * proceed. Section 6 requires the reservation and the approval to be atomic, so
 * the database performs both under one row lock.
 *
 * `intentId` must be a pure function of the entry intent, so a retry of the same
 * intent reserves once (ALREADY_RESERVED) instead of twice.
 */
export async function reserveEntryRisk(db, { intentId, symbol, amount, fencingToken, totalBudget, clientOrderId }) {
  const r = await db.rpc("boo_reserve_risk", {
    p_intent_id: intentId,
    p_symbol: symbol,
    p_amount: String(amount),
    p_fencing_token: Number(fencingToken),
    p_total_budget: String(totalBudget),
    p_client_order_id: clientOrderId ?? null,
  });
  // A failed RPC is NOT an unreserved budget we may spend: it is an unknown
  // reservation state, which must block the entry.
  if (r.error) return { ok: false, reason: `RESERVE_RPC_FAILED:${r.error.message}` };
  return r.data ?? { ok: false, reason: "RESERVE_NO_RESULT" };
}

/**
 * Release a reservation only when the outcome is PROVEN.
 *
 * `proven` must come from classifyOrderOutcome().mayRelease. An UNKNOWN outcome
 * moves the row to UNKNOWN and keeps the budget held, which is what stops a lost
 * response from silently freeing risk that may actually be live on the exchange.
 */
export async function releaseEntryRisk(db, { intentId, fencingToken, resolution, proven }) {
  const r = await db.rpc("boo_release_risk", {
    p_intent_id: intentId,
    p_fencing_token: Number(fencingToken),
    p_resolution: String(resolution ?? "UNSPECIFIED"),
    p_proven: proven === true,
  });
  if (r.error) return { ok: false, reason: `RELEASE_RPC_FAILED:${r.error.message}` };
  return r.data ?? { ok: false, reason: "RELEASE_NO_RESULT" };
}

/**
 * Summarise total open risk currently reserved, for the sizing context.
 * Open positions contribute the loss still possible down to their live stop;
 * pending/UNKNOWN orders contribute their full original reservation.
 */
export function openRiskSummary({ positions = [], pendingOrders = [] }) {
  let openRisk = ZERO;
  let grossNotional = ZERO;
  for (const p of positions) {
    const qty = dec(p.remaining_quantity ?? p.quantity ?? 0);
    const entry = dec(p.entry_price ?? 0);
    const stop = dec(p.hard_stop_price ?? 0);
    if (qty.isPos() && entry.isPos()) grossNotional = grossNotional.add(qty.mul(entry));
    if (qty.isPos() && entry.gt(stop) && stop.isPos()) openRisk = openRisk.add(qty.mul(entry.sub(stop)));
  }
  for (const o of pendingOrders) {
    const reserved = o.request_payload?.booRiskReservation;
    if (reserved) openRisk = openRisk.add(dec(reserved));
  }
  return { openRisk, grossNotional };
}
