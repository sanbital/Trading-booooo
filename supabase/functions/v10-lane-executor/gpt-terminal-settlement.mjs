/** GPT terminal settlement (R181, 2026-09-26).
 *
 * The FD1 entry review runs in the background: the cycle that asks GPT only ever sees
 * GPT_REVIEW_PENDING, and a later cycle re-reads the answer only while the 60 s trigger window
 * is still open. A valid SKIP/ABSTAIN (or a failed answer) that landed after its cycle was
 * therefore never written to the signal: the row stayed NEW with a final non-BUY on record and
 * the lifecycle sweep retired it as STALE:GPT_REVIEW_PENDING (JELLYJELLYUSDT 2026-09-26 09:06:09,
 * and every initial non-BUY in the week before). This module writes that answer onto the signal
 * the moment it is durable, and lets the sweep read it back if that write never happened.
 *
 * Label only. It never creates, claims, prices or orders anything, and every write is a
 * compare-and-set on status NEW: a signal a cycle has already claimed, or any terminal row, is
 * never touched. A BUY answer is never settled here; admission stays with the coordinator's
 * identity-bound ticket in the entry loop. */
import {storedTerminalReason,gptDecisionSource,expiredTriggerReason,agedOutReason} from './entry-lifecycle.mjs';

export const GPT_TERMINAL_SETTLEMENT_VERSION = "GPT_TERMINAL_SETTLEMENT_1";

/** Retire one NEW signal with the terminal reason of its durable initial review record. */
export async function settleGptTerminal(db, record, { audit = null, now = Date.now } = {}) {
  const signalId = record?.identity?.signal_id;
  const reason = storedTerminalReason(record, { signalId });
  if (!reason) return { settled: false, reason: null };
  const w = await db.from("v11_long_regime_signals")
    .update({ status: "REJECTED", reject_reason: reason, updated_at: new Date(now()).toISOString() })
    .eq("id", signalId).eq("status", "NEW").select("id,symbol");
  if (w.error) throw Error(`GPT_TERMINAL_SETTLE_WRITE:${String(w.error.message).slice(0, 160)}`);
  const row = (w.data ?? [])[0] ?? null;
  if (!row) return { settled: false, reason, cas: "NOT_NEW" };
  if (audit) {
    await Promise.resolve(audit(reason, {
      signalId, symbol: row.symbol ?? record.identity?.symbol ?? null, stage: "GPT_FINAL_ENTRY_SETTLED",
      finalAdmission: false, orderDispatched: false,
      gpt: { decision: record.result?.answer?.decision ?? record.result?.decision ?? null,
        source: gptDecisionSource(record.result), error: record.result?.error ?? null,
        requestId: record.result?.request_id ?? null, completedAtMs: record.result?.completed_at_ms ?? null },
      settlement: GPT_TERMINAL_SETTLEMENT_VERSION,
    })).catch(() => console.error("GPT_TERMINAL_SETTLE_AUDIT_FAILED", signalId));
  }
  return { settled: true, reason };
}

/** The durable initial-entry review of one signal, as the lifecycle sweep needs it:
 * {reason} when it is a final non-BUY for exactly this trigger, {decision:'BUY'} for a BUY, else null. */
export async function readStoredGptOutcome(db, signalId, triggerAtMs = null) {
  const r = await db.from("gpt_final_entry_reviews").select("state,record,created_at")
    .eq("signal_id", String(signalId)).eq("purpose", "PRODUCTION").eq("state", "DONE")
    .order("created_at", { ascending: true }).limit(8);
  if (r.error) throw Error(`GPT_STORED_OUTCOME_READ:${String(r.error.message).slice(0, 160)}`);
  const initial = (r.data ?? []).find((x) => x?.record && (x.record.kind === undefined || x.record.kind === null) &&
    (x.record.packet?.task ?? "ENTRY") === "ENTRY");
  if (!initial) return null;
  const reason = storedTerminalReason(initial.record, { signalId, triggerAtMs });
  if (reason) return { reason };
  const z = initial.record.result;
  const bound = String(initial.record.identity?.signal_id ?? "") === String(signalId) &&
    (triggerAtMs === null || Number(initial.record.identity?.trigger_at_ms) === Number(triggerAtMs));
  return bound && gptDecisionSource(z) === "GPT_VALID" && (z?.answer?.decision ?? z?.decision) === "BUY"
    ? { decision: "BUY" } : null;
}

/** The reason the lifecycle sweep writes for a NEW candidate that can no longer enter.
 * A TRIGGERED candidate was put to GPT: its durable answer decides the label when it is a final
 * non-BUY, and a BUY that was never executed is named as one. Only when no answer exists (or it
 * cannot be read) does the last in-cycle note decide, exactly as before. */
export async function lifecycleTerminalReason(db, row, { windowClosed }) {
  const note = row?.note && typeof row.note === "object" ? row.note : null;
  let stored = null;
  if (row?.setup_state === "TRIGGERED") {
    const triggerAt = Number(row.trigger_at);
    try { stored = await readStoredGptOutcome(db, row.id, Number.isSafeInteger(triggerAt) ? triggerAt : null); }
    catch (error) { console.error("LIFECYCLE_GPT_OUTCOME_UNREADABLE", row.id, String(error?.message ?? error).slice(0, 160)); }
  }
  if (stored?.reason) return String(stored.reason).slice(0, 500);
  const n = stored?.decision === "BUY" ? { ...(note ?? {}), gptDecision: "BUY" } : note;
  return (windowClosed ? expiredTriggerReason(n) : agedOutReason(row?.setup_state ?? null, n)).slice(0, 500);
}
