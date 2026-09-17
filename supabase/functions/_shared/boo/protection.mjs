/**
 * Position protection decisions (brief section 7).
 *
 * The three failure modes this exists to prevent, all of which have real
 * precedent in this repository's incident history:
 *   1. protecting the REQUESTED quantity after a PARTIAL fill, which leaves
 *      part of the position naked or over-reduces;
 *   2. cancelling the existing stop before the replacement is accepted, which
 *      opens a protection gap that a gateway hiccup turns into an unprotected
 *      position;
 *   3. a native stop and a locally dispatched exit both filling, which on a
 *      one-way account nets to an OPPOSITE position rather than flat.
 *
 * Pure decisions; the caller performs the I/O.
 */

import { dec, ZERO } from "./decimal.mjs";

export const PROTECTION_VERSION = "BOO-PROTECTION-1";

/**
 * Protective stop for an actual fill.
 *
 * `reduceOnly` rather than `closePosition`: closePosition ignores quantity and
 * closes whatever is there, which is wrong while a second entry fill may still
 * be arriving for the same symbol.  reduceOnly with an explicit quantity can
 * only ever reduce, and it reduces exactly what we know we own.
 */
/** @param {any} args @returns {any} */
export function protectionPlan({ filledQuantity, requestedQuantity, stopPrice, side, workingType = "CONTRACT_PRICE" }) {
  const filled = dec(filledQuantity);
  if (!filled.isPos()) {
    return {
      required: false,
      reason: "NO_FILL_NO_POSITION",
      quantity: ZERO,
      version: PROTECTION_VERSION,
    };
  }
  const stop = dec(stopPrice);
  if (!stop.isPos()) {
    return { required: true, ok: false, reason: "STOP_PRICE_INVALID", quantity: filled, version: PROTECTION_VERSION };
  }
  return {
    required: true,
    ok: true,
    // Protect what actually filled, never what was asked for.
    quantity: filled,
    requestedQuantity: dec(requestedQuantity),
    partial: filled.lt(dec(requestedQuantity)),
    side: side === "LONG" ? "SELL" : "BUY",
    positionSide: side,
    stopPrice: stop,
    reduceOnly: true,
    closePosition: false,
    // Section 7: CONTRACT_PRICE is the starting basis, and the replay must use
    // the same trigger basis as the live order or the two disagree on when the
    // stop fires.
    workingType,
    version: PROTECTION_VERSION,
  };
}

/**
 * Replace a protective stop safely.
 *
 * Order is mandatory: place the new one, CONFIRM acceptance and active state,
 * and only then cancel the old one.  Any other order leaves a window with no
 * exchange-resident protection.
 *
 * An indeterminate placement (throw/timeout) must NOT be retried blindly --
 * the previous attempt may have landed, and a second attempt would leave two
 * stops that can both fill.  The caller is told to verify first.
 */
/** @param {any} args @returns {any} */
export function replaceProtection({ existing, placeNew }) {
  let result;
  try {
    result = placeNew();
  } catch (e) {
    return {
      version: PROTECTION_VERSION,
      action: "VERIFY_BEFORE_RETRY",
      cancelledOld: false,
      mayPlaceAnother: false,
      stillProtectedBy: existing?.live ? existing.clientAlgoId : null,
      blockNewEntries: true,
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  if (result?.accepted !== true || result?.active !== true) {
    // The new stop is not live: keep the old one, and stop taking new risk
    // until protection is known-good again.
    return {
      version: PROTECTION_VERSION,
      action: "KEEP_EXISTING",
      cancelledOld: false,
      mayPlaceAnother: false,
      stillProtectedBy: existing?.live ? existing.clientAlgoId : null,
      blockNewEntries: true,
      detail: result?.reason ?? "NOT_ACCEPTED",
    };
  }

  return {
    version: PROTECTION_VERSION,
    action: "REPLACED",
    cancelledOld: true,
    newClientAlgoId: result.clientAlgoId,
    protectionGap: false,
    blockNewEntries: false,
  };
}

/**
 * Reconcile a native stop against a locally dispatched exit.
 *
 * The local exit must be clamped to the exposure that STILL EXISTS at the
 * exchange.  If the native stop already flattened the position, the local exit
 * is aborted outright; if it partially filled, only the remainder is sent.
 * Sending the originally planned quantity in either case opens a short.
 */
/** @param {any} args @returns {any} */
export function resolveExitRace({ exchangeQuantity, nativeStopFilled, localExitRequestedQuantity }) {
  const onExchange = dec(exchangeQuantity);
  const requested = dec(localExitRequestedQuantity);

  if (!onExchange.isPos()) {
    return {
      version: PROTECTION_VERSION,
      action: "ABORT_LOCAL_EXIT",
      sendQuantity: ZERO,
      reason: nativeStopFilled ? "NATIVE_STOP_ALREADY_FLAT" : "NO_EXPOSURE",
    };
  }
  if (onExchange.lt(requested)) {
    return {
      version: PROTECTION_VERSION,
      action: "REDUCE_LOCAL_EXIT",
      sendQuantity: onExchange,
      reason: nativeStopFilled ? "NATIVE_STOP_PARTIALLY_FILLED" : "EXPOSURE_SMALLER_THAN_PLAN",
    };
  }
  return {
    version: PROTECTION_VERSION,
    action: "SEND_AS_PLANNED",
    sendQuantity: requested,
    reason: "EXPOSURE_MATCHES_PLAN",
  };
}

/**
 * Measure how long a position was without exchange-resident protection.
 * Section 7 requires this to be MEASURED, not assumed to be zero.
 */
/** @param {any} args @returns {any} */
export function unprotectedInterval({ firstFillAt, protectionActiveAt }) {
  if (!Number.isFinite(Number(firstFillAt))) return { known: false, reason: "NO_FILL_TIME" };
  if (!Number.isFinite(Number(protectionActiveAt))) {
    return { known: false, reason: "PROTECTION_NEVER_CONFIRMED", stillUnprotected: true };
  }
  return { known: true, ms: Number(protectionActiveAt) - Number(firstFillAt) };
}
