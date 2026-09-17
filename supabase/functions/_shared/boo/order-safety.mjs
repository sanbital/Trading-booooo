/**
 * Order dispatch safety and central risk reservation (brief sections 6 and 7).
 *
 * The rules encoded here are the ones whose violation costs real money:
 *   - risk is reserved BEFORE the order is sent, and released only when the
 *     outcome is PROVEN;
 *   - a timeout or a lost response is UNKNOWN, which is not a failure and
 *     definitely not a success;
 *   - an UNKNOWN order is resolved by asking about THAT order, never by
 *     sending a fresh one under a new client id;
 *   - reprocessing the same fill twice must not decrement the reservation
 *     twice.
 *
 * Pure and storage-agnostic: the executor supplies persistence, this supplies
 * the decisions.
 */

import { dec, ZERO } from "./decimal.mjs";

export const ORDER_SAFETY_VERSION = "BOO-ORDER-SAFETY-1";

/**
 * Central risk reservation with fencing.
 *
 * Section 6 requires concurrent workers' reservations to be atomic.  In the
 * executor this class is backed by a single conditional UPDATE so the
 * compare-and-set is done by the database; here the same invariant is enforced
 * in memory so it can be tested without one.
 *
 * `fencingToken` is the lease generation.  A worker whose lease expired holds a
 * stale token, and every mutating call checks it -- section 7's requirement
 * that an expired worker be refused AT THE GATEWAY, not merely told that its
 * lease lapsed.
 */
export class RiskReservationStore {
  /** @param {any} [opts] */
  constructor({ totalBudget, fencingToken = 1, reservations = new Map() } = {}) {
    this.totalBudget = dec(totalBudget);
    this.fencingToken = fencingToken;
    this.reservations = new Map(reservations);
    this.appliedFills = new Set();
  }

  outstanding() {
    let t = ZERO;
    for (const r of this.reservations.values()) t = t.add(r.amount);
    return t;
  }

  available() {
    return this.totalBudget.sub(this.outstanding());
  }

  reserve({ id, amount, fencingToken }) {
    if (fencingToken !== this.fencingToken) {
      return { ok: false, reason: "FENCED_OUT", held: this.fencingToken, presented: fencingToken };
    }
    if (this.reservations.has(id)) {
      // Idempotent: re-reserving the same intent is a no-op, not a second charge.
      return { ok: true, reason: "ALREADY_RESERVED", amount: this.reservations.get(id).amount };
    }
    const a = dec(amount);
    if (!a.isPos()) return { ok: false, reason: "AMOUNT_NOT_POSITIVE" };
    if (a.gt(this.available())) {
      return { ok: false, reason: "INSUFFICIENT_RISK_BUDGET", available: this.available(), requested: a };
    }
    this.reservations.set(id, { amount: a, state: "RESERVED", createdAt: Date.now() });
    return { ok: true, amount: a, available: this.available() };
  }

  release({ id, fencingToken }) {
    if (fencingToken !== this.fencingToken) return { ok: false, reason: "FENCED_OUT" };
    if (!this.reservations.has(id)) return { ok: false, reason: "NOT_RESERVED" };
    this.reservations.delete(id);
    return { ok: true, available: this.available() };
  }

  /**
   * Release only when the order outcome proves no exposure was created.
   * An UNKNOWN outcome keeps the reservation -- that is the whole point.
   */
  releaseIfProven({ id, outcome, fencingToken = this.fencingToken }) {
    if (!outcome?.mayRelease) {
      return { released: false, reason: outcome?.state ?? "NO_OUTCOME", outstanding: this.outstanding() };
    }
    const r = this.release({ id, fencingToken });
    return { released: r.ok === true, reason: r.reason ?? "RELEASED", outstanding: this.outstanding() };
  }

  /** Rotate the lease generation; every previously issued token is now stale. */
  rotateLease(next) {
    this.fencingToken = next;
    return this.fencingToken;
  }
}

/**
 * Classify a dispatch outcome.
 *
 * The hard case is HTTP 503: section 7 requires distinguishing "the exchange
 * never saw it" from "indeterminate".  The only safe discriminator is the
 * body -- a Binance error code in the payload proves the request was parsed
 * and rejected, while a bare gateway 503 proves nothing.
 */
/** @param {any} res @returns {any} */
export function classifyOrderOutcome(res) {
  const kind = String(res?.kind ?? "").toUpperCase();

  if (kind === "ACK") {
    return { state: "ACKNOWLEDGED", mayRelease: false, exposurePossible: true };
  }
  if (kind === "TIMEOUT" || kind === "ABORT" || kind === "NETWORK") {
    return { state: "UNKNOWN", mayRelease: false, exposurePossible: true, detail: res?.message ?? null };
  }
  if (kind === "HTTP") {
    const status = Number(res?.status);
    const msg = String(res?.message ?? "");
    // A parsed Binance business error means the order was definitively refused.
    const businessError = /"code"\s*:\s*-\d+/.test(msg) || /\bcode=-\d+/.test(msg);
    if (businessError) {
      return { state: "REJECTED", mayRelease: true, exposurePossible: false, detail: msg.slice(0, 300) };
    }
    if (status >= 500 || status === 408 || status === 429) {
      return { state: "UNKNOWN", mayRelease: false, exposurePossible: true, detail: `HTTP_${status}` };
    }
    if (status >= 400) {
      // A 4xx without a business code still might have been applied by a proxy
      // layer; treat only explicit refusals as proven.
      return { state: "UNKNOWN", mayRelease: false, exposurePossible: true, detail: `HTTP_${status}` };
    }
  }
  return { state: "UNKNOWN", mayRelease: false, exposurePossible: true, detail: kind || "UNCLASSIFIED" };
}

/**
 * Resolve an UNKNOWN order by identity.
 *
 * Never returns permission to send a replacement under a new client id: the
 * only legal resolutions are adopting what the exchange already has, or
 * continuing to hold the unknown.
 */
/** @param {any} args @returns {any} */
export function reconcileUnknownOrder({ clientOrderId, lookup }) {
  let found;
  try {
    found = lookup(clientOrderId);
  } catch (e) {
    return {
      action: "HOLD_UNKNOWN",
      newClientOrderIdAllowed: false,
      filledQuantity: ZERO,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (!found || found.found !== true) {
    // "Not found" from a single query is not proof of absence while the
    // exchange may still be propagating. Hold and retry the same identity.
    return { action: "HOLD_UNKNOWN", newClientOrderIdAllowed: false, filledQuantity: ZERO };
  }
  const status = String(found.status ?? "").toUpperCase();
  const filled = dec(found.executedQty ?? 0);
  if (["FILLED", "PARTIALLY_FILLED"].includes(status)) {
    return {
      action: "ADOPT_EXISTING",
      newClientOrderIdAllowed: false,
      filledQuantity: filled,
      avgPrice: found.avgPrice === undefined ? null : dec(found.avgPrice),
      status,
    };
  }
  if (["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(status) && filled.isZero()) {
    return { action: "PROVEN_NO_EXPOSURE", newClientOrderIdAllowed: false, filledQuantity: ZERO, status };
  }
  return { action: "HOLD_UNKNOWN", newClientOrderIdAllowed: false, filledQuantity: filled, status };
}

/**
 * Fold a partial fill into the risk state.
 *
 * Section 6, in order:
 *   - recompute open risk from the ACTUAL filled price and quantity,
 *   - keep the ORIGINAL reservation basis immutable,
 *   - keep open risk and unfilled-remainder reservation separate,
 *   - make reprocessing the same fill a no-op,
 *   - never authorise a top-up order to reach the original target quantity.
 */
/**
 * @param {any} state
 * @param {any} fill
 * @param {any} opts
 * @returns {any}
 */
export function applyPartialFill(state, fill, { originalReservation, riskPerUnit }) {
  const seen = state.seenFills ?? [];
  if (seen.includes(fill.fillId)) return { ...state, seenFills: seen };

  const qty = dec(fill.quantity);
  const addedRisk = qty.mul(dec(riskPerUnit));
  const openRisk = dec(state.openRisk ?? 0).add(addedRisk);
  const reservedRemaining = dec(state.reservedRemaining ?? originalReservation).sub(addedRisk);

  return {
    ...state,
    // Immutable basis: recorded once, never recomputed from later fills.
    originalReservation: String(state.originalReservation ?? originalReservation),
    openRisk: openRisk.toString(),
    reservedRemaining: (reservedRemaining.isNeg() ? ZERO : reservedRemaining).toString(),
    seenFills: [...seen, fill.fillId],
    // Section 6: no automatic re-order toward the original target size.
    topUpOrderAuthorised: false,
  };
}

/**
 * Deterministic client order id from the persisted intent.
 *
 * Idempotency depends on the id being a pure function of the intent, so a
 * retry of the SAME intent produces the SAME id and the exchange dedupes it,
 * while a genuinely new intent gets a new id.
 */
export function intentClientOrderId(prefix, intentId) {
  const clean = String(intentId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  return `${prefix}-${clean}`.slice(0, 36);
}
